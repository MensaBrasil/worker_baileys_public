import "dotenv/config";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  type WASocket,
} from "baileys";
import qrcode from "qrcode-terminal";
import Pino from "pino";

import { BoomError } from "./types/errorTypes";
import { processAddQueue } from "./core/addTask";
import type { Worker } from "./types/addTaskTypes";
import { getAllWhatsAppWorkers } from "./db/pgsql";

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
        // processes 1 item per iteration; addTask itself already has internal backoff
        await processAddQueue(sock, worker);
      } catch (err) {
        console.error("[addLoop] error processing queue:", err);
      }
      // small interval between queue polls
      await delay(1000);
    }
  })().catch((e) => console.error("[addLoop] fatal:", e));

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
    logger: Pino({ level: "info" }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  // keep reference to cancel the loop on reconnection/closure
  let stopAddLoop: (() => void) | null = null;

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log("Scan the QR code in WhatsApp > Connected devices");
    }

    if (connection === "open") {
      console.log("[wa] connection opened.");

      // Get worker phone from current Baileys instance
      const workerPhone = sock.user?.id?.replace(/\D/g, "");
      if (!workerPhone) throw new Error("Unable to determine worker phone from Baileys instance.");

      // Get worker id from database
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
      console.log("[wa] connection closed.");
      if (stopAddLoop) {
        stopAddLoop();
        stopAddLoop = null;
      }

      const code = (lastDisconnect?.error as BoomError)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => void main(), 3000);
      } else {
        console.error("Session logged out. Delete ./auth and link again.");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
