import type { BaileysEventMap, ParticipantAction, WASocket } from "baileys";
import { promises as fs } from "node:fs";
import path from "node:path";

import logger from "../utils/logger";

const WELCOME_AUDIO_PATH = path.resolve(process.cwd(), "primeiro_contato.mp3");
let cachedWelcomeAudio: Buffer | null = null;
let welcomeAudioPromise: Promise<Buffer | null> | null = null;
const WELCOME_ACTIONS: ReadonlySet<ParticipantAction> = new Set<ParticipantAction>(["add"]);

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
    logger.warn(
      { err, groupId: update.id },
      "Falha ao obter metadata do grupo para regra de primeiro contato",
    );
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

  logger.info(
    { groupName: targetGroupName },
    "Regra de primeiro contato ativada; aguardando novos participantes.",
  );

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

      const audioBuffer = await getWelcomeAudioBuffer();
      if (!audioBuffer) {
        logger.warn(
          { audioPath: WELCOME_AUDIO_PATH },
          "Áudio de boas-vindas indisponível; enviando somente mensagem de texto.",
        );
      }

      for (const member of newMembers) {
        const mentionTag = `@${member.split("@")[0]}`;
        const welcomeText = [
          `Oi ${mentionTag}, novo Mensan, tudo bem?`,
          "Seja bem vindo (a)!",
          "Se quiser se apresentar, temos um formulário de sugestão",
          "",
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

        logger.info(
          { groupId: update.id, participant: member.split("@")[0] },
          "Mensagem de boas-vindas enviada.",
        );

        if (audioBuffer) {
          await sock.sendMessage(update.id, {
            audio: audioBuffer,
            mimetype: "audio/mpeg",
          });

          logger.info(
            { groupId: update.id, participant: member.split("@")[0] },
            "Áudio de boas-vindas enviado.",
          );
        }
      }
    } catch (err) {
      logger.error({ err, update }, "Erro ao executar regra de primeiro contato");
    }
  });
}
