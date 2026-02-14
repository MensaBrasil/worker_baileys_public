import type { BaileysEventMap, GroupParticipant, ParticipantAction, WASocket } from "baileys";
import { promises as fs } from "node:fs";
import path from "node:path";

import { tryAcquireFirstContactLock } from "../db/redis";
import logger from "../utils/logger";

const WELCOME_AUDIO_PATH = path.resolve(process.cwd(), "primeiro_contato.mp3");
let cachedWelcomeAudio: Buffer | null = null;
let welcomeAudioPromise: Promise<Buffer | null> | null = null;
const WELCOME_ACTIONS: ReadonlySet<ParticipantAction> = new Set<ParticipantAction>(["add"]);
const AUDIO_REQUEST_WINDOW_MS = 10 * 60 * 60 * 1000;
const WELCOME_DEDUP_TTL_MS = AUDIO_REQUEST_WINDOW_MS;
const MENSAMPA_REGIONAL_GROUP_NAME = "Mensampa Regional";
const MENSAMPA_REGIONAL_WELCOME_TEXT = [
  "Seja muito bem-vindo(a)! 😊",
  "",
  "Que bom ter você aqui!",
  "Fique à vontade para se apresentar, puxar assunto, compartilhar seus interesses, falar do cotidiano, fazer amizades ou simplesmente acompanhar as conversas. Este espaço é construído por todos nós, no ritmo de cada um.",
  "",
  "Fique atento(a): estamos sempre fixando mensagens com temas, avisos e conteúdos interessantes para debate. Vale a pena conferir de vez em quando 😉",
  "",
  "E não se esqueça de ler as regras disponíveis na descrição do grupo. Elas são importantes para manter um ambiente leve, respeitoso e agradável para todos.",
  "",
  "Qualquer dúvida ou necessidade de orientação, é só chamar um administrador no privado.",
  "",
  "Sinta-se em casa e aproveite o grupo!",
].join("\n");

type PendingAudioRequest = {
  expiresAt: number;
  timeoutId: NodeJS.Timeout;
};

const pendingAudioRequests = new Map<string, Map<string, PendingAudioRequest>>();

/** @internal Exported for testing */
export function normalizeParticipantId(participant: GroupParticipant | string | undefined | null): string | null {
  if (!participant) return null;
  if (typeof participant === "string") return participant;
  // Prefer phoneNumber (PN format) when available, since id may be LID format
  const phoneNumber = (participant as { phoneNumber?: unknown }).phoneNumber;
  if (typeof phoneNumber === "string" && phoneNumber) return phoneNumber;
  const id = (participant as { id?: unknown }).id;
  if (typeof id === "string") return id;
  const jid = (participant as { jid?: unknown }).jid;
  if (typeof jid === "string") return jid;
  const lid = (participant as { lid?: unknown }).lid;
  if (typeof lid === "string") return lid;
  const user = (participant as { user?: unknown }).user;
  if (typeof user === "string") return user;
  return null;
}

/**
 * Extracts the numeric portion of a JID for use as a stable map key.
 * Works for both PN ("5511999@s.whatsapp.net") and LID ("123:0@lid") formats.
 * This ensures audio request lookups match regardless of JID format.
 */
/** @internal Exported for testing */
export function jidToDigitsKey(jid: string): string {
  const beforeAt = jid.split("@")[0] ?? jid;
  const beforeColon = beforeAt.split(":")[0] ?? beforeAt;
  const digits = beforeColon.replace(/\D/g, "");
  return digits || jid;
}

/** @internal Exported for testing */
export function participantTag(participantId: string | null): string {
  if (!participantId) return "";
  const base = participantId.split("@")[0] ?? participantId;
  return base;
}

async function getWelcomeAudioBuffer(): Promise<Buffer | null> {
  if (cachedWelcomeAudio) {
    return cachedWelcomeAudio;
  }

  if (!welcomeAudioPromise) {
    welcomeAudioPromise = fs
      .readFile(WELCOME_AUDIO_PATH)
      .then((buffer) => {
        cachedWelcomeAudio = buffer;
        logger.info(
          { audioPath: WELCOME_AUDIO_PATH, bytes: buffer.length },
          "Áudio de boas-vindas carregado com sucesso.",
        );
        return buffer;
      })
      .catch((err) => {
        logger.error({ err, audioPath: WELCOME_AUDIO_PATH }, "Falha ao carregar áudio de boas-vindas");
        return null;
      });
  }

  const result = await welcomeAudioPromise;
  if (result) {
    cachedWelcomeAudio = result;
  }
  return result;
}

type GroupParticipantsUpdate = BaileysEventMap["group-participants.update"];

function matchesTargetGroup(
  update: GroupParticipantsUpdate,
  normalizedTargetName: string,
  cache: Map<string, string>,
): boolean {
  const cachedName = cache.get(update.id);

  return cachedName === normalizedTargetName;
}

