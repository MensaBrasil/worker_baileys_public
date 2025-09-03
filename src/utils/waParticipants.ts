import type { GroupMetadata, GroupParticipant } from "baileys";

// Extracts only the numeric phone part from a WhatsApp id/jid/lid string
// Examples:
//  - "447700900123:18@s.whatsapp.net" -> "447700900123"
//  - "447700900123@s.whatsapp.net" -> "447700900123"
//  - "163552992182285@lid" -> "163552992182285"
function extractDigits(idLike: string | undefined | null): string | null {
  if (!idLike) return null;
  const beforeAt = idLike.split("@")[0] ?? "";
  const beforeColon = beforeAt.split(":")[0] ?? beforeAt;
  const digits = beforeColon.replace(/\D/g, "");
  return digits || null;
}

/** Returns the group participant object for a given user id/jid/lid, matching by numeric identity. */
export function findParticipant(
  meta: GroupMetadata,
  userIdLike: string | undefined | null,
): GroupParticipant | undefined {
  const target = extractDigits(userIdLike);
  if (!target) return undefined;
  return meta.participants?.find((p: GroupParticipant) => {
    const did = extractDigits(p.id);
    const djid = extractDigits(p.jid);
    const dlid = extractDigits(p.lid);
    return did === target || djid === target || dlid === target;
  });
}

/** True if the given user (by id/jid/lid) is admin/superadmin in the group metadata. */
export function isParticipantAdmin(meta: GroupMetadata, userIdLike: string | undefined | null): boolean {
  const p = findParticipant(meta, userIdLike);
  // Baileys sets `admin` to string values like "admin" | "superadmin" (or null)
  return Boolean(p?.admin);
}
