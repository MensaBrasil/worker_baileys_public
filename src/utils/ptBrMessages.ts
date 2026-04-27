export const COMMUNICATION_REASONS = {
  membroInativo: "Membro Inativo",
  membroNaoEncontradoNoBanco: "Membro não encontrado no banco",
} as const;

export const MODERATION_REASONS = {
  conviteDeGrupo: "Link de convite de grupo",
  linkEncurtado: "Link encurtado",
  linkApiWhatsapp: "Link da API do WhatsApp",
  linkWaMe: "Link wa.me",
  idDeComunidade: "ID de comunidade bloqueada",
  linkDeComunidade: "Link de comunidade",
  link: "Link não permitido",
} as const;

export type CommunicationReason = (typeof COMMUNICATION_REASONS)[keyof typeof COMMUNICATION_REASONS];
export type ModerationReason = (typeof MODERATION_REASONS)[keyof typeof MODERATION_REASONS];

export function normalizeCommunicationReason(reason: string): string {
  const normalized = reason.trim().toLowerCase();

  if (normalized === "membro inativo") {
    return COMMUNICATION_REASONS.membroInativo;
  }

  if (normalized === "membro nao encontrado no banco" || normalized === "membro não encontrado no banco") {
    return COMMUNICATION_REASONS.membroNaoEncontradoNoBanco;
  }

  return reason;
}
