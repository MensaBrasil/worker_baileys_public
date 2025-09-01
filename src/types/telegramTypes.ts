export interface AdditionFailurePayload {
  requestId: number | string;
  registrationId?: number | string;
  groupId?: string;
  groupName?: string | null;
  reason: string;
}

export interface FlaggedLogPayload {
  time: string;
  sender: string;
  groupName: string;
  message: string;
  categoriesInline: string;
  modalitiesLine?: string;
}

export interface RemovalFailurePayload {
  phone: string;
  registrationId: number | string;
  groupId: string;
  groupName?: string | null;
  communityId?: string | null;
  removalReason: string; // business reason
  failureReason?: string | null; // technical failure reason
}
