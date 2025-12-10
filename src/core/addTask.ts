import { config as configDotenv } from "dotenv";
import type { WASocket, GroupMetadata } from "baileys";
import { proto } from "baileys";
import { AddAttemptResult, AddProcessResult, MemberPhone, Worker } from "../types/addTaskTypes";
import type { MemberStatus } from "../types/pgsqlTypes";
import { AddQueueItem } from "../types/redisTypes";
import { phoneToUserJid, asGroupJid } from "../utils/phoneToJid";
import { isParticipantAdmin } from "../utils/waParticipants";
import { delaySecs } from "../utils/delay";
import {
  getMemberPhoneNumbers,
  recordUserEntryToGroup,
  registerWhatsappAddFulfilled,
  registerWhatsappAddAttempt,
  getWhatsappAuthorization,
  sendAdditionFailedReason,
} from "../db/pgsql";
import { notifyAdditionFailure } from "../utils/telegram";
import { getFromAddQueue } from "../db/redis";

// ---------- env & config ----------
configDotenv({ path: ".env" });

function parseEnvNumber(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    if (fallback != null) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number. Got: "${raw}"`);
  return n;
}

// Backoff window configuration after a successful add/invite (seconds)
// Using explicit min/max and an optional jitter
const MIN_DELAY = parseEnvNumber("MIN_DELAY");
const MAX_DELAY = parseEnvNumber("MAX_DELAY");
const DELAY_JITTER = parseEnvNumber("DELAY_JITTER", 0);

// Maximum time we will wait for a single networked Baileys call (ms)
const CALL_TIMEOUT_MS = parseEnvNumber("CALL_TIMEOUT_MS", 15_000);

// ---------- small utils ----------
const ansi = {
  cyan: (s: string) => `\x1b[96m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[92m${s}\x1b[0m`,
};

function normalizeDigits(phone: string | undefined | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length ? digits : null;
}

function asStatusCode(status: unknown): number | null {
  // Baileys returns 200/403/409 etc as numbers or strings depending on version
  if (typeof status === "number") return status;
  if (typeof status === "string" && status.trim() !== "") {
    const n = Number(status);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function withTimeout<T>(p: Promise<T>, ms = CALL_TIMEOUT_MS): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`Operation timed out after ${ms}ms`)), ms);
  });
  try {
    const res = await Promise.race([p, timeout]);
    return res as T;
  } finally {
    if (t) clearTimeout(t);
  }
}

// ---------- core flow ----------
/**
 * Reads an item from the queue and processes group inclusion.
 * - Checks if the bot is an admin
 * - Fetches phone numbers associated with the registration
 * - Attempts to add; if it fails due to policy, sends a GroupInviteMessage
 * - Logs the entry/invitation in the database
 */
export async function processAddQueue(sock: WASocket, worker: Worker): Promise<AddProcessResult> {
  // 1) Get next item
  const item: AddQueueItem | null = await getFromAddQueue();
  if (!item) {
    console.log("[addTask] addQueue vazia.");
    return baseResult(0, 0);
  }

  const groupJid = asGroupJid(item.group_id);
  console.log(ansi.cyan(`Processando inclusão: reg=${item.registration_id} -> grupo=${groupJid}`));

  // 2) Check admin in target group
  const meta = await safeGroupMetadata(sock, groupJid);
  if (!checkIfSelfIsAdmin(sock, meta)) {
    const reason = `Bot não é admin no grupo ${meta.subject ?? groupJid}.`;
    console.log(ansi.red(reason));
    await safeNotifyFailure(item.request_id, reason, {
      item,
      groupName: meta.subject ?? null,
    });
    await safeRegisterAttempt(item.request_id);
    return baseResult(0, 0);
  }

  // 3) Get member phones
  const memberPhones: MemberPhone[] = await getMemberPhoneNumbers(Number(item.registration_id));
  if (!memberPhones?.length) {
    const reason = `Nenhum telefone encontrado para registration_id ${item.registration_id}.`;
    console.log(ansi.red(reason));
    await safeNotifyFailure(item.request_id, reason, {
      item,
      groupName: meta.subject ?? null,
    });
    await safeRegisterAttempt(item.request_id);
    return baseResult(0, 0);
  }

  const results: AddProcessResult = {
    added: false,
    inviteSent: false,
    alreadyInGroup: false,
    processedPhones: 0,
    totalPhones: memberPhones.length,
  };

  const notAuthorizedNumbers: string[] = [];

  // 4) Try to add each phone
  for (const phone of memberPhones) {
    // RJB rule: only legal representatives
    if (item.group_type === "RJB" && !phone.is_legal_rep) {
      console.log(ansi.yellow(`Ignorando ${phone.phone}: não é representante legal (RJB).`));
      continue;
    }

    const normalized = normalizeDigits(phone.phone);
    if (!normalized) continue;

    const authKey = normalized.slice(-8);
    const authorized = await getWhatsappAuthorization(authKey, worker.id);
    if (!authorized?.phone_number) {
      notAuthorizedNumbers.push(normalized);
      console.log(ansi.red(`Telefone ${normalized} não autorizado.`));
      continue;
    }

    const attempt = await addMemberToGroup(sock, authorized.phone_number, groupJid, item, meta);

    if (attempt.added) {
      console.log(ansi.green(`Adicionado: reg=${item.registration_id} -> ${normalized} em ${groupJid}`));
      await safeRecordEntry(Number(item.registration_id), normalized, groupJid, "Active");
      results.added = true;
      results.processedPhones++;
      // Randomized delay within [MIN_DELAY, MAX_DELAY] with optional jitter
      await delaySecs(MIN_DELAY, MAX_DELAY, DELAY_JITTER);
    } else if (attempt.isInviteV4Sent) {
      console.log(ansi.green(`Invite enviado para ${normalized} no grupo ${groupJid}`));
      await safeRecordEntry(Number(item.registration_id), normalized, groupJid, "Active");
      results.inviteSent = true;
      results.processedPhones++;
      // Respect configured policy delay after sending invite
      await delaySecs(MIN_DELAY, MAX_DELAY, DELAY_JITTER);
    } else if (attempt.alreadyInGroup) {
      console.log(ansi.green(`Já está no grupo: ${normalized} -> ${groupJid}`));
      await safeRecordEntry(Number(item.registration_id), normalized, groupJid, "Active");
      results.alreadyInGroup = true;
      results.processedPhones++;
    }
  }

  // 5) Finalize request
  if (results.processedPhones > 0) {
    await registerWhatsappAddFulfilled(item.request_id);
    console.log(
      ansi.green(`Request nº ${item.request_id} cumprida — ${results.processedPhones}/${results.totalPhones}`),
    );
  } else {
    await registerWhatsappAddAttempt(item.request_id);
    const baseMsg = `Não foi possível cumprir request nº ${item.request_id} (reg=${item.registration_id}).`;
    console.log(ansi.red(baseMsg));
    let telegramReason = baseMsg;
    if (notAuthorizedNumbers.length) {
      const na = `Números não autorizados: ${notAuthorizedNumbers.join(", ")}`;
      console.log(ansi.red(na));
      telegramReason += `\n${na}`;
    }
    // Envia notificação ao Telegram com resumo da falha geral
    await safeNotifyFailure(item.request_id, telegramReason, {
      item,
      groupName: meta.subject ?? null,
    });
  }

  return results;
}

/**
 * Attempts to add a user to the group; if it fails due to policy/privacy,
 * sends a GroupInviteMessage to the user.
 */
export async function addMemberToGroup(
  sock: WASocket,
  phone: string,
  groupJid: string,
  item: AddQueueItem,
  meta?: GroupMetadata,
): Promise<AddAttemptResult> {
  const userJid = phoneToUserJid(phone);
  try {
    const metadata = meta ?? (await safeGroupMetadata(sock, groupJid));

    console.log(`Tentando adicionar ${phone} em ${groupJid} (${metadata.subject})`);

    const resp = await withTimeout(sock.groupParticipantsUpdate(groupJid, [userJid], "add"));

    const first = resp?.[0];
    const status = asStatusCode(first?.status);

    if (status === 200) {
      return { added: true, isInviteV4Sent: false, alreadyInGroup: false };
    }
    if (status === 409) {
      // Already in the group
      return { added: false, isInviteV4Sent: false, alreadyInGroup: true };
    }

    // 403 (privacy/policy) or unknown -> try invite flow
    const invited = await sendGroupInviteMessage(sock, userJid, groupJid, metadata);
    if (invited) return { added: false, isInviteV4Sent: true, alreadyInGroup: false };

    await safeNotifyFailure(
      item.request_id,
      `Falha ao adicionar ${phone} ao grupo ${groupJid}. status=${status ?? "unknown"}`,
      { item, groupName: metadata.subject ?? null },
    );
    return { added: false, isInviteV4Sent: false, alreadyInGroup: false };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(ansi.red(`Erro ao adicionar ${phone} ao grupo ${groupJid}: ${errorMsg}`));

    // Fallback to invitation even on exceptions
    try {
      const metadata = meta ?? (await safeGroupMetadata(sock, groupJid));
      const invited = await sendGroupInviteMessage(sock, userJid, groupJid, metadata);
      if (invited) return { added: false, isInviteV4Sent: true, alreadyInGroup: false };
    } catch {
      /* ignore */
    }

    await safeNotifyFailure(item.request_id, `Erro ao adicionar número ${phone} ao grupo ${groupJid}:\n${errorMsg}`, {
      item,
      groupName: meta?.subject ?? null,
    });
    return { added: false, isInviteV4Sent: false, alreadyInGroup: false };
  }
}

/** Sends a GroupInviteMessage directly to the contact (DM) */
async function sendGroupInviteMessage(
  sock: WASocket,
  userJid: string,
  groupJid: string,
  meta: GroupMetadata,
): Promise<boolean> {
  try {
    const code = await withTimeout(sock.groupInviteCode(groupJid));
    if (!code) return false;

    // Native WhatsApp invite message
    const groupInviteMessage: proto.Message.IGroupInviteMessage = {
      groupJid,
      inviteCode: code,
      groupName: meta?.subject ?? groupJid,
      caption: `Convite para o grupo "${meta?.subject ?? ""}"`,
    };
    // @ts-expect-error: groupInviteMessage is a valid proto message but not in AnyMessageContent type
    await withTimeout(sock.sendMessage(userJid, { groupInviteMessage }));
    console.log(ansi.green(`Invite enviado a ${userJid} para ${groupJid}`));
    return true;
  } catch (e) {
    const errMsg = String((e as Error)?.message ?? e);
    console.warn(`Falha ao enviar invite nativo a ${userJid}: ${errMsg}`);

    // Fallback: invite link as plain text (works across versions)
    try {
      const code = await withTimeout(sock.groupInviteCode(groupJid));
      if (!code) return false;
      const inviteUrl = `https://chat.whatsapp.com/${code}`;
      const text = `Convite para o grupo "${meta?.subject ?? groupJid}":\n${inviteUrl}`;
      await withTimeout(sock.sendMessage(userJid, { text }));
      console.log(ansi.green(`Link de convite enviado a ${userJid} para ${groupJid}`));
      return true;
    } catch (fallbackErr) {
      console.warn(
        `Fallback de link também falhou para ${userJid}: ${String((fallbackErr as Error)?.message ?? fallbackErr)}`,
      );
      return false;
    }
  }
}

/** Retrieves group metadata with simple error handling */
async function safeGroupMetadata(sock: WASocket, groupJid: string): Promise<GroupMetadata> {
  const meta = await withTimeout(sock.groupMetadata(groupJid));
  if (!meta) throw new Error(`Grupo ${groupJid} não encontrado`);
  return meta;
}

/** Checks if the bot itself is admin/superadmin in the group */
function checkIfSelfIsAdmin(sock: WASocket, meta: GroupMetadata): boolean {
  // Match the bot user against participants by numeric identity (jid/lid safe)
  const selfId = sock.user?.id;
  const selfAlt = (sock.user as { phoneNumber?: string } | undefined)?.phoneNumber ?? null;
  if (!selfId && !selfAlt) return false;
  return isParticipantAdmin(meta, selfId ?? null, { altId: selfAlt });
}

async function safeRecordEntry(
  registrationId: number,
  normalizedPhone: string,
  groupJid: string,
  status: MemberStatus,
) {
  try {
    await recordUserEntryToGroup(registrationId, normalizedPhone, groupJid, status);
  } catch (e) {
    console.warn(`recordUserEntryToGroup falhou: ${String((e as Error)?.message ?? e)}`);
  }
}

async function safeNotifyFailure(
  requestId: string | number,
  msg: string,
  ctx?: { item?: AddQueueItem; groupName?: string | null },
) {
  try {
    await sendAdditionFailedReason(Number(requestId), msg);
    // Fire-and-forget Telegram notification
    const payload = {
      requestId,
      registrationId: ctx?.item?.registration_id,
      groupId: ctx?.item?.group_id,
      groupName: ctx?.groupName ?? null,
      reason: msg,
    };
    await notifyAdditionFailure(payload);
  } catch (e) {
    console.warn(`sendAdditionFailedReason falhou: ${String((e as Error)?.message ?? e)}`);
  }
}

async function safeRegisterAttempt(requestId: string | number): Promise<void> {
  try {
    await registerWhatsappAddAttempt(Number(requestId));
  } catch (e) {
    console.warn(`registerWhatsappAddAttempt falhou: ${String((e as Error)?.message ?? e)}`);
  }
}

function baseResult(processed: number, total: number): AddProcessResult {
  return {
    added: false,
    inviteSent: false,
    alreadyInGroup: false,
    processedPhones: processed,
    totalPhones: total,
  };
}
