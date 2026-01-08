import type { PrismaClient } from "@prisma/client";
import { jidNormalizedUser, type proto } from "baileys";

type UpsertType = "notify" | "append" | "replace";

function normalizePhoneFromJid(jid?: string | null): string | null {
  if (!jid) return null;
  if (jid.endsWith("@lid") || jid.endsWith("@g.us")) return null;
  const base = jid.split("@")[0]?.trim();
  if (!base) return null;
  const digits = base.replace(/\D/g, "");
  return digits.length ? digits : null;
}

export async function onMessagesUpsert(
  prisma: PrismaClient,
  messages: proto.IWebMessageInfo[],
  sellerNumber: string,
  type: UpsertType,
) {
  for (const m of messages) {
    const key = m.key;
    if (!key?.id || !key.remoteJid) continue;

    const contactJid = jidNormalizedUser(key.remoteJid);
    if (!contactJid) continue;

    await prisma.contact.upsert({
      where: { phone_number: contactJid },
      update: {},
      create: {
        phone_number: contactJid,
        account_phone: sellerNumber,
      },
    });

    const conversa = await prisma.conversa.upsert({
      where: {
        phone_number_accounts_phone_number_contacts: {
          phone_number_accounts: sellerNumber,
          phone_number_contacts: contactJid,
        },
      },
      update: {},
      create: {
        phone_number_accounts: sellerNumber,
        phone_number_contacts: contactJid,
      },
      select: { id: true },
    });

    const timestamp = m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000) : null;
    const isDirectMessage = !key.remoteJid.endsWith("@g.us");
    const keyAlt = key as { participantAlt?: string; remoteJidAlt?: string };
    const rawPhone = key.fromMe
      ? sellerNumber
      : (normalizePhoneFromJid(key.remoteJid) ??
        normalizePhoneFromJid(keyAlt.participantAlt) ??
        normalizePhoneFromJid(keyAlt.remoteJidAlt) ??
        normalizePhoneFromJid(key.participant));
    const phone = isDirectMessage ? rawPhone : null;
    const rawMetadata = JSON.parse(
      JSON.stringify({
        ...m,
        message: undefined,
      }),
    );

    await prisma.message.upsert({
      where: {
        conversa_id_whatsapp_message_id: {
          conversa_id: conversa.id,
          whatsapp_message_id: key.id,
        },
      },
      update: {
        phone,
        direct_message: isDirectMessage,
        raw_json: rawMetadata,
      },
      create: {
        conversa_id: conversa.id,
        whatsapp_message_id: key.id,
        remote_jid: key.remoteJid,
        from_me: !!key.fromMe,
        phone,
        direct_message: isDirectMessage,
        type,
        timestamp_original: timestamp,
        raw_json: rawMetadata,
      },
    });
  }
}
