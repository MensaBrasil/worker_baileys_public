import type { PrismaClient } from "@prisma/client";
import { jidNormalizedUser, type proto, type WAMessageContent, type WAMessageKey } from "baileys";

export function makeGetMessageForAccount(accountPhone: string, prisma: PrismaClient) {
  return async function getMessageFromDB(key: WAMessageKey): Promise<WAMessageContent | undefined> {
    if (!key?.id || !key.remoteJid) return undefined;

    const contactJid = jidNormalizedUser(key.remoteJid);
    if (!contactJid) return undefined;

    const conversa = await prisma.conversa.findFirst({
      where: {
        phone_number_accounts: accountPhone,
        phone_number_contacts: contactJid,
      },
      select: { id: true },
    });

    if (!conversa) return undefined;

    const msg = await prisma.message.findFirst({
      where: {
        conversa_id: conversa.id,
        whatsapp_message_id: key.id,
      },
      select: { raw_json: true },
    });

    const raw = msg?.raw_json as proto.IWebMessageInfo | undefined;
    return raw?.message as WAMessageContent | undefined;
  };
}
