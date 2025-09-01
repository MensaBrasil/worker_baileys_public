import type { GroupMetadata } from "baileys";
import type { MensaGroupType } from "../types/checkGroupTypes";

export function checkGroupTypeByName(name: string | undefined | null): MensaGroupType {
  const n = String(name ?? "");
  if (/^M[\s.]*JB/i.test(n)) {
    return "M.JB";
  } else if (/^R[\s.]*JB/i.test(n)) {
    return "R.JB";
  } else if (/^(?!R[\s.]*JB)(?!M[\s.]*JB)JB/i.test(n)) {
    return "JB";
  } else if (/^OrgMB/i.test(n)) {
    return "OrgMB";
  } else if (/^MB/i.test(n)) {
    return "MB";
  }
  return "NotMensa";
}

export function checkGroupTypeByMeta(meta: GroupMetadata | null | undefined): MensaGroupType {
  if (!meta) return "NotAGroup";
  return checkGroupTypeByName(meta.subject);
}
