import { config as configDotenv } from "dotenv";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  type ConnectionState,
  type WAMessageKey,
} from "baileys";
import qrcode from "qrcode-terminal";
import logger from "./utils/logger";

import { BoomError } from "./types/errorTypes";
import { processAddQueue } from "./core/addTask";
import { processRemoveQueue } from "./core/removeTask";
import type { Worker } from "./types/addTaskTypes";
import { getAllWhatsAppWorkers, upsertLidMapping } from "./db/pgsql";
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

  logger.info(`Active modes: ${activeModes.join(", ")}`);
}

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled Rejection");
  process.exit(1);
});

const uptimeUrl = process.env.UPTIME_URL;

let mainLoopStarted = false;

async function main() {
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

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
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
        while (true) {
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
            logger.info(`Process has been running for ${Math.floor(elapsed / 60_000)} minutes`);
          } catch (err) {
            logger.error({ err }, "[mainLoop] error");
          }
        }
      })().catch((e) => logger.error({ err: e }, "[mainLoop] fatal"));

      // Event-driven moderation/auth flows
      if (moderationMode || authMode) {
        sock.ev.on("messages.upsert", async ({ messages }) => {
          const normalizeDigits = (input: string | null | undefined) => (input || "").replace(/\D/g, "") || null;

          const resolveIdentityFromKey = async (
            key: WAMessageKey,
          ): Promise<{ phone: string | null; lid: string | null }> => {
            const alt = key.remoteJidAlt ?? key.participantAlt ?? null;
            const fromAlt = normalizeDigits(alt);
            if (fromAlt) return { phone: fromAlt, lid: null };

            const jid = key.remoteJid ?? null;
            const direct = normalizeDigits(jid?.endsWith("@s.whatsapp.net") ? jid.split("@")[0] : jid);
            if (direct) return { phone: direct, lid: null };

            const lidJid =
              (jid && jid.endsWith("@lid")) || (key.participant && key.participant.endsWith("@lid"))
                ? jid && jid.endsWith("@lid")
                  ? jid
                  : (key.participant ?? null)
                : null;

            let phoneFromLid: string | null = null;
            if (lidJid && sock.signalRepository?.lidMapping) {
              try {
                const pn = await sock.signalRepository.lidMapping.getPNForLID(lidJid);
                phoneFromLid = normalizeDigits(pn);
              } catch (err) {
                logger.debug({ err, lid: lidJid }, "Failed to resolve LID via signalRepository");
              }
            }

            const lidDigits = normalizeDigits(lidJid?.split("@")[0] ?? null);
            return { phone: phoneFromLid, lid: lidDigits };
          };

          for (const m of messages) {
            const remoteJid = m.key.remoteJid || "";
            const remoteAlt = m.key.remoteJidAlt || "";
            const chatJid = remoteJid || remoteAlt;

            if (chatJid && chatJid !== "status@broadcast" && !m.key.fromMe) {
              const textContent =
                m.message?.conversation ||
                m.message?.extendedTextMessage?.text ||
                m.message?.imageMessage?.caption ||
                m.message?.videoMessage?.caption ||
                "";

              if (textContent.toLowerCase().includes("chocalho")) {
                try {
                  await sock.sendMessage(remoteJid || remoteAlt, {
                    react: { text: "🪇", key: m.key },
                  });
                } catch (err) {
                  logger.warn({ err }, "Failed to send chocalho reaction");
                }
              }
            }

            const isGroup = chatJid.endsWith("@g.us") || chatJid.endsWith("@newsletter");

            if (moderationMode) {
              await handleMessageModeration(sock, m);
            }

            if (authMode && !isGroup) {
              const identity = await resolveIdentityFromKey(m.key);
              const contactNumber = identity.phone ?? identity.lid ?? "";
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

      if (isLoggedOut) {
        logger.fatal({ code }, "[wa] connection closed: Session logged out. Delete ./auth and link again.");
        process.exit(1);
      }

      logger.warn({ code }, "[wa] connection closed; attempting auto-reconnect...");

      // Wait for Baileys' internal retry to succeed within a timeout window.
      const waitForReconnect = (timeoutMs: number) =>
        new Promise<void>((resolve, reject) => {
          const onUpdate = (u: Partial<ConnectionState>) => {
            const c = u.connection;
            const sc = (u.lastDisconnect?.error as BoomError | undefined)?.output?.statusCode;
            if (c === "open") {
              cleanup();
              resolve();
            } else if (sc === DisconnectReason.loggedOut) {
              cleanup();
              reject(new Error("logged_out"));
            }
          };

          const cleanup = () => {
            clearTimeout(timer);
            sock.ev.off("connection.update", onUpdate);
          };

          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("reconnect_timeout"));
          }, timeoutMs);

          sock.ev.on("connection.update", onUpdate);
        });

      try {
        await waitForReconnect(60_000);
        logger.info("[wa] reconnect successful.");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const reason = msg === "logged_out" ? "Session logged out during retry" : "Reconnect timeout";
        logger.fatal({ code, reason }, "[wa] reconnect failed; exiting.");
        process.exit(1);
      }
    }
  });

  sock.ev.on("lid-mapping.update", async (updates) => {
    const list = Array.isArray(updates) ? updates : [updates];
    for (const item of list) {
      const lid = (item as { lid?: string; id?: string }).lid ?? (item as { id?: string }).id;
      const phone =
        (item as { pn?: string; phoneNumber?: string }).pn ?? (item as { phoneNumber?: string }).phoneNumber;
      if (lid && phone) {
        try {
          if (sock.signalRepository?.lidMapping) {
            await sock.signalRepository.lidMapping.storeLIDPNMappings([{ lid, pn: phone }]);
          }
        } catch (err) {
          logger.debug({ err, lid }, "Failed to store LID mapping in memory store");
        }
        try {
          await upsertLidMapping(lid, phone, "lid-mapping.update");
        } catch (err) {
          logger.warn({ err, lid }, "Failed to persist LID mapping to DB (whatsapp_lid_mappings)");
        }
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

main().catch((error) => {
  logger.error({ err: error }, "Unhandled error");
  process.exit(1);
});
