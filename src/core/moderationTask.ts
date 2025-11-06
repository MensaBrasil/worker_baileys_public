import { config as configDotenv } from "dotenv";
import type { BaileysEventMap, GroupMetadata, proto, WASocket } from "baileys";
import { sendTelegramFlaggedLog } from "../utils/telegram";
import { findParticipant } from "../utils/waParticipants";
import logger from "../utils/logger";
import { findRegistrationIdByPhone, insertWhatsAppModeration } from "../db/pgsql";
import { checkGroupTypeByMeta } from "../utils/checkGroupType";
import type { ModerationResponse, ModerationResult } from "../types/moderationTypes";

configDotenv({ path: ".env" });

const groupInviteRegex = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]{10,}/i;
const shortenerRegex =
  /https?:\/\/(?:www\.)?(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|buff\.ly|bitly\.com|shorturl\.at|cutt\.ly|rb\.gy)\/\S+/i;
// Match api.whatsapp.com links, including obfuscated dots like api[.]whatsapp[.]com,
// with or without scheme and with optional path/query
const apiWhatsAppRegex = /(?:https?:\/\/)?(?:www\.)?api(?:\.|\[\.\])whatsapp(?:\.|\[\.\])com(?:\/\S*)?/i;
// Match wa.me links, including obfuscated dots wa[.]me, with or without scheme and optional path
const waMeRegex = /(?:https?:\/\/)?(?:www\.)?wa(?:\.|\[\.\])me(?:\/\S*)?/i;

