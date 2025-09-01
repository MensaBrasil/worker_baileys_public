import { config as configDotenv } from "dotenv";
import type { AdditionFailurePayload, FlaggedLogPayload, RemovalFailurePayload } from "../types/telegramTypes";

configDotenv({ path: ".env" });

/**
 * Minimal Telegram Bot API client using fetch (no extra deps).
 * Logs both attempts and outcomes to help diagnose failures.
 */
async function telegramRequest(method: string, payload: Record<string, unknown>): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[telegram] Skipping request: TELEGRAM_BOT_TOKEN not set.");
    return;
  }
  const url = `https://api.telegram.org/bot${token}/${method}`;

  const chatId = (payload as { chat_id?: string | number }).chat_id;
  const t = (payload as { text?: string }).text;
  const preview = t ? (t.length > 140 ? `${t.slice(0, 140)}… (${t.length} chars)` : t) : undefined;

  console.log(`[telegram] -> ${method} to chat ${chatId ?? "<unknown>"}` + (preview ? ` | preview: ${preview}` : ""));

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

    const raw = await res.text().catch(() => "");

    if (!res.ok) {
      console.warn(`[telegram] HTTP ${res.status} ${res.statusText}. Body: ${raw}`);
      return;
    }

    // Telegram returns JSON with { ok, result?, description? }
    try {
      const data = raw ? JSON.parse(raw) : {};
      if (data?.ok) {
        const mid = data?.result?.message_id ?? data?.result?.messageId ?? "<no-id>";
        console.log(`[telegram] OK: ${method} delivered to ${chatId ?? "<unknown>"} (message_id=${mid}).`);
      } else {
        console.warn(`[telegram] API ok=false. Description: ${data?.description ?? "<none>"}. Raw: ${raw}`);
      }
    } catch (e) {
      console.warn(`[telegram] Non-JSON response. Assuming success. Raw: ${raw}. ParseErr: ${String(e)}`);
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
  if (!chatIdEnv) {
    console.warn("[telegram] Skipping sendMessage: chat id env not set.");
    return;
  }
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
  const lines = [
    "<b>⚠️ FALHA NA INCLUSÃO ⚠️</b>",
    `<b>Horário:</b> ${ts}`,
    `<b>Request ID:</b> ${escapeHtml(String(payload.requestId))}`,
  ];

  if (payload.registrationId != null)
    lines.push(`<b>Registration ID:</b> ${escapeHtml(String(payload.registrationId))}`);
  if (payload.groupName || payload.groupId) {
    const grp = payload.groupName
      ? `${escapeHtml(payload.groupName)} (${escapeHtml(String(payload.groupId ?? ""))})`
      : escapeHtml(String(payload.groupId));
    lines.push(`<b>Grupo:</b> ${grp}`);
  }
  lines.push(`<b>Erro:</b> ${escapeHtml(payload.reason)}`);

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
