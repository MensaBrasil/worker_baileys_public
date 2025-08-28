export type GroupType = "RJB" | "DEFAULT" | string;

export interface Worker {
  id: number;
  phone: string;
}

export interface MemberPhone {
  phone: string;
  is_legal_rep?: boolean;
}

export interface AddAttemptResult {
  added: boolean;
  isInviteV4Sent: boolean;
  alreadyInGroup: boolean;
}

export interface AddProcessResult {
  added: boolean;
  inviteSent: boolean;
  alreadyInGroup: boolean;
  processedPhones: number;
  totalPhones: number;
}
