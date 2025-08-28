import { config as configDotenv } from "dotenv";
import { Pool } from "pg";
import type {
  PgEnv,
  MemberPhone,
  MemberStatus,
  WhatsAppAuthorization,
  WhatsAppAuthorizationInput,
  WhatsAppWorker,
} from "../types/pgsqlTypes.ts";

configDotenv({ path: ".env" });

/** Ensure required env vars exist and coerce types */
function readPgEnv(): PgEnv & { PG_DB_PORT: string } {
  const { PG_DB_HOST, PG_DB_PORT, PG_DB_NAME, PG_DB_USER, PG_DB_PASSWORD } = process.env as NodeJS.ProcessEnv &
    Partial<PgEnv>;

  const missing = [
    ["PG_DB_HOST", PG_DB_HOST],
    ["PG_DB_PORT", PG_DB_PORT],
    ["PG_DB_NAME", PG_DB_NAME],
    ["PG_DB_USER", PG_DB_USER],
    ["PG_DB_PASSWORD", PG_DB_PASSWORD],
  ].filter(([, val]) => !val);

  if (missing.length) {
    const keys = missing.map(([k]) => k).join(", ");
    throw new Error(`Missing required DB env vars: ${keys}`);
  }

  return {
    PG_DB_HOST: PG_DB_HOST!,
    PG_DB_PORT: PG_DB_PORT!,
    PG_DB_NAME: PG_DB_NAME!,
    PG_DB_USER: PG_DB_USER!,
    PG_DB_PASSWORD: PG_DB_PASSWORD!,
  };
}

/** Singleton pool (don’t create multiple connections across hot paths) */
let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;

  const env = readPgEnv();
  const port = Number.parseInt(env.PG_DB_PORT, 10);
  if (Number.isNaN(port)) {
    throw new Error(`PG_DB_PORT must be a number, got "${env.PG_DB_PORT}"`);
  }

  pool = new Pool({
    host: env.PG_DB_HOST,
    port,
    database: env.PG_DB_NAME,
    user: env.PG_DB_USER,
    password: env.PG_DB_PASSWORD,
    // You can tune pool sizing here if needed, e.g. max, idleTimeoutMillis, etc.
  });

  // Optional: surface unexpected pool errors early
  pool.on("error", (err) => {
    // Don’t crash the process; log and let the caller decide policy.
    console.error("[pg] Pool error:", err);
  });

  return pool;
}

/**
 * Updates member_groups to record a user's exit from a group.
 */
export async function recordUserExitFromGroup(phone_number: string, group_id: string, reason: string): Promise<void> {
  const query = `
    UPDATE member_groups
    SET updated_at = NOW(), exit_date = NOW(), removal_reason = $3
    WHERE phone_number = $1 AND group_id = $2 AND exit_date IS NULL;
  `;
  await getPool().query(query, [phone_number, group_id, reason]);
}

/**
 * Records a user entry into a group.
 */
export async function recordUserEntryToGroup(
  registration_id: number,
  phone_number: string,
  group_id: string,
  status: MemberStatus,
): Promise<void> {
  const query = `
    INSERT INTO member_groups (registration_id, phone_number, group_id, status)
    VALUES ($1, $2, $3, $4);
  `;
  await getPool().query(query, [registration_id, phone_number, group_id, status]);
}

/**
 * Retrieves all phone numbers for a registration, marking legal-rep phones.
 */
export async function getMemberPhoneNumbers(registration_id: number): Promise<MemberPhone[]> {
  const query = `
    SELECT
      phone_number AS phone,
      FALSE AS is_legal_rep
    FROM phones
    WHERE registration_id = $1

    UNION ALL

    SELECT
      phone AS phone,
      TRUE AS is_legal_rep
    FROM legal_representatives
    WHERE registration_id = $1

    UNION ALL

    SELECT
      alternative_phone AS phone,
      TRUE AS is_legal_rep
    FROM legal_representatives
    WHERE registration_id = $1
      AND alternative_phone IS NOT NULL;
  `;
  const { rows } = await getPool().query(query, [registration_id]);
  // Rows already align to MemberPhone shape via the SELECT aliases
  return rows as MemberPhone[];
}

