import type { WAMessage, WASocket } from "baileys";
import { resolveContactNameByPhone } from "../db/pgsql";
import { hasConsentAutoReplyCooldown, registerConsentAutoReplySent } from "../db/redis";
import logger from "../utils/logger";
import { jidToPhone, resolveMessageSenderContext } from "./messageSender";

const CONSENT_MESSAGE = "Eu autorizo a minha inclusão em grupos de whatsapp da Mensa Brasil.";
const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";
const MIN_REPLY_DELAY_SECONDS = 6;
const MAX_REPLY_DELAY_SECONDS = 180;
const KNOWN_CONTACT_REPLY_NOTE =
  "Caso este número já esteja salvo em seus contatos, por favor, aguarde a inclusão nos grupos solicitados pelo site.";

type KnownContactReplyBuilder = (greeting: string, firstName: string) => string;
type UnknownContactReplyBuilder = (greeting: string) => string;

const KNOWN_CONTACT_REPLY_VARIATIONS: KnownContactReplyBuilder[] = [
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Por favor, adicione este número do Zelador como contato no WhatsApp para que possamos concluir a sua autorização de inclusão nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Para finalizarmos sua autorização de entrada nos grupos da Mensa Brasil, salve este número do Zelador nos seus contatos do WhatsApp, por favor.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Salve este número do Zelador como contato no WhatsApp para que a sua autorização de inclusão nos grupos da Mensa Brasil seja concluída.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Precisamos que você adicione este número do Zelador aos seus contatos do WhatsApp para concluir sua autorização nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Por gentileza, inclua este número do Zelador nos contatos do WhatsApp para seguirmos com a sua autorização nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Para completar o processo, adicione este número do Zelador como contato no WhatsApp e poderemos concluir a autorização nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Falta apenas salvar este número do Zelador no WhatsApp para concluirmos a sua autorização de inclusão nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Adicione este número do Zelador aos seus contatos do WhatsApp para que possamos finalizar sua autorização de participação nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Para prosseguirmos com a autorização nos grupos da Mensa Brasil, salve este número do Zelador como contato no WhatsApp.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Por favor, registre este número do Zelador na sua agenda do WhatsApp para concluirmos sua autorização nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Para que a autorização seja concluída, adicione este número do Zelador como contato no WhatsApp.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Salve este número do Zelador nos seus contatos do WhatsApp; assim poderemos concluir sua inclusão nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Precisamos confirmar este canal pelo WhatsApp. Adicione este número do Zelador como contato para finalizarmos sua autorização nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Por favor, mantenha este número do Zelador salvo nos contatos do WhatsApp para que a autorização nos grupos da Mensa Brasil possa ser concluída.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Adicione o número do Zelador à sua lista de contatos do WhatsApp para concluirmos o seu pedido de inclusão nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Para finalizar a liberação para os grupos da Mensa Brasil, salve este número do Zelador como contato no WhatsApp.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Por gentileza, salve este número do Zelador no WhatsApp. Depois disso, poderemos concluir sua autorização nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Este é o número do Zelador. Adicione-o aos seus contatos do WhatsApp para concluirmos sua autorização nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Para concluir a autorização de inclusão nos grupos da Mensa Brasil, precisamos que este número do Zelador esteja salvo nos seus contatos do WhatsApp.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Salve este contato do Zelador no WhatsApp para que possamos seguir com a conclusão da sua autorização nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Por favor, adicione este contato do Zelador no WhatsApp e a sua autorização de inclusão nos grupos da Mensa Brasil poderá ser finalizada.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Para dar continuidade à autorização nos grupos da Mensa Brasil, salve este número do Zelador nos contatos do WhatsApp.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Inclua este número do Zelador na sua agenda do WhatsApp para que possamos concluir a autorização nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Antes de concluirmos sua autorização nos grupos da Mensa Brasil, adicione este número do Zelador como contato no WhatsApp, por favor.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Para fechar esta etapa, salve este número do Zelador no WhatsApp e poderemos concluir sua autorização nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Sua autorização está quase concluída. Por favor, adicione este número do Zelador como contato no WhatsApp para finalizarmos.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Por favor, salve este número do Zelador no WhatsApp para concluirmos a autorização de inclusão nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Para que possamos concluir a inclusão nos grupos da Mensa Brasil, adicione este número do Zelador aos seus contatos do WhatsApp.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Adicione este número do Zelador como contato no WhatsApp, por favor; é necessário para finalizar sua autorização nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Salve este número do Zelador na sua lista de contatos do WhatsApp para que a autorização nos grupos da Mensa Brasil seja concluída.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Precisamos que este número do Zelador esteja nos seus contatos do WhatsApp para completar a autorização de inclusão nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Por favor, adicione este número do Zelador no WhatsApp para que possamos terminar a sua autorização nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Para liberar a conclusão da autorização nos grupos da Mensa Brasil, salve este número do Zelador como contato no WhatsApp.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Este contato do Zelador precisa estar salvo no seu WhatsApp para concluirmos sua autorização de inclusão nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Salve o número do Zelador nos contatos do WhatsApp e poderemos finalizar a sua autorização para os grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Por favor, adicione este número como contato do Zelador no WhatsApp para concluir sua autorização de inclusão nos grupos da Mensa Brasil.`,
  (greeting, firstName) =>
    `${greeting}, ${firstName}. Para completar sua autorização nos grupos da Mensa Brasil, adicione este número do Zelador aos contatos do WhatsApp.`,
];

const UNKNOWN_CONTACT_REPLY_VARIATIONS: UnknownContactReplyBuilder[] = [
  (greeting) =>
    `${greeting}. *Este número não foi encontrado no cadastro.* Por favor, revise o cadastro em https://membro.mensa.org.br/cadastro/editar e adicione este telefone. Caso você seja um responsável por menor de idade, adicione o telefone no campo *telefone do responsável legal* e tente enviar a autorização novamente.`,
  (greeting) =>
    `${greeting}. *Não localizamos este número no cadastro.* Revise seus dados em https://membro.mensa.org.br/cadastro/editar e inclua este telefone. Se você for responsável por menor de idade, informe-o no campo *telefone do responsável legal* e envie a autorização novamente.`,
  (greeting) =>
    `${greeting}. *Este telefone não consta no cadastro.* Acesse https://membro.mensa.org.br/cadastro/editar e adicione este número. Caso seja responsável legal por menor de idade, use o campo *telefone do responsável legal* e tente de novo.`,
  (greeting) =>
    `${greeting}. *Não encontramos este telefone no cadastro.* Atualize o cadastro em https://membro.mensa.org.br/cadastro/editar com este número. Para responsável por menor de idade, preencha o campo *telefone do responsável legal* e reenvie a autorização.`,
  (greeting) =>
    `${greeting}. *Este número ainda não aparece no cadastro.* Por favor, revise https://membro.mensa.org.br/cadastro/editar e inclua este telefone. Se for responsável por menor de idade, adicione-o em *telefone do responsável legal* e tente novamente.`,
  (greeting) =>
    `${greeting}. *Não foi possível localizar este número no cadastro.* Inclua este telefone em https://membro.mensa.org.br/cadastro/editar. Caso represente menor de idade, use o campo *telefone do responsável legal* e envie a autorização outra vez.`,
  (greeting) =>
    `${greeting}. *Este número não está vinculado ao cadastro.* Atualize seus dados em https://membro.mensa.org.br/cadastro/editar com este telefone. Se você é responsável por menor de idade, preencha *telefone do responsável legal* e tente novamente.`,
  (greeting) =>
    `${greeting}. *Não achamos este telefone no cadastro.* Por favor, acesse https://membro.mensa.org.br/cadastro/editar e adicione este número. Responsáveis por menores devem usar o campo *telefone do responsável legal* antes de reenviar a autorização.`,
  (greeting) =>
    `${greeting}. *Este contato não foi encontrado no cadastro.* Revise o cadastro em https://membro.mensa.org.br/cadastro/editar e informe este telefone. Se for responsável legal por menor de idade, use *telefone do responsável legal* e tente outra vez.`,
  (greeting) =>
    `${greeting}. *O número usado aqui não consta no cadastro.* Atualize o telefone em https://membro.mensa.org.br/cadastro/editar. Caso seja responsável por menor de idade, preencha *telefone do responsável legal* e envie a autorização novamente.`,
  (greeting) =>
    `${greeting}. *Não conseguimos confirmar este número no cadastro.* Adicione este telefone em https://membro.mensa.org.br/cadastro/editar. Para responsável por menor de idade, use o campo *telefone do responsável legal* e tente de novo.`,
  (greeting) =>
    `${greeting}. *Este número não foi identificado no cadastro.* Por favor, inclua este telefone em https://membro.mensa.org.br/cadastro/editar. Se você responde por menor de idade, use *telefone do responsável legal* e reenvie a autorização.`,
  (greeting) =>
    `${greeting}. *Este telefone não está cadastrado.* Acesse https://membro.mensa.org.br/cadastro/editar e adicione este número. Caso seja responsável legal por menor de idade, informe-o em *telefone do responsável legal* e tente novamente.`,
  (greeting) =>
    `${greeting}. *Não localizamos cadastro com este número.* Revise https://membro.mensa.org.br/cadastro/editar e adicione o telefone usado aqui. Responsáveis por menores devem preencher *telefone do responsável legal* e reenviar a autorização.`,
  (greeting) =>
    `${greeting}. *Este número não está associado ao cadastro.* Por favor, atualize o telefone em https://membro.mensa.org.br/cadastro/editar. Se for responsável por menor de idade, use *telefone do responsável legal* e tente outra vez.`,
  (greeting) =>
    `${greeting}. *O telefone desta conversa não foi encontrado no cadastro.* Inclua-o em https://membro.mensa.org.br/cadastro/editar. Caso você seja responsável legal por menor de idade, adicione-o no campo *telefone do responsável legal* e envie a autorização novamente.`,
  (greeting) =>
    `${greeting}. *Ainda não encontramos este número no cadastro.* Atualize seus dados em https://membro.mensa.org.br/cadastro/editar com este telefone. Para menor de idade, o responsável deve preencher *telefone do responsável legal* e tentar novamente.`,
  (greeting) =>
    `${greeting}. *Este número precisa estar no cadastro para seguirmos.* Revise https://membro.mensa.org.br/cadastro/editar e adicione este telefone. Se você é responsável por menor de idade, use *telefone do responsável legal* e reenvie a autorização.`,
  (greeting) =>
    `${greeting}. *Não foi encontrado cadastro para este telefone.* Por favor, acesse https://membro.mensa.org.br/cadastro/editar e inclua este número. Responsáveis legais por menores devem preencher *telefone do responsável legal* e tentar de novo.`,
  (greeting) =>
    `${greeting}. *Este telefone não está registrado no cadastro.* Atualize em https://membro.mensa.org.br/cadastro/editar e adicione este número. Se representar menor de idade, use o campo *telefone do responsável legal* e envie novamente.`,
  (greeting) =>
    `${greeting}. *Não encontramos este número entre os telefones cadastrados.* Revise https://membro.mensa.org.br/cadastro/editar e inclua este telefone. Caso seja responsável por menor de idade, preencha *telefone do responsável legal* e tente novamente.`,
  (greeting) =>
    `${greeting}. *Este número não aparece nos dados cadastrais.* Por favor, adicione-o em https://membro.mensa.org.br/cadastro/editar. Se você é responsável legal por menor de idade, use *telefone do responsável legal* e reenvie a autorização.`,
  (greeting) =>
    `${greeting}. *Não conseguimos validar este número pelo cadastro.* Atualize o cadastro em https://membro.mensa.org.br/cadastro/editar com este telefone. Para responsável por menor de idade, preencha *telefone do responsável legal* e tente outra vez.`,
  (greeting) =>
    `${greeting}. *Este telefone ainda não está cadastrado.* Inclua este número em https://membro.mensa.org.br/cadastro/editar. Caso seja responsável legal por menor de idade, use o campo *telefone do responsável legal* e envie a autorização novamente.`,
  (greeting) =>
    `${greeting}. *O número informado nesta conversa não foi localizado.* Revise https://membro.mensa.org.br/cadastro/editar e adicione este telefone. Responsáveis por menores devem preencher *telefone do responsável legal* antes de reenviar.`,
  (greeting) =>
    `${greeting}. *Este número não está disponível no cadastro.* Por favor, atualize https://membro.mensa.org.br/cadastro/editar com este telefone. Se for responsável por menor de idade, use *telefone do responsável legal* e tente novamente.`,
  (greeting) =>
    `${greeting}. *Não localizamos este contato nos dados cadastrados.* Acesse https://membro.mensa.org.br/cadastro/editar e inclua este telefone. Caso seja responsável legal por menor de idade, preencha *telefone do responsável legal* e reenvie a autorização.`,
  (greeting) =>
    `${greeting}. *Este número precisa ser adicionado ao cadastro.* Por favor, revise https://membro.mensa.org.br/cadastro/editar e informe este telefone. Se você responde por menor de idade, use *telefone do responsável legal* e tente de novo.`,
  (greeting) =>
    `${greeting}. *Não foi possível encontrar este telefone nos seus dados.* Atualize o cadastro em https://membro.mensa.org.br/cadastro/editar. Para responsável legal por menor de idade, adicione o número em *telefone do responsável legal* e tente novamente.`,
  (greeting) =>
    `${greeting}. *Este número não foi reconhecido no cadastro.* Inclua-o em https://membro.mensa.org.br/cadastro/editar e envie a autorização novamente. Caso seja responsável por menor de idade, use o campo *telefone do responsável legal*.`,
  (greeting) =>
    `${greeting}. *Não há cadastro vinculado a este telefone.* Por favor, acesse https://membro.mensa.org.br/cadastro/editar e adicione este número. Responsáveis legais por menores devem usar *telefone do responsável legal* e reenviar a autorização.`,
  (greeting) =>
    `${greeting}. *Este telefone não foi localizado para autorização.* Atualize o cadastro em https://membro.mensa.org.br/cadastro/editar com este número. Se você é responsável por menor de idade, preencha *telefone do responsável legal* e tente outra vez.`,
  (greeting) =>
    `${greeting}. *Não encontramos este telefone como cadastrado.* Revise https://membro.mensa.org.br/cadastro/editar e informe este número. Caso seja responsável legal por menor de idade, use *telefone do responsável legal* e envie novamente.`,
  (greeting) =>
    `${greeting}. *Este número não consta entre os telefones do cadastro.* Por favor, atualize https://membro.mensa.org.br/cadastro/editar. Se for responsável por menor de idade, adicione-o em *telefone do responsável legal* e reenvie a autorização.`,
  (greeting) =>
    `${greeting}. *Não conseguimos relacionar este número ao cadastro.* Inclua este telefone em https://membro.mensa.org.br/cadastro/editar. Para responsável por menor de idade, use *telefone do responsável legal* e tente novamente.`,
  (greeting) =>
    `${greeting}. *Este telefone não foi encontrado nos dados da Mensa Brasil.* Atualize seu cadastro em https://membro.mensa.org.br/cadastro/editar com este número. Caso seja responsável legal por menor de idade, preencha *telefone do responsável legal* e envie de novo.`,
  (greeting) =>
    `${greeting}. *Não localizamos este número para concluir a autorização.* Por favor, adicione este telefone em https://membro.mensa.org.br/cadastro/editar. Se você for responsável por menor de idade, use o campo *telefone do responsável legal* e tente novamente.`,
];

