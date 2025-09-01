import type { WASocket, BaileysEventMap } from "baileys";
import logger from "../utils/logger";
import { updateWhatsappAuthorizations, getAllWhatsAppWorkers, getWhatsappAuthorization } from "../db/pgsql";

function normalizeDigits(input: string): string {
  return String(input || "").replace(/\D/g, "");
}

function jidToPhone(remoteJid: string | undefined): string | null {
  if (!remoteJid) return null;
  // Expect something like "5511999998888@s.whatsapp.net"
  const idx = remoteJid.indexOf("@");
  if (idx === -1) return null;
  const local = remoteJid.slice(0, idx);
  const digits = normalizeDigits(local);
  return digits.length ? digits : null;
}

/**
 * Updates WhatsApp authorization for a single phone number.
 * Ensures the worker exists in the database and upserts the authorization.
 */
export async function checkAuth(
  phoneNumber: string,
  workerPhone: string,
): Promise<{ success: boolean; already?: boolean }> {
  try {
    if (!workerPhone || typeof workerPhone !== "string") {
      throw new Error("workerPhone is required and must be a string");
    }
    if (!phoneNumber || typeof phoneNumber !== "string") {
      throw new Error("phoneNumber is required and must be a string");
    }

    const safeWorkerPhone = normalizeDigits(workerPhone);
    const safePhone = normalizeDigits(phoneNumber);

    const allWorkers = await getAllWhatsAppWorkers();
    const worker = allWorkers.find((w) => normalizeDigits(w.worker_phone) === safeWorkerPhone);
    if (!worker) {
      throw new Error(`Worker not found for phone number: ${workerPhone}`);
    }

    // Check if already authorized using the last 8 digits
    const last8 = safePhone.slice(-8);
    const existing = await getWhatsappAuthorization(last8, worker.id);
    if (existing) {
      logger.info(`Numero ${safePhone} já autorizado`);
      return { success: true, already: true };
    }

    await updateWhatsappAuthorizations([
      {
        phone_number: safePhone,
        worker_id: worker.id,
      },
    ]);

    logger.info(`Numero ${safePhone} autorizado com sucesso`);
    return { success: true, already: false };
  } catch (error) {
    const msg = (error as Error)?.message ?? String(error);
    throw new Error(`checkAuth failed: ${msg}`);
  }
}

/**
 * Upsert authorizations for multiple phone numbers using Baileys' initial chat/contacts set.
 * - Collects numbers from non-group chats and contacts available after connect.
 * - Runs once at startup.
 */
export async function addNewAuthorizations(sock: WASocket, workerPhone: string): Promise<void> {
  try {
    if (!sock) throw new Error("sock (WASocket) is required");
    if (!workerPhone || typeof workerPhone !== "string") {
      throw new Error("workerPhone is required and must be a string");
    }

    const safeWorkerPhone = normalizeDigits(workerPhone);
    const allWorkers = await getAllWhatsAppWorkers();
    const worker = allWorkers.find((w) => normalizeDigits(w.worker_phone) === safeWorkerPhone);
    if (!worker) {
      throw new Error(`Worker not found for phone number: ${workerPhone}`);
    }

    // Try to capture initial chats/contacts via Baileys events with a short window.
    // If none arrive, we proceed with zero updates.
    const collectedPhones = new Set<string>();

    // Helper to record a phone from a JID
    const recordJid = (jid?: string | null) => {
      const p = jidToPhone(jid || undefined);
      if (p) collectedPhones.add(p);
    };

    // We create a promise that resolves after a short collection period.
    await new Promise<void>((resolve) => {
      const timers: NodeJS.Timeout[] = [];

      // Collect from initial messaging history set (includes chats & contacts)
      const onHistorySet: (arg: BaileysEventMap["messaging-history.set"]) => void = ({ chats, contacts }) => {
        for (const c of chats) {
          const jid = c.id;
          const isGroup = jid?.endsWith("@g.us");
          if (!isGroup) recordJid(jid);
        }
        for (const ct of contacts) recordJid(ct.id);
        // give a small buffer for possible subsequent upserts
        timers.push(setTimeout(cleanupAndResolve, 200));
      };

      // Collect from chat upserts (just in case)
      const onChatsUpsert: (arg: BaileysEventMap["chats.upsert"]) => void = (chats) => {
        for (const c of chats) {
          const jid = c.id;
          const isGroup = jid?.endsWith("@g.us");
          if (!isGroup) recordJid(jid);
        }
      };

      // Collect from contacts upsert as a fallback (non-groups)
      const onContactsUpsert: (arg: BaileysEventMap["contacts.upsert"]) => void = (contacts) => {
        for (const ct of contacts) recordJid(ct.id);
      };

      const cleanupAndResolve = () => {
        sock.ev.off("messaging-history.set", onHistorySet);
        sock.ev.off("chats.upsert", onChatsUpsert);
        sock.ev.off("contacts.upsert", onContactsUpsert);
        resolve();
      };

      sock.ev.on("messaging-history.set", onHistorySet);
      sock.ev.on("chats.upsert", onChatsUpsert);
      sock.ev.on("contacts.upsert", onContactsUpsert);

      // Safety timeout: don’t wait too long if nothing arrives
      timers.push(setTimeout(cleanupAndResolve, 1500));
    });

    const phone_numbers = Array.from(collectedPhones);
    if (!phone_numbers.length) {
      logger.info("[auth] No phone numbers found for initial authorization");
      return;
    }

    const updates = phone_numbers.map((number) => ({
      phone_number: normalizeDigits(number),
      worker_id: worker.id,
    }));

    if (!updates.length) {
      logger.info("[auth] No valid contacts found for authorization");
      return;
    }

    await updateWhatsappAuthorizations(updates);
    logger.info(`[auth] Successfully updated authorizations for ${updates.length} contacts.`);
  } catch (error) {
    logger.error({ err: error }, "[auth] Error updating authorizations");
  }
}