// Detect URLs (real or mocked) containing community/group keywords
const xCommunityRegex = /(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/i\/communities\/[^\s]+/i;
const communityKeywordRegex = /(commun\w*|group\w*)/i;
const urlLikeRegex = /(?:https?:\/\/|www\.)[^\s]+|(?:[a-z0-9][\w-]*\.)+[a-z0-9-]{2,}(?:\/[^\s]*)?/gi;
const whitelistedCommunityDomains = ["mensa.org", "mensa.org.br"];
const bannedCommunityId = "1968352772362780861";

function normalizeMockedUrlText(text: string): string {
  return text
    .replace(/\[\s*\.\s*\]/g, ".")
    .replace(/\(\s*dot\s*\)/gi, ".")
    .replace(/\[\s*dot\s*\]/gi, ".")
    .replace(/\bdot\b/gi, ".")
    .replace(/\(\s*slash\s*\)/gi, "/")
    .replace(/\[\s*slash\s*\]/gi, "/")

    .replace(/\bslash\b/gi, "/")
    .replace(/\bponto\b/gi, ".")
    .replace(/([a-z0-9])ponto([a-z0-9])/gi, "$1.$2")
    .replace(/\bh\s*t\s*t\s*p\s*s?\s*:\s*\/\s*\/\s*/gi, (match) => {
      const cleaned = match.replace(/\s+/g, "");
      return cleaned.toLowerCase().startsWith("https") ? "https://" : "http://";
    })
    .replace(/c\s*h\s*a\s*t\s*\.?\s*w\s*h\s*a\s*t\s*s\s*a\s*p\s*p\s*\.?\s*c\s*o\s*m/gi, "chat.whatsapp.com")
    .replace(/a\s*p\s*i\s*\.?\s*w\s*h\s*a\s*t\s*s\s*a\s*p\s*p\s*\.?\s*c\s*o\s*m/gi, "api.whatsapp.com")
    .replace(/w\s*a\s*\.?\s*m\s*e/gi, "wa.me")
    .replace(/(?:\u200b|\u200c|\u200d|\ufeff)/g, "")
    .replace(/:\s*\/\s*\//g, "://")
    .replace(/\/\s*\/+/g, "//")
    .replace(/([a-z0-9])\s*\/\s*([a-z0-9])/gi, "$1/$2")
    .replace(/([a-z0-9])\s*\.\s*([a-z0-9])/gi, "$1.$2");
}

const leadingUrlPunctuation = new Set(["(", "<", '"', "'", "`", "["]);
const trailingUrlPunctuation = new Set([")", ">", '"', "'", "`", ",", ".", "!", "?", ";", ":", "\u2026", "]"]);

function stripUrlPunctuation(candidate: string): string {
  let value = candidate.trim();

  while (value) {
    const leadingChar = value[0];
    if (!leadingChar || !leadingUrlPunctuation.has(leadingChar)) break;
    value = value.slice(1).trimStart();
  }

  while (value) {
    const trailingChar = value[value.length - 1];
    if (!trailingChar || !trailingUrlPunctuation.has(trailingChar)) break;
    value = value.slice(0, -1).trimEnd();
  }

  return value;
}

function getHostname(candidate: string): string | null {
  let value = stripUrlPunctuation(candidate.trim());
  if (!value) return null;

  if (!/^https?:\/\//i.test(value)) {
    value = value.startsWith("www.") ? `https://${value}` : `https://${value}`;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname;
    if (!hostname || !hostname.includes(".")) return null;
    return hostname;
  } catch {
    return null;
  }
}

function isWhitelistedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return whitelistedCommunityDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isDomainLike(candidate: string): boolean {
  let value = stripUrlPunctuation(candidate.trim());
  if (!value) return false;

  if (!/^https?:\/\//i.test(value)) {
    value = value.startsWith("www.") ? `https://${value}` : `https://${value}`;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname;
    if (!hostname || !hostname.includes(".")) return false;

    const labels = hostname.split(".").filter(Boolean);
    if (labels.length < 2) return false;

    const tld = labels[labels.length - 1];
    if (!tld || !/^[a-z0-9-]{2,}$/i.test(tld)) return false;

    return true;
  } catch {
    return false;
  }
}

function containsCommunityUrl(text: string): boolean {
  if (xCommunityRegex.test(text)) return true;

  const matches = text.match(urlLikeRegex);
  if (!matches) return false;

  return matches.some((rawCandidate) => {
    const candidate = stripUrlPunctuation(rawCandidate);
    if (!candidate) return false;
    if (!communityKeywordRegex.test(candidate)) return false;

    const hostname = getHostname(candidate);
    if (hostname && isWhitelistedHostname(hostname)) return false;

    if (isDomainLike(candidate)) return true;

    if (/^(?:https?:\/\/|www\.)/i.test(candidate) && candidate.includes("/")) return true;

    return false;
  });
}

function contentText(m: proto.IMessage | null | undefined): string {
  if (!m) return "";
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

async function deleteMessageIfAllowed(
  sock: WASocket,
  msg: proto.IWebMessageInfo,
  meta: GroupMetadata | null,
): Promise<{ attempted: boolean; deleted: boolean } | void> {
  try {
    if (!msg.key?.remoteJid) return;
    const fromJid = msg.key.remoteJid;
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const isGroup = fromJid.endsWith("@g.us");
    if (!isGroup || !meta) return { attempted: false, deleted: false };

    const p = findParticipant(meta, senderJid);
    const isSenderAdmin = Boolean(p?.admin);
    if (isSenderAdmin) return { attempted: false, deleted: false }; // Don't delete admin messages

    await sock.sendMessage(fromJid, { delete: msg.key });
    return { attempted: true, deleted: true };
  } catch {
    return { attempted: true, deleted: false };
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
  const normalizedText = normalizeMockedUrlText(text);
  const meta = await getGroupMetadata(sock, remote);

  // Link deletion for non-admins (toggle via ENABLE_LINK_MODERATION=true)
  const enableLinkModeration = process.env.ENABLE_LINK_MODERATION === "true";
  const hasCommunityLink = containsCommunityUrl(normalizedText);
  const hasBannedCommunityId = normalizedText.includes(bannedCommunityId);

  const hasGroupInviteLink = groupInviteRegex.test(text) || groupInviteRegex.test(normalizedText);
  const hasShortenedLink = shortenerRegex.test(text) || shortenerRegex.test(normalizedText);
  const hasApiWhatsAppLink = apiWhatsAppRegex.test(text) || apiWhatsAppRegex.test(normalizedText);
  const hasWaMeLink = waMeRegex.test(text) || waMeRegex.test(normalizedText);

  const hasModeratableLink =
    hasGroupInviteLink ||
    hasShortenedLink ||
    hasApiWhatsAppLink ||
    hasWaMeLink ||
    hasCommunityLink ||
    hasBannedCommunityId;

  if (enableLinkModeration && hasModeratableLink && meta) {
    const deletion = await deleteMessageIfAllowed(sock, msg, meta);

    // Persist moderation only when deletion was attempted (log outcome)
    if (deletion && deletion.attempted) {
      const fromJid = msg.key.remoteJid || "";
      const groupId = fromJid.endsWith("@g.us") ? fromJid.replace(/@g\.us$/, "") : fromJid;
      const senderJid = msg.key.participant || msg.key.remoteJid || "";
      const phone = (senderJid.split("@")[0] || "").replace(/\D/g, "");
      let deletionReason: string;
      if (hasGroupInviteLink) {
        deletionReason = "group_invite_link";
      } else if (hasShortenedLink) {
        deletionReason = "shortened_link";
      } else if (hasApiWhatsAppLink) {
        deletionReason = "api_whatsapp_link";
      } else if (hasWaMeLink) {
        deletionReason = "wa_me_link";
      } else if (hasBannedCommunityId) {
        deletionReason = "community_id";
      } else if (hasCommunityLink) {
        deletionReason = "community_link";
      } else {
        deletionReason = "link";
      }
      if (deletion.deleted) {
        logger.info({ phone, groupId, reason: deletionReason }, "Moderation: link deleted successfully");
      } else {
        logger.warn({ phone, groupId, reason: deletionReason }, "Moderation: link deletion failed");
      }

      try {
        // Try to resolve registration_id if possible
        let registrationId: number | null = null;
        try {
          registrationId = phone ? await findRegistrationIdByPhone(phone) : null;
        } catch {
          registrationId = null;
        }

        const ts = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : undefined;

        await insertWhatsAppModeration({
          registration_id: registrationId,
          group_id: groupId,
          timestamp: ts,
          deleted: Boolean(deletion.deleted),
          reason: deletionReason,
          phone,
          content: text || null,
        });
        logger.info({ phone, groupId, reason: deletionReason }, "Moderation: record stored in database");
      } catch (err) {
        logger.error({ err }, "Moderation: failed to store record in database");
      }
    }
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