/**
 * Marks a group request as fulfilled.
 */
export async function registerWhatsappAddFulfilled(id: number): Promise<void> {
  const query = `
    UPDATE group_requests
    SET fulfilled = true, last_attempt = NOW(), updated_at = NOW()
    WHERE id = $1;
  `;
  await getPool().query(query, [id]);
}

/**
 * Increments attempt count and updates last_attempt.
 */
export async function registerWhatsappAddAttempt(id: number): Promise<void> {
  const query = `
    UPDATE group_requests
    SET no_of_attempts = no_of_attempts + 1,
        last_attempt = NOW(),
        updated_at = NOW()
    WHERE id = $1;
  `;
  await getPool().query(query, [id]);
}

/**
 * Retrieves all WhatsApp workers (return only stable columns).
 */
export async function getAllWhatsAppWorkers(): Promise<WhatsAppWorker[]> {
  const query = "SELECT id, worker_phone FROM whatsapp_workers;";
  const { rows } = await getPool().query(query);
  return rows as WhatsAppWorker[];
}

/**
 * Retrieves all WhatsApp authorization records.
 */
export async function getAllWhatsAppAuthorizations(): Promise<WhatsAppAuthorization[]> {
  const query = `
    SELECT auth_id, phone_number, worker_id, created_at, updated_at
    FROM whatsapp_authorization;
  `;
  const { rows } = await getPool().query(query);
  return rows as WhatsAppAuthorization[];
}

/**
 * Retrieve a single WhatsApp authorization by last 8 digits + worker id.
 */
export async function getWhatsappAuthorization(
  last8digits: string,
  worker_id: number,
): Promise<WhatsAppAuthorization | null> {
  const query = `
    SELECT auth_id, phone_number, worker_id, created_at, updated_at
    FROM whatsapp_authorization
    WHERE RIGHT(phone_number, 8) = $1 AND worker_id = $2;
  `;
  const { rows } = await getPool().query(query, [last8digits, worker_id]);
  return rows.length > 0 ? (rows[0] as WhatsAppAuthorization) : null;
}

/**
 * Bulk upsert WhatsApp authorizations.
 * - Normalizes phone to digits-only string.
 * - Uses ON CONFLICT (phone_number, worker_id) to touch updated_at.
 */
export async function updateWhatsappAuthorizations(authorizations: WhatsAppAuthorizationInput[]): Promise<void> {
  if (!Array.isArray(authorizations) || authorizations.length === 0) return;

  // Normalize and validate first
  const normalized = authorizations.map((a) => ({
    phone_number: String(a.phone_number ?? "").replace(/\D/g, ""),
    worker_id: a.worker_id,
  }));

  const cols = ["phone_number", "worker_id"] as const;

  const values: Array<string | number | null> = [];
  const placeholders = normalized.map((auth, i) => {
    values.push(auth.phone_number || null, auth.worker_id);
    const base = i * cols.length;
    return `($${base + 1}, $${base + 2})`;
  });

  const query = `
    INSERT INTO whatsapp_authorization (${cols.join(", ")})
    VALUES ${placeholders.join(",\n")}
    ON CONFLICT (phone_number, worker_id)
    DO UPDATE SET updated_at = NOW();
  `;

  await getPool().query(query, values);
}

/**
 * Delete a WhatsApp authorization by full phone number + worker id.
 */
export async function deleteWhatsappAuthorization(phone_number: string, worker_id: number): Promise<void> {
  const query = `
    DELETE FROM whatsapp_authorization
    WHERE phone_number = $1 AND worker_id = $2;
  `;
  await getPool().query(query, [phone_number, worker_id]);
}

/**
 * Persist a failure reason for a group request.
 */
export async function sendAdditionFailedReason(id: number, reason: string): Promise<void> {
  const query = `
    UPDATE group_requests
    SET failure_reason = $2
    WHERE id = $1;
  `;
  await getPool().query(query, [id, reason]);
}
