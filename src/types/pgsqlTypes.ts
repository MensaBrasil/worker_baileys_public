export type ISODateString = string;

/** Required runtime env for the DB connection */
export interface PgEnv {
  PG_DB_HOST: string;
  PG_DB_PORT: string;
  PG_DB_NAME: string;
  PG_DB_USER: string;
  PG_DB_PASSWORD: string;
}

/** Narrow status to the only valid values the code expects */
export type MemberStatus = "Active" | "Inactive";

export interface MemberPhone {
  phone: string;
  is_legal_rep: boolean;
}

export interface WhatsAppWorker {
  id: number;
  worker_phone: string;
}

export interface WhatsAppAuthorization {
  auth_id: number;
  phone_number: string;
  worker_id: number;
  created_at?: ISODateString;
  updated_at?: ISODateString;
}

/** Input shape for upsert — no auth_id because DB assigns it */
export interface WhatsAppAuthorizationInput {
  phone_number: string;
  worker_id: number;
}
