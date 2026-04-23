import { isHostedPnUser, isPnUser, jidDecode, jidNormalizedUser, type WAMessage, type WASocket } from "baileys";

export type MessageSenderContext = {
  altJid?: string | undefined;
  isDirectMessage: boolean;
  senderJid: string;
  targetJid: string;
};

const normalizeDigits = (value: string) => value.replace(/\D/g, "");

const normalizeOptionalJid = (jid?: string | null) => {
  if (!jid) {
    return undefined;
  }

  const normalizedJid = jidNormalizedUser(jid);
  return normalizedJid || undefined;
};

const isGroupLikeJid = (jid?: string | null) =>
  !!jid &&
  (jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter"));

export const jidToPhone = (jid?: string | null) => {
  if (!jid) {
    return null;
  }

  const normalizedJid = jidNormalizedUser(jid);
  const isPhoneUser =
    isPnUser(normalizedJid) ||
    isHostedPnUser(normalizedJid) ||
    normalizedJid.endsWith("@c.us") ||
    normalizedJid.endsWith("@s.whatsapp.net");

  if (!isPhoneUser) {
    return null;
  }

  const decoded = jidDecode(normalizedJid);
  const local = decoded?.user ?? normalizedJid.split("@")[0] ?? "";
  const digits = normalizeDigits(local);

  return digits || null;
};

const getMessageSenderJid = (message: WAMessage) => {
  if (message.key.fromMe) {
    return undefined;
  }

  const senderJid = message.key.participant || message.key.remoteJid;

  if (!senderJid) {
    return undefined;
  }

  const normalizedJid = jidNormalizedUser(senderJid);

  if (!normalizedJid.endsWith("@s.whatsapp.net") && !normalizedJid.endsWith("@lid")) {
    return undefined;
  }

  return normalizedJid;
};

async function resolveMessageSenderTargetJid(socket: WASocket, message: WAMessage, senderJid: string) {
  const altJid = normalizeOptionalJid(message.key.participantAlt || message.key.remoteJidAlt);

  if (altJid?.endsWith("@s.whatsapp.net")) {
    return altJid;
  }

  if (!senderJid.endsWith("@lid")) {
    return senderJid;
  }

  const mappedPnJid = await socket.signalRepository.lidMapping.getPNForLID(senderJid);
  const normalizedPnJid = normalizeOptionalJid(mappedPnJid);

  if (normalizedPnJid?.endsWith("@s.whatsapp.net")) {
    return normalizedPnJid;
  }

  return senderJid;
}

export async function resolveMessageSenderContext(
  socket: WASocket,
  message: WAMessage,
): Promise<MessageSenderContext | null> {
  const senderJid = getMessageSenderJid(message);

  if (!senderJid) {
    return null;
  }

  const remoteJid = normalizeOptionalJid(message.key.remoteJid);
  const altJid = normalizeOptionalJid(message.key.participantAlt || message.key.remoteJidAlt);
  const targetJid = await resolveMessageSenderTargetJid(socket, message, senderJid);

  return {
    altJid,
    isDirectMessage: !isGroupLikeJid(remoteJid),
    senderJid,
    targetJid,
  };
}
