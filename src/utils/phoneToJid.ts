/**
 * Converts a phone number into a valid WhatsApp JID.
 * Accepts E.164 with/without "+" or numbers with loose characters.
 * Ex: "+5511999998888" -> "5511999998888@s.whatsapp.net"
 */
export function phoneToUserJid(input: string): string {
  const digits = (input || "").replace(/\D/g, "");
  if (!digits) throw new Error(`Número inválido: "${input}"`);
  return `${digits}@s.whatsapp.net`;
}

/** Ensures that a group JID ends with @g.us */
export function asGroupJid(groupId: string): string {
  if (!groupId) throw new Error("groupId vazio");
  return groupId.endsWith("@g.us") ? groupId : `${groupId}@g.us`;
}
