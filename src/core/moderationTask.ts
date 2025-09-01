import { config as configDotenv } from "dotenv";
import type { BaileysEventMap, GroupMetadata, proto, WASocket } from "baileys";
import { sendTelegramFlaggedLog } from "../utils/telegram";
import { checkGroupTypeByMeta } from "../utils/checkGroupType";
import type { ModerationResponse, ModerationResult } from "../types/moderationTypes";

configDotenv({ path: ".env" });

const groupInviteRegex = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]{10,}/i;
const shortenerRegex =
  /https?:\/\/(?:www\.)?(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|buff\.ly|bitly\.com|shorturl\.at|cutt\.ly|rb\.gy)\/\S+/i;

function contentText(m: proto.IMessage | null | undefined): string {
  if (!m) return "";
  // common text containers
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  return "";
}

async function getGroupMetadata(sock: WASocket, jid: string): Promise<GroupMetadata | null> {
  try {
    const meta = await sock.groupMetadata(jid);
    return meta ?? null;
  } catch {
    return null;
  }
}

async function deleteMessageIfAllowed(sock: WASocket, msg: proto.IWebMessageInfo, meta: GroupMetadata | null) {
  try {
    if (!msg.key?.remoteJid) return;
    const fromJid = msg.key.remoteJid;
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const isGroup = fromJid.endsWith("@g.us");
    if (!isGroup || !meta) return;

    const p = meta.participants?.find((x) => x.id === senderJid);
    const isSenderAdmin = Boolean(p?.admin);
    if (isSenderAdmin) return; // Don't delete admin messages

    await sock.sendMessage(fromJid, { delete: msg.key });
  } catch {
    // ignore delete failures
  }
}

async function openAIModerate(inputs: Array<{ type: "text"; text: string }>): Promise<ModerationResponse | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input: inputs }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as ModerationResponse;
    return data;
  } catch {
    return null;
  }
}

export async function handleMessageModeration(
  sock: WASocket,
  msg: BaileysEventMap["messages.upsert"]["messages"][number],
): Promise<void> {
  const remote = msg.key.remoteJid || "";
  const isGroup = remote.endsWith("@g.us") || remote.endsWith("@newsletter");
  if (!isGroup) return;

  const text = contentText(msg.message);
  const meta = await getGroupMetadata(sock, remote);

  // Link deletion for non-admins (toggle via ENABLE_LINK_MODERATION=true)
  const enableLinkModeration = process.env.ENABLE_LINK_MODERATION === "true";
  if (enableLinkModeration && (groupInviteRegex.test(text) || shortenerRegex.test(text)) && meta) {
    await deleteMessageIfAllowed(sock, msg, meta);
  }

  // Optional moderation via OpenAI
  if (!process.env.TELEGRAM_MODERATIONS_CHAT_ID) return;
  if (!text || !text.trim()) return;
  const enableContentModeration = process.env.ENABLE_CONTENT_MODERATION === "true";
  if (!enableContentModeration) return;

  // Only run moderation for M.JB or JB groups
  const groupType = checkGroupTypeByMeta(meta);
  const allowModeration = groupType === "M.JB" || groupType === "JB";
  if (!allowModeration) return;

  const inputs = [{ type: "text" as const, text }];
  const moderation = await openAIModerate(inputs);
  if (!moderation?.results) return;

  const flagged = moderation.results.find((r: ModerationResult) => r.flagged);
  if (!flagged) return;

  const flaggedCatsInline = Object.entries(flagged.categories || {})
    .filter(([, v]) => v)
    .map(([k]) => `<b>${k}</b> (<code>${Number(flagged.category_scores?.[k] ?? 0).toFixed(3)}</code>)`)
    .join(", ");

  const timeIso = msg.messageTimestamp
    ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
    : new Date().toISOString();
  const sender = msg.key.participant || msg.key.remoteJid || "unknown";
  const groupName = meta?.subject || remote;

  await sendTelegramFlaggedLog({
    time: timeIso,
    sender,
    groupName,
    message: text,
    categoriesInline: flaggedCatsInline,
  });
}
