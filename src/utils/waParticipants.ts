import type { GroupMetadata, GroupParticipant } from "baileys";

type ParticipantLike = GroupParticipant & {
  phoneNumber?: string;
  jid?: string;
  lid?: string;
  user?: string;
};

function extractDigits(idLike: string | { user?: string } | undefined | null): string | null {
  if (!idLike) return null;
  if (typeof idLike === "object") {
    if ("user" in idLike && typeof idLike.user === "string") {
      return extractDigits(idLike.user);
    }
    return null;
  }
  const beforeAt = idLike.split("@")[0] ?? "";
  const beforeColon = beforeAt.split(":")[0] ?? beforeAt;
  const digits = beforeColon.replace(/\D/g, "");
  return digits || null;
}

function collectCandidateDigits(p: ParticipantLike | string): Set<string> {
  const digits = new Set<string>();
  const push = (val: string | { user?: string } | undefined | null) => {
    const d = extractDigits(val);
    if (d) digits.add(d);
  };

  if (typeof p === "string") {
    push(p);
    return digits;
  }

  push(p.phoneNumber);
  push(p.id);
  push((p as { jid?: string }).jid);
  push(p.lid);
  push((p as { user?: string }).user);

  return digits;
}

function buildTargetDigits(userIdLike: string | undefined | null, altId?: string | null): Set<string> {
  const targets = new Set<string>();
  const push = (val: string | undefined | null) => {
    const d = extractDigits(val);
    if (d) targets.add(d);
  };
  push(userIdLike ?? null);
  push(altId ?? null);
  return targets;
}

/** Returns the group participant object for a given user id/jid/lid/phoneNumber, matching by numeric identity. */
export function findParticipant(
  meta: GroupMetadata,
  userIdLike: string | undefined | null,
  opts?: { altId?: string | null },
): GroupParticipant | undefined {
  const targets = buildTargetDigits(userIdLike, opts?.altId);
  if (!targets.size) return undefined;
  return meta.participants?.find((p: GroupParticipant) => {
    const candidates = collectCandidateDigits(p as ParticipantLike);
    for (const t of targets) {
      if (candidates.has(t)) return true;
    }
    return false;
  });
}

/** True if the given user (by id/jid/lid/phoneNumber) is admin/superadmin in the group metadata. */
export function isParticipantAdmin(
  meta: GroupMetadata,
  userIdLike: string | undefined | null,
  opts?: { altId?: string | null },
): boolean {
  const p = findParticipant(meta, userIdLike, opts);
  const role = (p as { admin?: unknown } | undefined)?.admin;
  return role === "admin" || role === "superadmin";
}
