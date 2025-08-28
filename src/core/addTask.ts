import "dotenv/config";
import type { WASocket, GroupMetadata } from "baileys";
import { proto } from "baileys";
import { AddAttemptResult, AddProcessResult, MemberPhone, Worker } from "../types/addTaskTypes";
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

const ADD_DELAY = Number(process.env.ADD_DELAY ?? 15);
const DELAY_OFFSET = Number(process.env.DELAY_OFFSET ?? 3);

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
  console.log(
    `\x1b[96mProcessando pedido request_id=${item.request_id} reg=${item.registration_id} group=${groupJid}\x1b[0m`,
  );

  // 1) Check if admin
  const meta = await safeGroupMetadata(sock, groupJid);
  const isAdmin = checkIfSelfIsAdmin(sock, meta);
  if (!isAdmin) {
    const msg = `Bot não é admin no grupo ${meta.subject ?? groupJid}.`;
    console.log(`\x1b[31m${msg}\x1b[0m`);
    await sendAdditionFailedReason(item.request_id, msg);
    return baseResult(0, 0);
  }

  // 2) Phones from the registration
  const memberPhones: MemberPhone[] = await getMemberPhoneNumbers(parseInt(item.registration_id));
  if (!memberPhones?.length) {
    const msg = `Nenhum telefone encontrado para registration_id ${item.registration_id}.`;
    console.log(`\x1b[31m${msg}\x1b[0m`);
    await sendAdditionFailedReason(item.request_id, msg);
    return baseResult(0, 0);
  }

  const results: AddProcessResult = {
    added: false,
    inviteSent: false,
    alreadyInGroup: false,
    processedPhones: 0,
    totalPhones: memberPhones.length,
  };

  // 3) Attempt loop
  let anyAuthorized = false;
  for (const phone of memberPhones) {
    if (!phone?.phone) continue;

    // Legacy rule: only legal representatives in RJB groups
    if (item.group_type === "RJB" && !phone.is_legal_rep) {
      console.log(`\x1b[33mIgnorando ${phone.phone}: não é representante legal (RJB).\x1b[0m`);
      continue;
    }

    const normalized = phone.phone.replace(/\D/g, "");
    // Authorization: last 8 digits + worker.id
    const authorized = await getWhatsappAuthorization(normalized.slice(-8), worker.id);
    if (!authorized?.phone_number) {
      console.log(`\x1b[31mTelefone ${normalized} não autorizado.\x1b[0m`);
      continue;
    }
    anyAuthorized = true;

    // Executes inclusion
    const attempt = await addMemberToGroup(sock, authorized.phone_number, groupJid, item, meta);
    if (attempt.added || attempt.isInviteV4Sent || attempt.alreadyInGroup) {
      await recordUserEntryToGroup(parseInt(item.registration_id), normalized, groupJid, "Active");
      if (attempt.added) {
        results.added = true;
        results.processedPhones++;
      }
      if (attempt.isInviteV4Sent) {
        results.inviteSent = true;
        results.processedPhones++;
      }
      if (attempt.alreadyInGroup) {
        results.alreadyInGroup = true;
        results.processedPhones++;
      }

      // backoff between attempts: use env-based delay only on successful add; otherwise, a small random delay (3–9s)
      if (attempt.added) {
        await delaySecs(ADD_DELAY, DELAY_OFFSET);
      } else {
        await delaySecs(3, 6);
      }
    } else {
      // addition failed without invite/already-in-group: mini random delay
      await delaySecs(3, 6);
    }
  }

  // If there were no authorized numbers at all, notify reason
  if (!anyAuthorized) {
    const msg = `Nenhum telefone autorizado para registration_id ${item.registration_id}.`;
    console.log(`\x1b[31m${msg}\x1b[0m`);
    await sendAdditionFailedReason(item.request_id, msg);
  }

  // 4) Marks fulfilled/attempt — if at least one successful add, invite sent, or already in group
  if (results.added || results.inviteSent || results.alreadyInGroup) {
    await registerWhatsappAddFulfilled(item.request_id);
    console.log(
      `\x1b[92mRequest ${item.request_id} cumprida — ${results.processedPhones}/${results.totalPhones}\x1b[0m`,
    );
    if (results.added) {
      await delaySecs(ADD_DELAY, DELAY_OFFSET);
    } else {
      // addition failed without invite/already-in-group: mini random delay
      await delaySecs(3, 6);
    }
  } else {
    await registerWhatsappAddAttempt(item.request_id);
    console.log(`\x1b[31mNão foi possível cumprir request ${item.request_id} (reg=${item.registration_id}).\x1b[0m`);
    // No progress at all: mini random delay to avoid tight loops
    await delaySecs(3, 6);
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
  try {
    const userJid = phoneToUserJid(phone);
    const metadata = meta ?? (await safeGroupMetadata(sock, groupJid));

    console.log(`Tentando adicionar ${phone} em ${groupJid} (${metadata.subject})`);
    const resp = await sock.groupParticipantsUpdate(groupJid, [userJid], "add");

    // The response is an array with status/jid; status usually "200", "403", "409"
    const first = resp?.[0];
    const status = String(first?.status ?? "");
    if (status === "200") {
      return { added: true, isInviteV4Sent: false, alreadyInGroup: false };
    }
    if (status === "409") {
      // already in the group
      return { added: false, isInviteV4Sent: false, alreadyInGroup: true };
    }

    // For other errors (e.g., 403), try sending an invite
    const invited = await sendGroupInviteMessage(sock, userJid, groupJid, metadata);
    if (invited) {
      return { added: false, isInviteV4Sent: true, alreadyInGroup: false };
    }

    // Failed without being able to send an invite
    await sendAdditionFailedReason(
      item.request_id,
      `Falha ao adicionar ${phone} ao grupo ${groupJid}. status=${status}`,
    );
    return { added: false, isInviteV4Sent: false, alreadyInGroup: false };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31mErro ao adicionar ${phone} ao grupo ${groupJid}: ${errorMsg}\x1b[0m`);

    // Attempts fallback to invitation even in case of exception
    try {
      const userJid = phoneToUserJid(phone);
      const metadata = meta ?? (await safeGroupMetadata(sock, groupJid));
      const invited = await sendGroupInviteMessage(sock, userJid, groupJid, metadata);
      if (invited) {
        return { added: false, isInviteV4Sent: true, alreadyInGroup: false };
      }
    } catch {
      // ignore
    }

    await sendAdditionFailedReason(
      item.request_id,
      `Erro ao adicionar número ${phone} ao grupo ${groupJid}:\n${errorMsg}`,
    );
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
    const code = await sock.groupInviteCode(groupJid);
    if (!code) return false;

    // Native WhatsApp invite message
    const groupInviteMessage: proto.Message.IGroupInviteMessage = {
      groupJid,
      inviteCode: code,
      groupName: meta?.subject ?? groupJid,
      caption: `Convite para o grupo "${meta?.subject ?? ""}"`,
    };
    // @ts-expect-error: groupInviteMessage is a valid proto message but not in AnyMessageContent type
    await sock.sendMessage(userJid, { groupInviteMessage });
    console.log(`\x1b[32mInvite enviado a ${userJid} para ${groupJid}\x1b[0m`);
    return true;
  } catch (e) {
    console.warn(`Falha ao enviar invite a ${userJid}: ${String((e as Error)?.message ?? e)}`);
    return false;
  }
}

/** Retrieves group metadata with simple error handling */
async function safeGroupMetadata(sock: WASocket, groupJid: string): Promise<GroupMetadata> {
  const meta = await sock.groupMetadata(groupJid);
  if (!meta) throw new Error(`Grupo ${groupJid} não encontrado`);
  return meta;
}
/** Checks if the bot itself is admin/superadmin in the group */
function checkIfSelfIsAdmin(sock: WASocket, meta: GroupMetadata): boolean {
  const me = sock.user?.id ? sock.user.id.split(":")[0] + "@s.whatsapp.net" : undefined;
  if (!me) return false;
  const self = meta.participants?.find((p) => p.id === me);
  // admin can be 'admin' or 'superadmin'
  return Boolean(self?.admin);
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
