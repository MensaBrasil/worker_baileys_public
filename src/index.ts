import { config as configDotenv } from "dotenv";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  isHostedPnUser,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isPnUser,
  jidDecode,
} from "baileys";
import qrcode from "qrcode-terminal";
import logger from "./utils/logger";

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

let mainLoopStarted = false;

const normalizeDigits = (input: string | null | undefined) => (input || "").replace(/\D/g, "");

const isGroupLikeJid = (jid: string | null | undefined): boolean =>
  !!jid &&
  (Boolean(isJidGroup(jid)) ||
    Boolean(isJidStatusBroadcast(jid)) ||
    Boolean(isJidBroadcast(jid)) ||
    Boolean(isJidNewsletter(jid)));

const isPhoneNumberJid = (jid: string | null | undefined): boolean =>
  !!jid && (Boolean(isPnUser(jid)) || Boolean(isHostedPnUser(jid)) || jid.endsWith("@c.us"));

const extractPhoneFromJid = (jid: string | null | undefined): string | null => {
  if (!isPhoneNumberJid(jid)) return null;
  const decoded = jidDecode(jid!);
  const user = decoded?.user ?? jid?.split("@")[0] ?? "";
  const digits = normalizeDigits(user);
  return digits.length ? digits : null;
};

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

  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu("Desktop"),
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
        let lastRuntimeLogMinutes = -5;
        let runtimeLoggedOnce = false;
        while (shouldRun) {
          try {
            if (addMode) {
              await processAddQueue(sock, worker);
              await delaySecs(7, 13, 3);
            }

            if (removeMode) {
              await processRemoveQueue(sock);
              await delaySecs(7, 13, 3);
            }

            if (uptimeUrl) {
              try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 30_000);
                await fetch(uptimeUrl, { signal: controller.signal });
                clearTimeout(timeoutId);
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
          }
        }
      })().catch((e) => logger.error({ err: e }, "[mainLoop] fatal"));

      // Event-driven moderation/auth flows
      if (moderationMode || authMode) {
        sock.ev.on("messages.upsert", async ({ messages }) => {
          for (const m of messages) {
            const remoteJid = m.key.remoteJid || "";

            if (remoteJid && remoteJid !== "status@broadcast" && !m.key.fromMe) {
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

            const shouldHandleAuth = authMode && !isGroupLikeJid(remoteJid) && isPhoneNumberJid(remoteJid);

            if (shouldHandleAuth) {
              const pickContactNumber = () => {
                const keyAny = m.key as Record<string, unknown>;
                const toStr = (val: unknown) => (typeof val === "string" ? val : null);

                const jidCandidates = [
                  remoteJid,
                  toStr(keyAny.senderJid),
                  toStr(keyAny.participant),
                  toStr(keyAny.participantAlt),
                  toStr(keyAny.remoteJidAlt),
                ];

                for (const jid of jidCandidates) {
                  const phone = extractPhoneFromJid(jid);
                  if (phone) return phone;
                }

                const pnCandidates = [
                  toStr(keyAny.senderPn),
                  toStr(keyAny.participantPn),
                  toStr(keyAny.participantAlt),
                  toStr(keyAny.remoteJidAlt),
                ];

                for (const candidate of pnCandidates) {
                  const digits = normalizeDigits(candidate);
                  if (digits) return digits;
                }

                return null;
              };

              const contactNumber = pickContactNumber();
              if (!contactNumber) continue;
              try {
                await checkAuth(contactNumber, worker.phone);
              } catch (e) {
                logger.warn(
                  { err: e, number: contactNumber },
                  "Falha ao autorizar número a partir de mensagem recebida",
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
        logger.fatal({ code }, "[wa] connection closed: Session logged out. Delete ./auth and link again.");
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
