import {
  isHostedPnUser,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  type BaileysEventMap,
  type WAMessage,
  type WASocket,
} from "baileys";
import { getWhatsAppWorkerByPhone, resolveContactNameByPhone, upsertWhatsappAuthorizationByPhone } from "../db/pgsql";
import type { WhatsAppWorker } from "../types/pgsqlTypes";
import logger from "../utils/logger";

type SavedContact = {
  id: string;
  lid?: string | undefined;
  name?: string | undefined;
  phoneNumber?: string | undefined;
};

type MessageSenderContext = {
  altJid?: string | undefined;
  isDirectMessage: boolean;
  senderJid: string;
  targetJid: string;
};

type AuthCheckResult = {
  success: boolean;
  already?: boolean;
  skipped?: boolean;
  contactSynced?: boolean;
};

type ContactSyncState = {
  pendingContactIds: Set<string>;
  savedContactNames: Map<string, string>;
};

type ExtendedMessageKey = NonNullable<WAMessage["key"]> & {
  participantAlt?: string | null;
  remoteJidAlt?: string | null;
  senderJid?: string | null;
};

const INITIAL_COLLECTION_WINDOW_MS = 1_500;
const INITIAL_COLLECTION_SETTLE_MS = 200;

const contactSyncStates = new WeakMap<WASocket, ContactSyncState>();

function normalizeDigits(input: string | null | undefined): string {
  return String(input || "").replace(/\D/g, "");
}