async function ensureGroupCached(
  sock: WASocket,
  update: GroupParticipantsUpdate,
  normalizedTargetName: string,
  cache: Map<string, string>,
): Promise<boolean> {
  if (matchesTargetGroup(update, normalizedTargetName, cache)) {
    return true;
  }

  try {
    const meta = await sock.groupMetadata(update.id);
    const normalized = meta.subject?.trim().toLowerCase() ?? "";
    cache.set(update.id, normalized);
    return normalized === normalizedTargetName;
  } catch (err) {
    logger.warn({ err, groupId: update.id }, "Falha ao obter metadata do grupo para regra de primeiro contato");
    return false;
  }
}

function shouldWelcome(action: GroupParticipantsUpdate["action"] | undefined): boolean {
  if (!action) {
    return false;
  }

  return WELCOME_ACTIONS.has(action);
}

export function registerFirstContactWelcome(sock: WASocket): void {
  const targetGroupName = process.env.FIRST_CONTACT_GROUP_NAME?.trim();
  const normalizedMensampaGroupName = MENSAMPA_REGIONAL_GROUP_NAME.toLowerCase();

  if (!targetGroupName) {
    logger.info("Regra de primeiro contato desativada: FIRST_CONTACT_GROUP_NAME não definido.");
  }

  logger.info({ groupName: MENSAMPA_REGIONAL_GROUP_NAME }, "Regra de boas-vindas Mensampa Regional ativada.");

  const normalizedTargetName = targetGroupName?.toLowerCase();
  const groupNameCache = new Map<string, string>();
  const botJid = sock.user?.id;

  if (targetGroupName) {
    logger.info({ groupName: targetGroupName }, "Regra de primeiro contato ativada; aguardando novos participantes.");
  }

  if (targetGroupName) {
    void getWelcomeAudioBuffer();
  }

  sock.ev.on("group-participants.update", async (update) => {
    try {
      if (!update.id || !update.participants?.length) {
        return;
      }

      if (!shouldWelcome(update.action)) {
        return;
      }

      const participantIds = update.participants
        .map((p) => normalizeParticipantId(p))
        .filter((id): id is string => Boolean(id));
      const participantNumbers = participantIds.map((jid) => participantTag(jid));
      logger.info(
        {
          groupId: update.id,
          action: update.action,
          participants: participantNumbers,
        },
        "Evento recebido para regra de primeiro contato.",
      );

      const isFirstContactGroup = normalizedTargetName
        ? await ensureGroupCached(sock, update, normalizedTargetName, groupNameCache)
        : false;
      const isMensampaGroup = await ensureGroupCached(sock, update, normalizedMensampaGroupName, groupNameCache);
      if (!isFirstContactGroup && !isMensampaGroup) {
        logger.debug({ groupId: update.id }, "Atualização ignorada: grupo não corresponde ao alvo.");
        return;
      }

      const newMembers = participantIds.filter((jid) => jid !== botJid);
      if (!newMembers.length) {
        return;
      }

      for (const member of newMembers) {
        const lockResult = await tryAcquireFirstContactLock(update.id, member, WELCOME_DEDUP_TTL_MS);
        if (lockResult === false) {
          logger.info(
            { groupId: update.id, participant: participantTag(member) },
            "Mensagem de boas-vindas ignorada: outro worker já enviou recentemente.",
          );
          continue;
        }

        if (lockResult === null) {
          logger.warn(
            { groupId: update.id, participant: participantTag(member) },
            "Não foi possível verificar lock de primeiro contato; envio ignorado.",
          );
          continue;
        }

        if (isFirstContactGroup) {
          const mentionTag = `@${participantTag(member)}`;
          const welcomeText = [
            `Olá ${mentionTag}, você é um novo mensan? em breve um humano veterano te recepcionará. se você já é veterano, aproveita pra se apresentar de novo!`,
            "",
            "ah, segue um formulário de sugestão caso queira se apresentar.",
            "",
            "enquanto espera, gostaria de ouvir uma música de boas-vindas? (é uma piadinha apenas). se sim, digite 1.",
          ].join("\n");

          const formText = [
            "⟬📝⟭▸ Nome (pronome?): ",
            "⟬🗓⟭▸ Idade:",
            "⟬🧠⟭▸ Tempo de Mensa:",
            "⟬🔎⟭▸ Como conheceu a Mensa:",
            "⟬🤓⟭▸ Quais suas expectativas sobre a Mensa (ou os mensans):",
            "⟬🏡⟭▸ Cidade e Estado:",
            "⟬💼⟭▸ Profissão:",
            "⟬👁⟭▸ Hiperfoco atual:",
            "⟬📢⟭▸ Há mais algo que gostaria de compartilhar?",
            "",
            "escolha uma:",
            "⟬🌿⟭▸ Fale sobre Coentro:",
            "⟬🧟‍♂⟭▸ Apocalipse de sua preferência:",
            "⟬🤤⟭▸ O que é bom mas é ruim? E algo que é ruim, mas é bom?",
          ].join("\n");

          try {
            await sock.sendMessage(update.id, {
              text: welcomeText,
              mentions: [member],
            });
            logger.info(
              { groupId: update.id, participant: participantTag(member) },
              "Mensagem de boas-vindas (texto) enviada.",
            );
          } catch (err) {
            logger.error(
              { err, groupId: update.id, participant: participantTag(member) },
              "Falha ao enviar mensagem de boas-vindas (texto).",
            );
          }

          try {
            await sock.sendMessage(update.id, {
              text: formText,
            });
            logger.info(
              { groupId: update.id, participant: participantTag(member) },
              "Mensagem de boas-vindas (formulário) enviada.",
            );
          } catch (err) {
            logger.error(
              { err, groupId: update.id, participant: participantTag(member) },
              "Falha ao enviar mensagem de boas-vindas (formulário).",
            );
          }

          const memberKey = jidToDigitsKey(member);
          const groupRequests = pendingAudioRequests.get(update.id) ?? new Map<string, PendingAudioRequest>();
          const existingRequest = groupRequests.get(memberKey);
          if (existingRequest) {
            clearTimeout(existingRequest.timeoutId);
          }

          const timeoutId = setTimeout(() => {
            const requestsForGroup = pendingAudioRequests.get(update.id);
            if (!requestsForGroup) {
              return;
            }

            requestsForGroup.delete(memberKey);
            if (!requestsForGroup.size) {
              pendingAudioRequests.delete(update.id);
            }
          }, AUDIO_REQUEST_WINDOW_MS);

          groupRequests.set(memberKey, {
            expiresAt: Date.now() + AUDIO_REQUEST_WINDOW_MS,
            timeoutId,
          });
          pendingAudioRequests.set(update.id, groupRequests);

          logger.info(
            { groupId: update.id, participant: participantTag(member), memberKey, expiresInMs: AUDIO_REQUEST_WINDOW_MS },
            "Janela para áudio de boas-vindas iniciada.",
          );
        }

        if (isMensampaGroup) {
          await sock.sendMessage(update.id, {
            text: MENSAMPA_REGIONAL_WELCOME_TEXT,
          });

          logger.info(
            { groupId: update.id, participant: participantTag(member) },
            "Mensagem de boas-vindas Mensampa Regional enviada.",
          );
        }
      }
    } catch (err) {
      logger.error({ err, update }, "Erro ao executar regra de primeiro contato");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const message of messages) {
      try {
        if (message.key.fromMe) {
          continue;
        }

        const remoteJid = message.key.remoteJid;
        if (!remoteJid) {
          continue;
        }

        const requestsForGroup = pendingAudioRequests.get(remoteJid);
        if (!requestsForGroup || !requestsForGroup.size) {
          continue;
        }

        const participantJidRaw = message.key.participant ?? message.participant ?? null;
        if (!participantJidRaw) {
          continue;
        }

        const participantJid = String(participantJidRaw);
        const participantKey = jidToDigitsKey(participantJid);
        const request = requestsForGroup.get(participantKey);
        if (!request) {
          logger.debug(
            { groupId: remoteJid, participantJid, participantKey, pendingKeys: [...requestsForGroup.keys()] },
            "Áudio: participante não encontrado no mapa de pendentes.",
          );
          continue;
        }

        if (Date.now() > request.expiresAt) {
          clearTimeout(request.timeoutId);
          requestsForGroup.delete(participantKey);
          if (!requestsForGroup.size) {
            pendingAudioRequests.delete(remoteJid);
          }
          continue;
        }

        const textContent = (
          message.message?.conversation ||
          message.message?.extendedTextMessage?.text ||
          message.message?.imageMessage?.caption ||
          message.message?.videoMessage?.caption ||
          ""
        ).trim();

        if (textContent !== "1") {
          continue;
        }

        const audioBuffer = await getWelcomeAudioBuffer();
        if (!audioBuffer) {
          logger.warn(
            { groupId: remoteJid, participant: participantTag(participantJid) },
            "Áudio de boas-vindas indisponível ao responder solicitação.",
          );
        } else {
          await sock.sendMessage(remoteJid, {
            audio: audioBuffer,
            mimetype: "audio/mpeg",
          });

          logger.info(
            { groupId: remoteJid, participant: participantTag(participantJid) },
            "Áudio de boas-vindas enviado mediante solicitação.",
          );
        }

        clearTimeout(request.timeoutId);
        requestsForGroup.delete(participantKey);
        if (!requestsForGroup.size) {
          pendingAudioRequests.delete(remoteJid);
        }
      } catch (err) {
        logger.error({ err, message }, "Erro ao processar solicitação de áudio de boas-vindas");
      }
    }
  });
}
