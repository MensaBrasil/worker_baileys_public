import { config as configDotenv } from "dotenv";
import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  useMultiFileAuthState,
} from "baileys";
import qrcode from "qrcode-terminal";
import logger from "./utils/logger";
import { getAuthStateDir } from "./baileys/auth-state-dir";

import { BoomError } from "./types/errorTypes";
import { processAddQueue } from "./core/addTask";
import { processRemoveQueue } from "./core/removeTask";
import type { Worker } from "./types/addTaskTypes";
import { getAllWhatsAppWorkers } from "./db/pgsql";
import { testRedisConnection } from "./db/redis";
import { delaySecs } from "./utils/delay";
import { addNewAuthorizations, checkAuth } from "./core/authTask";
import { handleMessageModeration } from "./core/moderationTask";
import { registerFirstContactWelcome } from "./core/firstContactWelcome";

configDotenv({ path: ".env" });

function parseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env var ${name}: "${raw}"`);
  }
  return parsed;
}

let addMode = process.argv.includes("--add");
let removeMode = process.argv.includes("--remove");
let moderationMode = process.argv.includes("--moderation");
let authMode = process.argv.includes("--auth");
const pairingCodeMode = process.argv.includes("--pairing");

if (!addMode && !removeMode && !moderationMode && !authMode) {
  addMode = true;
  removeMode = true;
  moderationMode = true;
  authMode = true;
  logger.info("Normal mode (default). All modes active: add, remove, moderation, auth.");
} else {
  const activeModes: string[] = [];
  if (addMode) activeModes.push("add");
  if (removeMode) activeModes.push("remove");
  if (moderationMode) activeModes.push("moderation");
  if (authMode) activeModes.push("auth");
  if (pairingCodeMode) activeModes.push("pairing");

  logger.info(`Active modes: ${activeModes.join(", ")}`);
}

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled Rejection");
  process.exit(1);
});

const uptimeUrl = process.env.UPTIME_URL;
const uptimeIntervalSeconds = parseEnvNumber("UPTIME_INTERVAL_SECONDS", 60);
const idleLoopDelaySeconds = parseEnvNumber("IDLE_LOOP_DELAY_SECONDS", 30);
async function pingUptime(url: string): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

let mainLoopStarted = false;

const isGroupLikeJid = (jid: string | null | undefined): boolean =>
  !!jid &&
  (Boolean(isJidGroup(jid)) ||
    Boolean(isJidStatusBroadcast(jid)) ||
    Boolean(isJidBroadcast(jid)) ||
    Boolean(isJidNewsletter(jid)));

function logDisconnectDetails(err: unknown) {
  if (!err) return;
  const asAny = err as { message?: string; stack?: string; data?: unknown; output?: { payload?: unknown } };
  logger.warn(
    {
      message: asAny.message,
      data: asAny.data,
      payload: asAny.output?.payload,
      stack: asAny.stack,
    },
    "[wa] lastDisconnect details",
  );
}

async function main() {
  let shouldRun = true;
  let resolveRestart: (() => void) | null = null;
  const waitForRestart = new Promise<void>((resolve) => {
    resolveRestart = resolve;
  });

  const { state, saveCreds } = await useMultiFileAuthState(getAuthStateDir());
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS("Desktop"),
    logger: logger.child({ module: "baileys" }, { level: (process.env.BAILEYS_LOG_LEVEL ?? "fatal") as string }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  if (pairingCodeMode && !sock.authState.creds.registered) {
    const phoneNumber = (process.env.PAIRING_PHONE ?? "").replace(/\D/g, "");
    if (!phoneNumber) {
      throw new Error("Defina a env PAIRING_PHONE (ex: 5511999999999) para usar --pairing.");
    }

    try {
      await sock.waitForConnectionUpdate((u) => Promise.resolve(!!u.qr || u.connection === "open"));
      const code = await sock.requestPairingCode(phoneNumber);
      logger.warn(
        { code },
        "Pairing code gerado; entre em WhatsApp > Conectados > Adicionar dispositivo e insira o código.",
      );
    } catch (err) {
      logger.error({ err }, "Falha ao gerar pairing code");
      throw err;
    }
  }

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr && !pairingCodeMode) {
      qrcode.generate(qr, { small: true });
      logger.info("Scan the QR code in WhatsApp > Connected devices");
    }

    if (connection === "open") {
      logger.info("[wa] connection opened.");

      const workerPhone =
        (sock.user as { phoneNumber?: string } | undefined)?.phoneNumber?.replace(/\D/g, "") ||
        sock.user?.id?.split(":")[0]?.split("@")[0]?.replace(/\D/g, "");
      if (!workerPhone) throw new Error("Unable to determine worker phone from Baileys instance.");

      registerFirstContactWelcome(sock);

      const workers = await getAllWhatsAppWorkers();
      const found = workers.find((w) => w.worker_phone.replace(/\D/g, "") === workerPhone);
      if (!found) throw new Error(`Worker phone ${workerPhone} not found in database.`);

      const worker: Worker = {
        id: found.id,
        phone: found.worker_phone,
      };

      await testRedisConnection();

      // Initial authorization sweep (non-group chats/contacts)
      try {
        logger.info(`Running initial authorization check for worker: ${worker.phone}`);
        await addNewAuthorizations(sock, worker.phone);
      } catch (e) {
        logger.warn({ err: e }, "Initial authorization check failed (continuing)");
      }

      if (mainLoopStarted) {
        logger.warn("Main loop already started; skipping duplicate start.");
        return;
      }
      mainLoopStarted = true;

      (async function mainLoop() {
        const startTime = Date.now();
        let lastUptimePingAt = 0;
        let lastRuntimeLogMinutes = -5;
        let runtimeLoggedOnce = false;
        while (shouldRun) {
          let shouldApplyIdleDelay = !addMode && !removeMode;

          try {
            if (addMode) {
              await processAddQueue(sock, worker);
              await delaySecs(7, 13, 3);
            }
            if (removeMode) {
              await processRemoveQueue(sock);
              await delaySecs(7, 13, 3);
            }

            const now = Date.now();
            if (uptimeUrl && now - lastUptimePingAt >= uptimeIntervalSeconds * 1000) {
              try {
                await pingUptime(uptimeUrl);
                lastUptimePingAt = now;
              } catch (err) {
                logger.warn({ err }, "Uptime check failed");
              }
            }
            const currentTime = Date.now();
            const elapsed = currentTime - startTime;
            const minutes = Math.floor(elapsed / 60_000);
            if (!runtimeLoggedOnce || minutes - lastRuntimeLogMinutes >= 5) {
              logger.info(`Process has been running for ${minutes} minutes`);
              lastRuntimeLogMinutes = minutes;
              runtimeLoggedOnce = true;
            }
          } catch (err) {
            logger.error({ err }, "[mainLoop] error");
            shouldApplyIdleDelay = true;
          }

          if (shouldApplyIdleDelay) {
            await delaySecs(15, idleLoopDelaySeconds);
          }
        }
      })().catch((e) => logger.error({ err: e }, "[mainLoop] fatal"));

      // Event-driven moderation/auth flows
      if (moderationMode || authMode) {
        sock.ev.on("messages.upsert", async ({ messages }) => {
          for (const m of messages) {
            const keyAny = m.key as typeof m.key & {
              remoteJidAlt?: string | null;
              participantAlt?: string | null;
            };
            const remoteJid = keyAny.remoteJid || keyAny.remoteJidAlt || "";

            if (remoteJid && remoteJid !== "status@broadcast" && !m.key.fromMe) {
              logger.info(
                {
                  messageId: m.key.id,
                  remoteJid: keyAny.remoteJid,
                  remoteJidAlt: keyAny.remoteJidAlt,
                  participant: m.key.participant,
                  participantAlt: keyAny.participantAlt,
                },
                "[wa] Mensagem recebida",
              );

              const textContent =
                m.message?.conversation ||
                m.message?.extendedTextMessage?.text ||
                m.message?.imageMessage?.caption ||
                m.message?.videoMessage?.caption ||
                "";

              if (textContent.toLowerCase().includes("chocalho")) {
                try {
                  await sock.sendMessage(remoteJid, {
                    react: { text: "🪇", key: m.key },
                  });
                } catch (err) {
                  logger.warn({ err }, "Failed to send chocalho reaction");
                }
              }
            }

            if (moderationMode) {
              await handleMessageModeration(sock, m);
            }

            const shouldHandleAuth = authMode && !isGroupLikeJid(remoteJid);

            if (shouldHandleAuth) {
              try {
                await checkAuth(sock, m, worker.phone);
              } catch (e) {
                logger.warn(
                  { err: e, remoteJid },
                  "Falha ao autorizar/sincronizar contato a partir de mensagem recebida",
                );
              }
            }
          }
        });
      }
    }

    if (connection === "close") {
      const code = (lastDisconnect?.error as BoomError)?.output?.statusCode;
      const isLoggedOut = code === DisconnectReason.loggedOut;

      logDisconnectDetails(lastDisconnect?.error);

      if (isLoggedOut) {
        logger.fatal(
          { code },
          "[wa] connection closed: Session logged out. Delete the local auth folder and link again.",
        );
        process.exit(1);
      }

      logger.warn({ code }, "[wa] connection closed; scheduling restart...");
      mainLoopStarted = false;
      shouldRun = false;
      resolveRestart?.();
    }
  });

  sock.ev.on("creds.update", saveCreds);
  await waitForRestart;
}

async function startWorker() {
  while (true) {
    try {
      await main();
    } catch (error) {
      logger.error({ err: error }, "Unhandled error");
    }

    logger.info("Restarting socket in 5 seconds...");
    await new Promise((res) => setTimeout(res, 5000));
  }
}

startWorker().catch((error) => {
  logger.fatal({ err: error }, "Fatal error starting worker loop");
  process.exit(1);
});