function normalizeContactName(name: string | null | undefined): string {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeOptionalJid(jid?: string | null): string | undefined {
  if (!jid) return undefined;
  const normalizedJid = jidNormalizedUser(jid);
  return normalizedJid || undefined;
}

function isGroupLikeJid(jid?: string | null): boolean {
  return (
    !!jid &&
    (jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter"))
  );
}

function jidToPhone(remoteJid?: string | null): string | null {
  if (!remoteJid) return null;

  const normalizedJid = normalizeOptionalJid(remoteJid) ?? remoteJid;
  const isPhoneUser =
    isPnUser(normalizedJid) ||
    isHostedPnUser(normalizedJid) ||
    normalizedJid.endsWith("@c.us") ||
    normalizedJid.endsWith("@s.whatsapp.net");

  if (!isPhoneUser) return null;

  const decoded = jidDecode(normalizedJid);
  const local = decoded?.user ?? normalizedJid.split("@")[0] ?? "";
  const digits = normalizeDigits(local);
  return digits.length ? digits : null;
}

function getFirstName(fullName: string): string {
  const [firstName] = fullName.split(" ");
  return firstName || fullName;
}

function getMessageKey(message: WAMessage): ExtendedMessageKey {
  return message.key as ExtendedMessageKey;
}

function getMessageUniqueKey(message: WAMessage): string {
  const key = getMessageKey(message);
  return [key.remoteJid ?? "", key.participant ?? "", key.id ?? ""].join(":");
}

function registerSavedContact(savedContactNames: Map<string, string>, contact: SavedContact): void {
  const contactName = normalizeContactName(contact.name);
  if (!contactName) return;

  const cacheKeys = [contact.id, contact.lid, contact.phoneNumber]
    .map((jid) => normalizeOptionalJid(jid))
    .filter((jid): jid is string => Boolean(jid));

  for (const cacheKey of cacheKeys) {
    savedContactNames.set(cacheKey, contactName);
  }
}

function getContactSyncState(sock: WASocket): ContactSyncState {
  const existingState = contactSyncStates.get(sock);
  if (existingState) return existingState;

  const state: ContactSyncState = {
    pendingContactIds: new Set<string>(),
    savedContactNames: new Map<string, string>(),
  };

  sock.ev.on("contacts.upsert", (contacts) => {
    for (const contact of contacts) {
      registerSavedContact(state.savedContactNames, contact);
    }
  });

  sock.ev.on("contacts.update", (contacts) => {
    for (const contact of contacts) {
      if (!contact.id) continue;

      registerSavedContact(state.savedContactNames, {
        id: contact.id,
        lid: contact.lid,
        name: contact.name,
        phoneNumber: contact.phoneNumber,
      });
    }
  });

  contactSyncStates.set(sock, state);
  return state;
}

function getMessageSenderJid(message: WAMessage): string | null {
  const key = getMessageKey(message);
  if (key.fromMe) return null;

  const senderJid = key.participant ?? key.remoteJid ?? key.senderJid ?? null;
  const normalizedJid = normalizeOptionalJid(senderJid);
  if (!normalizedJid) return null;

  if (normalizedJid.endsWith("@lid")) {
    return normalizedJid;
  }

  return jidToPhone(normalizedJid) ? normalizedJid : null;
}

async function resolveMessageSenderTargetJid(sock: WASocket, message: WAMessage, senderJid: string): Promise<string> {
  const key = getMessageKey(message);
  const altJid = normalizeOptionalJid(key.participantAlt ?? key.remoteJidAlt);

  if (altJid && jidToPhone(altJid)) {
    return altJid;
  }

  if (!senderJid.endsWith("@lid")) {
    return senderJid;
  }

  const mappedPnJid = await sock.signalRepository.lidMapping.getPNForLID(senderJid);
  const normalizedPnJid = normalizeOptionalJid(mappedPnJid);

  if (normalizedPnJid && jidToPhone(normalizedPnJid)) {
    return normalizedPnJid;
  }

  return senderJid;
}

async function resolveMessageSenderContext(sock: WASocket, message: WAMessage): Promise<MessageSenderContext | null> {
  const senderJid = getMessageSenderJid(message);
  if (!senderJid) return null;

  const key = getMessageKey(message);
  const remoteJid = normalizeOptionalJid(key.remoteJid);
  const altJid = normalizeOptionalJid(key.participantAlt ?? key.remoteJidAlt);
  const targetJid = await resolveMessageSenderTargetJid(sock, message, senderJid);

  return {
    altJid,
    isDirectMessage: !isGroupLikeJid(remoteJid),
    senderJid,
    targetJid,
  };
}

async function getWorkerOrThrow(workerPhone: string): Promise<WhatsAppWorker> {
  const safeWorkerPhone = normalizeDigits(workerPhone);
  if (!safeWorkerPhone) {
    throw new Error("workerPhone is required and must be a string");
  }

  const worker = await getWhatsAppWorkerByPhone(safeWorkerPhone);
  if (!worker) {
    throw new Error(`Worker not found for phone number: ${workerPhone}`);
  }

  return worker;
}

async function syncContactForMessage(
  sock: WASocket,
  message: WAMessage,
  senderContext: MessageSenderContext,
  senderPhone: string,
): Promise<boolean> {
  const state = getContactSyncState(sock);
  const cacheKeys = [senderContext.senderJid, senderContext.targetJid, senderContext.altJid]
    .map((jid) => normalizeOptionalJid(jid))
    .filter((jid): jid is string => Boolean(jid));

  const fallbackName = normalizeContactName(message.pushName);
  let resolvedNameFromDatabase: string | null = null;

  try {
    resolvedNameFromDatabase = await resolveContactNameByPhone(senderPhone);
  } catch (error) {
    logger.warn(
      {
        err: error,
        phone: senderPhone,
      },
      "[auth] Falha ao resolver nome do contato no banco; usando pushName como fallback",
    );
  }

  const contactName = resolvedNameFromDatabase ? normalizeContactName(resolvedNameFromDatabase) : fallbackName;

  if (!contactName) {
    return false;
  }

  const currentName = cacheKeys
    .map((jid) => state.savedContactNames.get(jid))
    .find((name): name is string => Boolean(name));
  if (currentName === contactName) {
    return false;
  }

  if (cacheKeys.some((jid) => state.pendingContactIds.has(jid))) {
    return false;
  }

  for (const cacheKey of cacheKeys) {
    state.pendingContactIds.add(cacheKey);
  }

  try {
    await sock.addOrEditContact(senderContext.targetJid, {
      fullName: contactName,
      firstName: getFirstName(contactName),
      saveOnPrimaryAddressbook: true,
      ...(senderContext.targetJid.endsWith("@s.whatsapp.net")
        ? { pnJid: senderContext.targetJid }
        : { lidJid: senderContext.senderJid }),
    });

    for (const cacheKey of cacheKeys) {
      state.savedContactNames.set(cacheKey, contactName);
    }

    logger.info(
      {
        senderJid: senderContext.senderJid,
        targetJid: senderContext.targetJid,
        contactName,
      },
      "[auth] Contato sincronizado no WhatsApp",
    );

    return true;
  } catch (error) {
    logger.error(
      {
        err: error,
        senderJid: senderContext.senderJid,
        targetJid: senderContext.targetJid,
      },
      "[auth] Falha ao sincronizar contato automaticamente",
    );

    return false;
  } finally {
    for (const cacheKey of cacheKeys) {
      state.pendingContactIds.delete(cacheKey);
    }
  }
}

async function ensureAuthorizationAndContactForMessage(
  sock: WASocket,
  message: WAMessage,
  worker: WhatsAppWorker,
): Promise<AuthCheckResult> {
  const senderContext = await resolveMessageSenderContext(sock, message);
  if (!senderContext?.isDirectMessage) {
    return { success: true, skipped: true };
  }

  const senderPhone = jidToPhone(senderContext.targetJid);
  if (!senderPhone) {
    return { success: true, skipped: true };
  }

  const authResult = await upsertWhatsappAuthorizationByPhone(senderPhone, worker.id);
  const contactSynced = await syncContactForMessage(sock, message, senderContext, senderPhone);

  logger.info(
    {
      phone: senderPhone,
      workerId: worker.id,
      alreadyAuthorized: authResult.alreadyAuthorized,
      contactSynced,
    },
    "[auth] Autorizacao verificada para contato direto",
  );

  return {
    success: true,
    already: authResult.alreadyAuthorized,
    skipped: false,
    contactSynced,
  };
}

/**
 * Updates WhatsApp authorization for a direct-message sender and synchronizes the
 * corresponding WhatsApp contact name using the latest data from the database.
 */
export async function checkAuth(sock: WASocket, message: WAMessage, workerPhone: string): Promise<AuthCheckResult> {
  try {
    if (!sock) throw new Error("sock (WASocket) is required");
    if (!message?.key) throw new Error("message is required");

    getContactSyncState(sock);
    const worker = await getWorkerOrThrow(workerPhone);
    return await ensureAuthorizationAndContactForMessage(sock, message, worker);
  } catch (error) {
    const msg = (error as Error)?.message ?? String(error);
    throw new Error(`checkAuth failed: ${msg}`, { cause: error });
  }
}

/**
 * On startup, collects initial direct-message history and reuses the same auth/contact
 * sync path so both authorizations and WhatsApp contact names are refreshed.
 */
export async function addNewAuthorizations(sock: WASocket, workerPhone: string): Promise<void> {
  try {
    if (!sock) throw new Error("sock (WASocket) is required");
    const worker = await getWorkerOrThrow(workerPhone);
    const state = getContactSyncState(sock);
    const collectedMessages: WAMessage[] = [];
    const seenMessageKeys = new Set<string>();

    await new Promise<void>((resolve) => {
      const timers = new Set<NodeJS.Timeout>();
      let settled = false;

      const scheduleSettle = (ms: number) => {
        const timer = setTimeout(cleanupAndResolve, ms);
        timers.add(timer);
      };

      const registerMessages = (messages: WAMessage[]) => {
        for (const message of messages) {
          const uniqueKey = getMessageUniqueKey(message);
          if (seenMessageKeys.has(uniqueKey)) continue;
          seenMessageKeys.add(uniqueKey);
          collectedMessages.push(message);
        }
      };

      const onHistorySet: (arg: BaileysEventMap["messaging-history.set"]) => void = ({ contacts, messages }) => {
        for (const contact of contacts ?? []) {
          registerSavedContact(state.savedContactNames, contact);
        }

        registerMessages(messages ?? []);
        scheduleSettle(INITIAL_COLLECTION_SETTLE_MS);
      };

      const onMessagesUpsert: (arg: BaileysEventMap["messages.upsert"]) => void = ({ messages }) => {
        registerMessages(messages ?? []);
      };

      const cleanupAndResolve = () => {
        if (settled) return;
        settled = true;

        sock.ev.off("messaging-history.set", onHistorySet);
        sock.ev.off("messages.upsert", onMessagesUpsert);

        for (const timer of timers) {
          clearTimeout(timer);
        }

        resolve();
      };

      sock.ev.on("messaging-history.set", onHistorySet);
      sock.ev.on("messages.upsert", onMessagesUpsert);
      scheduleSettle(INITIAL_COLLECTION_WINDOW_MS);
    });

    if (!collectedMessages.length) {
      logger.info("[auth] No phone numbers found for initial authorization");
      return;
    }

    const latestMessagesByPhone = new Map<string, WAMessage>();

    for (const message of collectedMessages) {
      const senderContext = await resolveMessageSenderContext(sock, message);
      if (!senderContext?.isDirectMessage) continue;

      const senderPhone = jidToPhone(senderContext.targetJid);
      if (!senderPhone) continue;

      latestMessagesByPhone.set(senderPhone, message);
    }

    if (!latestMessagesByPhone.size) {
      logger.info("[auth] No valid contacts found for authorization");
      return;
    }

    let processed = 0;

    for (const message of latestMessagesByPhone.values()) {
      try {
        const result = await ensureAuthorizationAndContactForMessage(sock, message, worker);
        if (!result.skipped) {
          processed += 1;
        }
      } catch (error) {
        logger.warn({ err: error }, "[auth] Failed to process an initial direct-message contact");
      }
    }

    logger.info(`[auth] Successfully synchronized authorizations/contacts for ${processed} contacts.`);
  } catch (error) {
    logger.error({ err: error }, "[auth] Error updating authorizations");
  }
}
