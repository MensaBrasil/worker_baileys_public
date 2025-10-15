import type { BaileysEventMap, ParticipantAction, WASocket } from "baileys";
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

type PendingAudioRequest = {
  expiresAt: number;
  timeoutId: NodeJS.Timeout;
};

const pendingAudioRequests = new Map<string, Map<string, PendingAudioRequest>>();

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

  if (!targetGroupName) {
    logger.info("Regra de primeiro contato desativada: FIRST_CONTACT_GROUP_NAME não definido.");
    return;
  }

  const normalizedTargetName = targetGroupName.toLowerCase();
  const groupNameCache = new Map<string, string>();
  const botJid = sock.user?.id;

  logger.info({ groupName: targetGroupName }, "Regra de primeiro contato ativada; aguardando novos participantes.");

  void getWelcomeAudioBuffer();

  sock.ev.on("group-participants.update", async (update) => {
    try {
      if (!update.id || !update.participants?.length) {
        return;
      }

      if (!shouldWelcome(update.action)) {
        return;
      }

      const participantNumbers = update.participants.map((jid) => jid.split("@")[0]);
      logger.info(
        {
          groupId: update.id,
          action: update.action,
          participants: participantNumbers,
        },
        "Evento recebido para regra de primeiro contato.",
      );

      const isTargetGroup = await ensureGroupCached(sock, update, normalizedTargetName, groupNameCache);
      if (!isTargetGroup) {
        logger.debug({ groupId: update.id }, "Atualização ignorada: grupo não corresponde ao alvo.");
        return;
      }

      const newMembers = update.participants.filter((jid) => jid !== botJid);
      if (!newMembers.length) {
        return;
      }

      for (const member of newMembers) {
        const lockResult = await tryAcquireFirstContactLock(update.id, member, WELCOME_DEDUP_TTL_MS);
        if (lockResult === false) {
          logger.info(
            { groupId: update.id, participant: member.split("@")[0] },
            "Mensagem de boas-vindas ignorada: outro worker já enviou recentemente.",
          );
          continue;
        }

        if (lockResult === null) {
          logger.warn(
            { groupId: update.id, participant: member.split("@")[0] },
            "Não foi possível verificar lock de primeiro contato; prosseguindo mesmo assim.",
          );
        }

        const mentionTag = `@${member.split("@")[0]}`;
        const welcomeText = [
          `Olá ${mentionTag}, você é um novo mensan! em breve um humano veterano te recepcionará. se você já é veterano, aproveita pra se apresentar de novo!`,
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

        await sock.sendMessage(update.id, {
          text: welcomeText,
          mentions: [member],
        });

        await sock.sendMessage(update.id, {
          text: formText,
        });

        logger.info({ groupId: update.id, participant: member.split("@")[0] }, "Mensagem de boas-vindas enviada.");

        const groupRequests = pendingAudioRequests.get(update.id) ?? new Map<string, PendingAudioRequest>();
        const existingRequest = groupRequests.get(member);
        if (existingRequest) {
          clearTimeout(existingRequest.timeoutId);
        }

        const timeoutId = setTimeout(() => {
          const requestsForGroup = pendingAudioRequests.get(update.id);
          if (!requestsForGroup) {
            return;
          }

          requestsForGroup.delete(member);
          if (!requestsForGroup.size) {
            pendingAudioRequests.delete(update.id);
          }
        }, AUDIO_REQUEST_WINDOW_MS);

        groupRequests.set(member, {
          expiresAt: Date.now() + AUDIO_REQUEST_WINDOW_MS,
          timeoutId,
        });
        pendingAudioRequests.set(update.id, groupRequests);

        logger.info(
          { groupId: update.id, participant: member.split("@")[0], expiresInMs: AUDIO_REQUEST_WINDOW_MS },
          "Janela para áudio de boas-vindas iniciada.",
        );
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

        const participantJid = message.key.participant ?? message.participant;
        if (!participantJid) {
          continue;
        }

        const request = requestsForGroup.get(participantJid);
        if (!request) {
          continue;
        }

        if (Date.now() > request.expiresAt) {
          clearTimeout(request.timeoutId);
          requestsForGroup.delete(participantJid);
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
            { groupId: remoteJid, participant: participantJid.split("@")[0] },
            "Áudio de boas-vindas indisponível ao responder solicitação.",
          );
        } else {
          await sock.sendMessage(remoteJid, {
            audio: audioBuffer,
            mimetype: "audio/mpeg",
          });

          logger.info(
            { groupId: remoteJid, participant: participantJid.split("@")[0] },
            "Áudio de boas-vindas enviado mediante solicitação.",
          );
        }

        clearTimeout(request.timeoutId);
        requestsForGroup.delete(participantJid);
        if (!requestsForGroup.size) {
          pendingAudioRequests.delete(remoteJid);
        }
      } catch (err) {
        logger.error({ err, message }, "Erro ao processar solicitação de áudio de boas-vindas");
      }
    }
  });
}
