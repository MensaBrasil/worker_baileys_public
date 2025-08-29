import { config as configDotenv } from "dotenv";
import type { WASocket, GroupMetadata } from "baileys";
import { proto } from "baileys";
import { AddAttemptResult, AddProcessResult, MemberPhone, Worker } from "../types/addTaskTypes";
import type { MemberStatus } from "../types/pgsqlTypes";
import { AddQueueItem } from "../types/redisTypes";
import { phoneToUserJid, asGroupJid } from "../utils/phoneToJid";
import { delaySecs } from "../utils/delay";
import {
  getMemberPhoneNumbers,
  recordUserEntryToGroup,
  registerWhatsappAddFulfilled,
  registerWhatsappAddAttempt,
  getWhatsappAuthorization,
  sendAdditionFailedReason,
} from "../db/pgsql";
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

// Backoff window after a successful add/invite (seconds)
const ADD_DELAY = parseEnvNumber("ADD_DELAY");
const DELAY_OFFSET = parseEnvNumber("DELAY_OFFSET");

// Minimal jitter used when we made no progress (seconds)
const IDLE_MIN = parseEnvNumber("IDLE_MIN", 3);
const IDLE_MAX = parseEnvNumber("IDLE_MAX", 6);

// Maximum time we will wait for a single networked Baileys call (ms)
const CALL_TIMEOUT_MS = parseEnvNumber("CALL_TIMEOUT_MS", 15_000);

// Number of retries for transient failures (not for 4xx logic outcomes)
const MAX_RETRIES = parseEnvNumber("MAX_RETRIES", 2);

// ---------- small utils ----------
const ansi = {
  cyan: (s: string) => `\x1b[96m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[92m${s}\x1b[0m`,
};

