export type GroupType = "MB" | "RJB" | "NOT_MANAGED" | string;

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
  alreadyInGroup: boolean;
}

export interface AddProcessResult {
  added: boolean;
  alreadyInGroup: boolean;
  processedPhones: number;
  totalPhones: number;
}
