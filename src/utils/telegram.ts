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
    console.warn("[telegram] Requisição ignorada: TELEGRAM_BOT_TOKEN não definido.");
    return;
  }
  const url = `https://api.telegram.org/bot${token}/${method}`;

  const chatId = (payload as { chat_id?: string | number }).chat_id;
  const t = (payload as { text?: string }).text;
  const preview = t ? (t.length > 140 ? `${t.slice(0, 140)}… (${t.length} caracteres)` : t) : undefined;

  console.log(
    `[telegram] -> ${method} para chat ${chatId ?? "<desconhecido>"}${preview ? ` | prévia: ${preview}` : ""}`,
  );

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
      console.warn(`[telegram] HTTP ${res.status} ${res.statusText}. Corpo: ${raw}`);
      return;
    }

    // Telegram returns JSON with { ok, result?, description? }
    try {
      const data = raw ? JSON.parse(raw) : {};
      if (data?.ok) {
        const mid = data?.result?.message_id ?? data?.result?.messageId ?? "<sem-id>";
        console.log(`[telegram] OK: ${method} entregue para ${chatId ?? "<desconhecido>"} (message_id=${mid}).`);
      } else {
        console.warn(`[telegram] API ok=false. Descrição: ${data?.description ?? "<nenhuma>"}. Resposta bruta: ${raw}`);
      }
    } catch (e) {
      console.warn(
        `[telegram] Resposta não JSON. Assumindo sucesso. Resposta bruta: ${raw}. Erro de parse: ${String(e)}`,
      );
    }
  } catch (err) {
    console.warn("[telegram] Erro ao enviar requisição:", err);
  }
}

export async function sendTelegramMessage(
  chatIdEnv: string | undefined,
  text: string,
  parseMode: "HTML" | "MarkdownV2" | undefined = "HTML",
): Promise<void> {
  if (!chatIdEnv) {
    console.warn("[telegram] sendMessage ignorado: variável de chat id não definida.");
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
    "<b>Mensagem sinalizada</b>",
    `<b>Horário:</b> ${payload.time}`,
    `<b>Remetente:</b> ${payload.sender}`,
    `<b>Grupo:</b> ${payload.groupName}`,
    `<b>Mensagem:</b>\n<pre>${escapeHtml(payload.message)}</pre>`,
    `<b>Categorias sinalizadas:</b> ${payload.categoriesInline}`,
  ];
  if (payload.modalitiesLine) lines.push(`<b>Modalidades de entrada:</b> ${payload.modalitiesLine}`);

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
    `<b>ID da solicitação:</b> ${escapeHtml(String(payload.requestId))}`,
  ];

  if (payload.registrationId != null)
    lines.push(`<b>ID da inscrição:</b> ${escapeHtml(String(payload.registrationId))}`);
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
    "<b>⚠️ FALHA NA REMOÇÃO DE MEMBRO ⚠️</b>",
    `<b>Horário:</b> ${ts}`,
    `<b>Telefone do membro:</b> ${payload.phone}`,
  ];
  if (payload.registrationId != null)
    lines.push(`<b>ID da inscrição:</b> ${escapeHtml(String(payload.registrationId))}`);
  const groupInfo = payload.groupName ? `${payload.groupName} (${payload.groupId})` : payload.groupId;
  lines.push(`<b>Grupo:</b> ${groupInfo}`);
  if (payload.communityId) lines.push(`<b>ID da comunidade:</b> ${payload.communityId}`);
  lines.push(`<b>Motivo da remoção:</b> ${escapeHtml(payload.removalReason)}`);
  if (payload.failureReason) lines.push(`<b>Motivo da falha:</b> ${escapeHtml(payload.failureReason)}`);

  await sendTelegramMessage(process.env.TELEGRAM_FAILURES_CHAT_ID, lines.join("\n"), "HTML");
}
