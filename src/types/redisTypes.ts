/** ---------- Domain types ---------- */
export interface AddQueueItem {
  type: string;
  request_id: number;
  registration_id: string;
  group_id: string;
  group_type: string;
}

export interface RemoveQueueItem {
  type: string;
  registration_id: string;
  groupId: string;
  phone: string;
  reason: string;
  communityId: string | null;
}

/** ---------- Queue keys ---------- */
export const enum QueueKey {
  Add = "addQueue",
  Remove = "removeQueue",
}
