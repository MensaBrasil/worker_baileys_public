import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  makeWASocket,
  useMultiFileAuthState,
} from "baileys";
import { config as configDotenv } from "dotenv";
import qrcode from "qrcode-terminal";
import { getAuthStateDir } from "./baileys/auth-state-dir";
import { processAddQueue } from "./core/addTask";
import { addNewAuthorizations, checkAuth } from "./core/authTask";
import { handleConsentAutoReply } from "./core/consentAutoReply";
import { registerFirstContactWelcome } from "./core/firstContactWelcome";
import { handleMessageModeration } from "./core/moderationTask";
import { processRemoveQueue } from "./core/removeTask";
import { getAllWhatsAppWorkers } from "./db/pgsql";
import { testRedisConnection } from "./db/redis";
import type { Worker } from "./types/addTaskTypes";
import type { BoomError } from "./types/errorTypes";
import { delaySecs } from "./utils/delay";
import logger from "./utils/logger";

configDotenv({ path: ".env" });

function parseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Variável de ambiente numérica inválida ${name}: "${raw}"`);
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
  logger.info("Modo normal (padrão). Todos os modos ativos: adição, remoção, moderação e autorização.");
} else {
  const activeModes: string[] = [];
  if (addMode) activeModes.push("adição");
  if (removeMode) activeModes.push("remoção");
  if (moderationMode) activeModes.push("moderação");
  if (authMode) activeModes.push("autorização");
  if (pairingCodeMode) activeModes.push("pareamento");

  logger.info(`Modos ativos: ${activeModes.join(", ")}`);
}

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Promise rejeitada sem tratamento");
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
    "[wa] detalhes da última desconexão",
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
        "Código de pareamento gerado; entre em WhatsApp > Dispositivos conectados > Conectar um dispositivo e insira o código.",
      );
    } catch (err) {
      logger.error({ err }, "Falha ao gerar código de pareamento");
      throw err;
    }
  }

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr && !pairingCodeMode) {
      qrcode.generate(qr, { small: true });
      logger.info("Escaneie o QR code em WhatsApp > Dispositivos conectados");
    }

    if (connection === "open") {
      logger.info("[wa] conexão aberta.");

      const workerPhone =
        (sock.user as { phoneNumber?: string } | undefined)?.phoneNumber?.replace(/\D/g, "") ||
        sock.user?.id?.split(":")[0]?.split("@")[0]?.replace(/\D/g, "");
      if (!workerPhone) throw new Error("Não foi possível determinar o telefone do worker pela instância do Baileys.");

      registerFirstContactWelcome(sock);

      const workers = await getAllWhatsAppWorkers();
      const found = workers.find((w) => w.worker_phone.replace(/\D/g, "") === workerPhone);
      if (!found) throw new Error(`Telefone do worker ${workerPhone} não encontrado no banco.`);

      const worker: Worker = {
        id: found.id,
        phone: found.worker_phone,
      };

      await testRedisConnection();

      // Initial authorization sweep (non-group chats/contacts)
      try {
        logger.info(`Executando verificação inicial de autorização para o worker: ${worker.phone}`);
        await addNewAuthorizations(sock, worker.phone);
      } catch (e) {
        logger.warn({ err: e }, "Falha na verificação inicial de autorização; continuando");
      }

      if (mainLoopStarted) {
        logger.warn("Loop principal já iniciado; ignorando início duplicado.");
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
                logger.warn({ err }, "Falha na verificação de uptime");
              }
            }
            const currentTime = Date.now();
            const elapsed = currentTime - startTime;
            const minutes = Math.floor(elapsed / 60_000);
            if (!runtimeLoggedOnce || minutes - lastRuntimeLogMinutes >= 5) {
              logger.info(`Processo em execução há ${minutes} minuto(s)`);
              lastRuntimeLogMinutes = minutes;
              runtimeLoggedOnce = true;
            }
          } catch (err) {
            logger.error({ err }, "[mainLoop] erro");
            shouldApplyIdleDelay = true;
          }

          if (shouldApplyIdleDelay) {
            await delaySecs(15, idleLoopDelaySeconds);
          }
        }
      })().catch((e) => logger.error({ err: e }, "[mainLoop] erro fatal"));

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
                  logger.warn({ err }, "Falha ao enviar reação de chocalho");
                }
              }

              try {
                await handleConsentAutoReply(sock, m);
              } catch (err) {
                logger.warn({ err, remoteJid }, "Falha ao enviar resposta automática de autorização de grupos");
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
          "[wa] conexão fechada: sessão desconectada. Apague a pasta local de autenticação e vincule novamente.",
        );
        process.exit(1);
      }

      logger.warn({ code }, "[wa] conexão fechada; agendando reinício...");
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
      logger.error({ err: error }, "Erro não tratado");
    }

    logger.info("Reiniciando socket em 5 segundos...");
    await new Promise((res) => setTimeout(res, 5000));
  }
}

startWorker().catch((error) => {
  logger.fatal({ err: error }, "Erro fatal ao iniciar loop do worker");
  process.exit(1);
});
