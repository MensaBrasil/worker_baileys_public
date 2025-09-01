import { config as configDotenv } from "dotenv";
import type { AdditionFailurePayload, FlaggedLogPayload, RemovalFailurePayload } from "../types/telegramTypes";

configDotenv({ path: ".env" });

/**
 * Minimal Telegram Bot API client using fetch (no extra deps).
 */
async function telegramRequest(method: string, payload: Record<string, unknown>): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    // Silently skip if token not set
    return;
  }
  const url = `https://api.telegram.org/bot${token}/${method}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text().catch(() => "");

      console.warn(`[telegram] Request failed: ${res.status} ${res.statusText} ${text}`);
    }
  } catch (err) {
    console.warn("[telegram] Error sending request:", err);
  }
}

export async function sendTelegramMessage(
  chatIdEnv: string | undefined,
  text: string,
  parseMode: "HTML" | "MarkdownV2" | undefined = "HTML",
): Promise<void> {
  if (!chatIdEnv) return;
  await telegramRequest("sendMessage", {
    chat_id: chatIdEnv,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  });
}

// Types are declared in src/types/telegramTypes.ts

/**
 * Sends a formatted flagged message log to Telegram.
 */
export async function sendTelegramFlaggedLog(payload: FlaggedLogPayload): Promise<void> {
  const lines = [
    "<b>Flagged Message</b>",
    `<b>Time:</b> ${payload.time}`,
    `<b>Sender:</b> ${payload.sender}`,
    `<b>Group:</b> ${payload.groupName}`,
    `<b>Message:</b>\n<pre>${escapeHtml(payload.message)}</pre>`,
    `<b>Flagged Categories:</b> ${payload.categoriesInline}`,
  ];
  if (payload.modalitiesLine) lines.push(`<b>Input Modalities:</b> ${payload.modalitiesLine}`);

  await sendTelegramMessage(process.env.TELEGRAM_MODERATIONS_CHAT_ID, lines.join("\n"), "HTML");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Types are declared in src/types/telegramTypes.ts

/**
 * Notifies a Telegram chat when a group addition fails.
 */
export async function notifyAdditionFailure(payload: AdditionFailurePayload): Promise<void> {
  const ts = new Date().toISOString();
  const lines = ["<b>⚠️ FALHA NA INCLUSÃO ⚠️</b>", `<b>Horário:</b> ${ts}`, `<b>Request ID:</b> ${payload.requestId}`];

  if (payload.registrationId != null) lines.push(`<b>Registration ID:</b> ${payload.registrationId}`);
  if (payload.groupName || payload.groupId) {
    const grp = payload.groupName ? `${payload.groupName} (${payload.groupId ?? ""})` : payload.groupId;
    lines.push(`<b>Grupo:</b> ${grp}`);
  }
  lines.push(`<b>Erro:</b> ${payload.reason}`);

  await sendTelegramMessage(process.env.TELEGRAM_FAILURES_CHAT_ID, lines.join("\n"), "HTML");
}

// Types are declared in src/types/telegramTypes.ts

/**
 * Notifies a Telegram chat when a member removal failed.
 */
export async function notifyRemovalFailure(payload: RemovalFailurePayload): Promise<void> {
  const ts = new Date().toISOString();
  const lines = [
    "<b>⚠️ MEMBER REMOVAL FAILED ⚠️</b>",
    `<b>Time:</b> ${ts}`,
    `<b>Member Phone:</b> ${payload.phone}`,
    `<b>Registration ID:</b> ${payload.registrationId}`,
  ];
  const groupInfo = payload.groupName ? `${payload.groupName} (${payload.groupId})` : payload.groupId;
  lines.push(`<b>Group:</b> ${groupInfo}`);
  if (payload.communityId) lines.push(`<b>Community ID:</b> ${payload.communityId}`);
  lines.push(`<b>Removal Reason:</b> ${escapeHtml(payload.removalReason)}`);
  if (payload.failureReason) lines.push(`<b>Failure Reason:</b> ${escapeHtml(payload.failureReason)}`);

  await sendTelegramMessage(process.env.TELEGRAM_FAILURES_CHAT_ID, lines.join("\n"), "HTML");
}