function getTextContent(message: WAMessage): string {
  return (
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    message.message?.imageMessage?.caption ||
    message.message?.videoMessage?.caption ||
    ""
  );
}

function getSaoPauloHour(date = new Date()): number {
  const hour = new Intl.DateTimeFormat("pt-BR", {
    hour: "numeric",
    hour12: false,
    timeZone: SAO_PAULO_TIME_ZONE,
  }).format(date);

  return Number.parseInt(hour, 10);
}

function getGreeting(date = new Date()): string {
  const hour = getSaoPauloHour(date);

  if (hour >= 5 && hour < 12) return "Bom dia";
  if (hour >= 12 && hour < 18) return "Boa tarde";
  return "Boa noite";
}

function getFirstName(fullName: string): string {
  return fullName.trim().replace(/\s+/g, " ").split(" ")[0] || fullName.trim();
}

function randomIntInclusive(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom<T>(items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error("Cannot pick a random item from an empty list.");
  }

  const item = items[randomIntInclusive(0, items.length - 1)];
  if (item == null) {
    throw new Error("Failed to pick a random item.");
  }

  return item;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildKnownContactReply(fullName: string): string {
  const firstName = getFirstName(fullName);
  return `${pickRandom(KNOWN_CONTACT_REPLY_VARIATIONS)(getGreeting(), firstName)} ${KNOWN_CONTACT_REPLY_NOTE}`;
}

function buildUnknownContactReply(): string {
  return pickRandom(UNKNOWN_CONTACT_REPLY_VARIATIONS)(getGreeting());
}

export async function handleConsentAutoReply(sock: WASocket, message: WAMessage): Promise<boolean> {
  if (message.key.fromMe) return false;

  const textContent = getTextContent(message).trim();
  if (textContent !== CONSENT_MESSAGE) return false;

  const senderContext = await resolveMessageSenderContext(sock, message);
  if (!senderContext?.isDirectMessage) return false;

  const senderPhone = jidToPhone(senderContext.targetJid);
  if (!senderPhone) {
    logger.info(
      {
        messageId: message.key.id,
        senderJid: senderContext.senderJid,
        targetJid: senderContext.targetJid,
      },
      "[consent-auto-reply] Mensagem ignorada: nao foi possivel resolver telefone do remetente",
    );
    return false;
  }

  if (await hasConsentAutoReplyCooldown(senderPhone)) {
    logger.info(
      {
        phone: senderPhone,
      },
      "[consent-auto-reply] Resposta automatica ignorada: telefone em cooldown",
    );
    return true;
  }

  const contactName = await resolveContactNameByPhone(senderPhone);
  const replyText = contactName ? buildKnownContactReply(contactName) : buildUnknownContactReply();
  const replyDelaySeconds = randomIntInclusive(MIN_REPLY_DELAY_SECONDS, MAX_REPLY_DELAY_SECONDS);

  logger.info(
    {
      phone: senderPhone,
      foundInDatabase: Boolean(contactName),
      replyDelaySeconds,
    },
    "[consent-auto-reply] Aguardando antes de enviar resposta automatica",
  );

  await sleep(replyDelaySeconds * 1000);

  await sock.sendMessage(senderContext.targetJid, { text: replyText });
  await registerConsentAutoReplySent(senderPhone);

  logger.info(
    {
      phone: senderPhone,
      foundInDatabase: Boolean(contactName),
      replyDelaySeconds,
    },
    "[consent-auto-reply] Resposta automatica enviada",
  );

  return true;
}