function nowIso() {
  return new Date().toISOString();
}

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

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        const backoff = Math.min(ADD_DELAY, 2 ** attempt) + Math.random();
        console.warn(
          ansi.yellow(
            `[${label}] transient error, retry ${attempt + 1}/${MAX_RETRIES} in ~${backoff.toFixed(1)}s: ${String((e as Error)?.message ?? e)}`,
          ),
        );
        await delaySecs(backoff, backoff);
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
  const item: AddQueueItem | null = await getFromAddQueue();
  if (!item) {
    console.log("[addTask] addQueue vazia.");
    return baseResult(0, 0);
  }

  const groupJid = asGroupJid(item.group_id);
  const tag = `req=${item.request_id} reg=${item.registration_id} grp=${groupJid}`;
  console.log(ansi.cyan(`[${nowIso()}] Processando ${tag}`));

  // 1) metadata & admin check (single fetch)
  const meta = await safeGroupMetadata(sock, groupJid);
  if (!checkIfSelfIsAdmin(sock, meta)) {
    const msg = `Bot não é admin no grupo ${meta.subject ?? groupJid}.`;
    console.log(ansi.red(msg));
    await safeNotifyFailure(item.request_id, msg);
    return baseResult(0, 0);
  }

  // 2) phone list
  const memberPhones: MemberPhone[] = await getMemberPhoneNumbers(Number(item.registration_id));
  if (!memberPhones?.length) {
    const msg = `Nenhum telefone encontrado para registration_id ${item.registration_id}.`;
    console.log(ansi.red(msg));
    await safeNotifyFailure(item.request_id, msg);
    return baseResult(0, 0);
  }

  // De-dupe by normalized last 8 digits (common auth key)
  const seen = new Set<string>();
  const uniquePhones = memberPhones.filter((m) => {
    const n = normalizeDigits(m?.phone);
    if (!n) return false;
    const k = n.slice(-8);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const results: AddProcessResult = {
    added: false,
    inviteSent: false,
    alreadyInGroup: false,
    processedPhones: 0,
    totalPhones: uniquePhones.length,
  };

  let anyAuthorized = false;

  for (const phone of uniquePhones) {
    // Legacy rule: only legal representatives in RJB groups
    if (item.group_type === "RJB" && !phone.is_legal_rep) {
      console.log(ansi.yellow(`Ignorando ${phone.phone}: não é representante legal (RJB).`));
      continue;
    }

    const normalized = normalizeDigits(phone.phone);
    if (!normalized) continue;

    // Authorization: last 8 digits + worker.id
    const authKey = normalized.slice(-8);
    const authorized = await getWhatsappAuthorization(authKey, worker.id);
    if (!authorized?.phone_number) {
      console.log(ansi.red(`Telefone ${normalized} não autorizado.`));
      continue;
    }
    anyAuthorized = true;

    const attempt = await addMemberToGroup(sock, authorized.phone_number, groupJid, item, meta);

    if (attempt.added || attempt.isInviteV4Sent || attempt.alreadyInGroup) {
      // Log per successful outcome (idempotent DB should tolerate duplicates)
      await safeRecordEntry(Number(item.registration_id), normalized, groupJid, "Active");

      if (attempt.added) results.added = true;
      if (attempt.isInviteV4Sent) results.inviteSent = true;
      if (attempt.alreadyInGroup) results.alreadyInGroup = true;
      results.processedPhones++;

      // Backoff: use env-based delay only on successful add; otherwise small jitter
      if (attempt.added) await delaySecs(ADD_DELAY, DELAY_OFFSET);
      else await delaySecs(IDLE_MIN, IDLE_MAX);
    } else {
      // No progress for this phone -> tiny jitter to avoid tight loops
      await delaySecs(IDLE_MIN, IDLE_MAX);
    }
  }

  if (!anyAuthorized) {
    const msg = `Nenhum telefone autorizado para registration_id ${item.registration_id}.`;
    console.log(ansi.red(msg));
    await safeNotifyFailure(item.request_id, msg);
  }

  // 4) Mark attempt/fulfilled at request scope
  if (results.added || results.inviteSent || results.alreadyInGroup) {
    await registerWhatsappAddFulfilled(item.request_id);
    console.log(ansi.green(`Request ${item.request_id} cumprida — ${results.processedPhones}/${results.totalPhones}`));
    // Optional courtesy delay to spread out requests if we actually added someone at any point
    if (results.added) await delaySecs(ADD_DELAY, DELAY_OFFSET);
    else await delaySecs(IDLE_MIN, IDLE_MAX);
  } else {
    await registerWhatsappAddAttempt(item.request_id);
    console.log(ansi.red(`Não foi possível cumprir request ${item.request_id} (reg=${item.registration_id}).`));
    await delaySecs(IDLE_MIN, IDLE_MAX);
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

    const resp = await withTimeout(
      withRetry(() => sock.groupParticipantsUpdate(groupJid, [userJid], "add"), "groupParticipantsUpdate"),
    );

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

    await safeNotifyFailure(item.request_id, `Erro ao adicionar número ${phone} ao grupo ${groupJid}:\n${errorMsg}`);
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
    const code = await withTimeout(withRetry(() => sock.groupInviteCode(groupJid), "groupInviteCode"));
    if (!code) return false;

    // Native WhatsApp invite message
    const groupInviteMessage: proto.Message.IGroupInviteMessage = {
      groupJid,
      inviteCode: code,
      groupName: meta?.subject ?? groupJid,
      caption: `Convite para o grupo "${meta?.subject ?? ""}"`,
    };
    // @ts-expect-error: groupInviteMessage is a valid proto message but not in AnyMessageContent type
    await withTimeout(withRetry(() => sock.sendMessage(userJid, { groupInviteMessage }), "sendMessage:groupInvite"));
    console.log(ansi.green(`Invite enviado a ${userJid} para ${groupJid}`));
    return true;
  } catch (e) {
    const errMsg = String((e as Error)?.message ?? e);
    console.warn(`Falha ao enviar invite nativo a ${userJid}: ${errMsg}`);

    // Fallback: invite link as plain text (works across versions)
    try {
      const code = await withTimeout(withRetry(() => sock.groupInviteCode(groupJid), "groupInviteCode:fallback"));
      if (!code) return false;
      const inviteUrl = `https://chat.whatsapp.com/${code}`;
      const text = `Convite para o grupo "${meta?.subject ?? groupJid}":\n${inviteUrl}`;
      await withTimeout(withRetry(() => sock.sendMessage(userJid, { text }), "sendMessage:textInvite"));
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
  const meta = await withTimeout(withRetry(() => sock.groupMetadata(groupJid), "groupMetadata"));
  if (!meta) throw new Error(`Grupo ${groupJid} não encontrado`);
  return meta;
}

/** Checks if the bot itself is admin/superadmin in the group */
function checkIfSelfIsAdmin(sock: WASocket, meta: GroupMetadata): boolean {
  const meBare = sock.user?.id?.split(":")[0];
  const me = meBare ? `${meBare}@s.whatsapp.net` : undefined;
  if (!me) return false;
  const self = meta.participants?.find((p) => p.id === me);
  return Boolean(self?.admin);
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

async function safeNotifyFailure(requestId: string | number, msg: string) {
  try {
    await sendAdditionFailedReason(Number(requestId), msg);
  } catch (e) {
    console.warn(`sendAdditionFailedReason falhou: ${String((e as Error)?.message ?? e)}`);
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
