import { config as configDotenv } from "dotenv";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  type WASocket,
} from "baileys";
import qrcode from "qrcode-terminal";
import logger from "./utils/logger";

import { BoomError } from "./types/errorTypes";
import { processAddQueue } from "./core/addTask";
import type { Worker } from "./types/addTaskTypes";
import { getAllWhatsAppWorkers } from "./db/pgsql";

configDotenv({ path: ".env" });

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Starts a loop that consumes the add queue.
 * Returns a function to stop the loop (used during reconnections/closures).
 */
function startAddLoop(sock: WASocket, worker: Worker) {
  let stopped = false;

  (async function loop() {
    while (!stopped) {
      try {
        await processAddQueue(sock, worker);
      } catch (err) {
        logger.error({ err }, "[addLoop] error processing queue");
      }
      await delay(1000);
    }
  })().catch((e) => logger.error({ err: e }, "[addLoop] fatal"));

  return () => {
    stopped = true;
  };
}

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu("Desktop"),
    logger: logger.child({ module: "baileys" }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  let stopAddLoop: (() => void) | null = null;

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      qrcode.generate(qr, { small: true });
      logger.info("Scan the QR code in WhatsApp > Connected devices");
    }

    if (connection === "open") {
      logger.info("[wa] connection opened.");

      const workerPhone = sock.user?.id?.split(":")[0]?.replace(/\D/g, "");
      if (!workerPhone) throw new Error("Unable to determine worker phone from Baileys instance.");

      const workers = await getAllWhatsAppWorkers();
      const found = workers.find((w) => w.worker_phone.replace(/\D/g, "") === workerPhone);
      if (!found) throw new Error(`Worker phone ${workerPhone} not found in database.`);

      const worker: Worker = {
        id: found.id,
        phone: found.worker_phone,
      };

      if (stopAddLoop) stopAddLoop();

      stopAddLoop = startAddLoop(sock, worker);
    }

    if (connection === "close") {
      logger.info("[wa] connection closed.");
      if (stopAddLoop) {
        stopAddLoop();
        stopAddLoop = null;
      }

      const code = (lastDisconnect?.error as BoomError)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => void main(), 3000);
      } else {
        logger.error("Session logged out. Delete ./auth and link again.");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

main().catch((error) => {
  logger.error({ err: error }, "Unhandled error");
  process.exit(1);
});
