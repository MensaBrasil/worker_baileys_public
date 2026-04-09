import type { GroupMetadata } from "baileys";
import type { MensaGroupType } from "../types/checkGroupTypes";

function normalizeGroupName(name: string | undefined | null): string {
  return String(name ?? "").trim();
}

export function checkGroupTypeByName(name: string | undefined | null): MensaGroupType {
  const normalized = normalizeGroupName(name);

  if (/^R\.\s?JB\s*\|/i.test(normalized)) {
    return "RJB";
  }

  if (
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
