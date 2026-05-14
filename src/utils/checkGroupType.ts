import type { GroupMetadata } from "baileys";
import type { MensaGroupType } from "../types/checkGroupTypes";

function normalizeGroupName(name: string | undefined | null): string {
  return String(name ?? "").trim();
}

const explicitMBGroupNames = new Set([
  "Mensampa Regional",
  "Mensa Ribeirão Preto, São Carlos, Araraquara e redondezas",
  "Mensa São José dos Campos e região",
]);

const explicitRJBGroupNames = new Set([
  "Avisos Mensa JB C.O/N",
  "Avisos Mensa JB Nordeste",
  "Avisos Mensa JB SP CIDADE",
  "Avisos Mensa JB SP ESTADO",
  "Avisos Mensa JB SUDESTE",
]);

export function isMBWomenGroup(name: string | undefined | null): boolean {
  return normalizeGroupName(name) === "MB | Mulheres";
}

export function checkGroupTypeByName(name: string | undefined | null): MensaGroupType {
  const normalized = normalizeGroupName(name);

  if (explicitRJBGroupNames.has(normalized) || /^R\.\s?JB\s*\|/i.test(normalized)) {
    return "RJB";
  }

  if (
    explicitMBGroupNames.has(normalized) ||
    /^Mensa\b.*\bRegional\b/i.test(normalized) ||
    /^Avisos Mensa\b/i.test(normalized) ||
    /^MB\s*\|/i.test(normalized)
  ) {
    return "MB";
  }

  return "NotManaged";
}

export function checkGroupTypeByMeta(meta: GroupMetadata | null | undefined): MensaGroupType {
  if (!meta) return "NotAGroup";
  return checkGroupTypeByName(meta.subject);
}
