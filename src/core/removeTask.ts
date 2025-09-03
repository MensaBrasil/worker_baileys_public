import { config as configDotenv } from "dotenv";
import type { WASocket, GroupMetadata } from "baileys";

import { getFromRemoveQueue } from "../db/redis";
import { recordUserExitFromGroup } from "../db/pgsql";
import { notifyRemovalFailure } from "../utils/telegram";
import { delaySecs } from "../utils/delay";
import { phoneToUserJid, asGroupJid } from "../utils/phoneToJid";
import { findParticipant } from "../utils/waParticipants";

configDotenv({ path: ".env" });

// ---------- env & small utils ----------
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

// Reuse the same delay configuration used for add flow
const MIN_DELAY = parseEnvNumber("MIN_DELAY");
const MAX_DELAY = parseEnvNumber("MAX_DELAY");
const DELAY_JITTER = parseEnvNumber("DELAY_JITTER", 0);

// Maximum time per Baileys call (ms)
const CALL_TIMEOUT_MS = parseEnvNumber("CALL_TIMEOUT_MS", 15_000);

const ansi = {
  cyan: (s: string) => `\x1b[96m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[92m${s}\x1b[0m`,
  white: (s: string) => `\x1b[1;37m${s}\x1b[0m`,
};

function asStatusCode(status: unknown): number | null {
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

export interface RemovalAttemptResult {
  removed: boolean;
  removalType: "Community" | "Group" | null;
  groupName: string | null;
  errorReason?: string | null;
}

/**
 * Processes one item from removeQueue and returns success or failure.
 */
export async function processRemoveQueue(sock: WASocket): Promise<boolean> {
  const item = await getFromRemoveQueue();
  if (!item) {
    console.log("[removeTask] removeQueue vazia.");
    return false;
  }

  const { registration_id, phone, groupId, reason, communityId } = item;
  console.log(
    ansi.cyan(
      `Processando remoção do membro reg=${registration_id} (${phone}) do grupo ${groupId}` +
        (communityId ? ` (e comunidade ${communityId})` : ""),
    ),
  );

  const result = await removeMemberFromGroup(sock, phone, groupId, communityId || undefined);

  if (result.removed && result.removalType === "Community") {
    console.log(
      ansi.green(`Membro ${phone} removido da comunidade ${communityId} -> ${result.groupName} | motivo: ${reason}`),
    );
    await safeRecordExit(phone, communityId!, reason);
    await delaySecs(MIN_DELAY, MAX_DELAY, DELAY_JITTER);
    return true;
  }

  if (result.removed && result.removalType === "Group") {
    console.log(ansi.green(`Membro ${phone} removido do grupo ${groupId} -> ${result.groupName} | motivo: ${reason}`));
    await safeRecordExit(phone, groupId, reason);
    await delaySecs(MIN_DELAY, MAX_DELAY, DELAY_JITTER);
    return true;
  }

  console.log(
    ansi.red(
      `Falha ao remover ${phone} do grupo/comunidade (${groupId}${communityId ? ", " + communityId : ""}). ` +
        (result.errorReason ? `Motivo técnico: ${result.errorReason}` : ""),
    ),
  );
  // Notify removal failure to Telegram (fire-and-forget)
  try {
    await notifyRemovalFailure({
      phone,
      registrationId: item.registration_id,
      groupId,
      groupName: result.groupName,
      communityId: communityId || undefined,
      removalReason: reason,
      failureReason: result.errorReason || undefined,
    });
  } catch {
    // ignore notification errors
  }
  return false;
}

/**
 * Removes a member from a WhatsApp group and optionally from a community.
 * Attempts community first (if provided), then the group.
 */
export async function removeMemberFromGroup(
  sock: WASocket,
  phone: string,
  groupId: string,
  communityId?: string,
): Promise<RemovalAttemptResult> {
  const userJid = phoneToUserJid(phone);

  try {
    if (communityId) {
      const communityJid = asGroupJid(communityId);
      const community = await safeGroupMetadata(sock, communityJid);
      if (!community) {
        const msg = `Comunidade ${communityId} não encontrada.`;
        console.log(ansi.yellow(`${msg} Pulando remoção na comunidade.`));
        return { removed: false, removalType: null, groupName: null, errorReason: msg };
      } else {
        const participant = findParticipant(community, userJid);
        if (!participant) {
          const msg = `Participante ${phone} não encontrado na comunidade ${community.subject ?? communityJid} (${communityId}).`;
          console.log(ansi.yellow(msg));
          return { removed: false, removalType: null, groupName: community.subject ?? communityJid, errorReason: msg };
        } else if (participant.admin) {
          const msg = `Participante ${phone} é admin na comunidade; não é possível remover.`;
          console.log(ansi.yellow(`${msg} (${community.subject ?? communityJid}).`));
          return { removed: false, removalType: null, groupName: community.subject ?? communityJid, errorReason: msg };
        } else {
          console.log(
            ansi.white(`Tentando remover ${phone} da comunidade ${community.subject ?? communityJid} (${communityId})`),
          );
          const ok = await tryParticipantsUpdate(sock, communityJid, userJid, "remove");
          if (ok) {
            return {
              removed: true,
              removalType: "Community",
              groupName: community.subject ?? communityJid,
              errorReason: null,
            };
          } else {
            return {
              removed: false,
              removalType: null,
              groupName: community.subject ?? communityJid,
              errorReason: "Falha na operação de remoção na comunidade (participantsUpdate).",
            };
          }
        }
      }
    }

    const groupJid = asGroupJid(groupId);
    const group = await safeGroupMetadata(sock, groupJid);
    if (!group) {
      const msg = `Grupo ${groupId} não encontrado.`;
      console.log(ansi.red(msg));
      return { removed: false, removalType: null, groupName: null, errorReason: msg };
    }

    const participant = findParticipant(group, userJid);
    if (!participant) {
      const msg = `Participante ${phone} não encontrado no grupo ${group.subject ?? groupJid}.`;
      console.log(ansi.red(msg));
      return { removed: false, removalType: null, groupName: group.subject ?? groupJid, errorReason: msg };
    }

    if (participant.admin) {
      const msg = `Participante ${phone} é admin no grupo; não é possível remover.`;
      console.log(ansi.yellow(`${msg} (${group.subject ?? groupJid}).`));
      return { removed: false, removalType: null, groupName: group.subject ?? groupJid, errorReason: msg };
    }

    console.log(ansi.white(`Tentando remover ${phone} do grupo ${group.subject ?? groupJid} (${groupJid})`));
    const ok = await tryParticipantsUpdate(sock, groupJid, userJid, "remove");
    if (ok) {
      return { removed: true, removalType: "Group", groupName: group.subject ?? groupJid, errorReason: null };
    }

    return {
      removed: false,
      removalType: null,
      groupName: group.subject ?? groupJid,
      errorReason: "Falha na operação de remoção no grupo (participantsUpdate).",
    };
  } catch (error) {
    const errMsg = (error as Error)?.stack || String(error);
    console.error(ansi.red(`Erro ao remover ${phone} de ${groupId}: ${errMsg}`));
    return { removed: false, removalType: null, groupName: null, errorReason: errMsg };
  }
}

/** Wrapper around groupMetadata with timeout */
async function safeGroupMetadata(sock: WASocket, groupJid: string): Promise<GroupMetadata> {
  return await withTimeout(sock.groupMetadata(groupJid));
}

/** Performs groupParticipantsUpdate and returns true on success */
async function tryParticipantsUpdate(
  sock: WASocket,
  groupJid: string,
  userJid: string,
  action: "add" | "remove" | "demote" | "promote",
): Promise<boolean> {
  try {
    const resp = await withTimeout(sock.groupParticipantsUpdate(groupJid, [userJid], action));
    // Baileys may return an array of statuses or void; treat absence of errors as success.
    if (Array.isArray(resp) && resp.length > 0) {
      const status = asStatusCode(resp[0]?.status);
      return status === 200 || status === 207; // 207: multi-status OK in some versions
    }
    return true;
  } catch {
    return false;
  }
}

async function safeRecordExit(phone: string, groupId: string, reason: string): Promise<void> {
  try {
    await recordUserExitFromGroup(phone, groupId, reason);
  } catch (e) {
    console.warn(`recordUserExitFromGroup falhou: ${String((e as Error)?.message ?? e)}`);
  }
}
