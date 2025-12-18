import { config as configDotenv } from "dotenv";
import { Pool } from "pg";
import type {
  PgEnv,
  MemberPhone,
  MemberStatus,
  WhatsAppAuthorization,
  WhatsAppAuthorizationInput,
  WhatsAppWorker,
  WhatsAppModerationInput,
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
 * Best-effort mapping between LID and phone number for future lookups.
 */
export async function upsertLidMapping(lid: string, phone: string, source = "unknown"): Promise<void> {
  const p = getPool();
  const query = `
    INSERT INTO whatsapp_lid_mappings (lid, phone_number, source, last_seen)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (lid)
    DO UPDATE SET phone_number = EXCLUDED.phone_number, source = EXCLUDED.source, last_seen = NOW()
  `;
  await p.query(query, [lid, phone, source]);
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

/**
 * Finds a registration_id for a given phone using ONLY the last 8 digits.
 * Looks up in phones, and legal_representatives (phone and alternative_phone).
 */
export async function findRegistrationIdByPhone(phone_number: string): Promise<number | null> {
  const last8 = String(phone_number ?? "")
    .replace(/\D/g, "")
    .slice(-8);
  if (!last8) return null;

  const query = `
    SELECT registration_id FROM phones WHERE RIGHT(phone_number, 8) = $1
    UNION
    SELECT registration_id FROM legal_representatives WHERE RIGHT(phone, 8) = $1
    UNION
    SELECT registration_id FROM legal_representatives WHERE RIGHT(alternative_phone, 8) = $1
    LIMIT 1;
  `;
  const { rows } = await getPool().query(query, [last8]);
  return rows.length ? (rows[0].registration_id as number) : null;
}

/**
 * Inserts a moderation record into whatsapp_moderation.
 * If timestamp is omitted, uses NOW().
 */
export async function insertWhatsAppModeration(input: WhatsAppModerationInput): Promise<void> {
  const values: Array<string | number | boolean | null> = [
    input.registration_id ?? null,
    input.group_id,
    input.deleted,
    input.reason,
    input.phone,
    input.content ?? null,
  ];

  // If caller provided timestamp, we include it as a bound param; otherwise, use NOW().
  const hasTimestamp = Boolean(input.timestamp);
  const placeholderBase = hasTimestamp ? `($1, $2, $3, $4, $5, $6, $7)` : `($1, $2, NOW(), $3, $4, $5, $6)`;

  const query = `
    INSERT INTO whatsapp_moderation (registration_id, group_id, timestamp, deleted, reason, phone, content)
    VALUES ${placeholderBase};
  `;

  const finalValues = hasTimestamp
    ? [values[0], values[1], input.timestamp!, values[2], values[3], values[4], values[5]]
    : values;

  await getPool().query(query, finalValues);
}

/**
 * Returns phones for members under 18 years old, including their legal representatives' phones.
 * This function attempts multiple common DOB column names to accommodate schema variations.
 * It returns an array with registration_id, phone (digits as stored), and is_legal_rep flag.
 */
export async function getUnderageMemberAndLegalPhones(): Promise<
  Array<{ registration_id: number; phone: string; is_legal_rep: boolean }>
> {
  const query = `
    -- Member phones for registrations with birth_date < 18 years
    SELECT r.registration_id, p.phone_number AS phone, FALSE AS is_legal_rep
    FROM registration r
    JOIN phones p ON p.registration_id = r.registration_id
    WHERE r.birth_date > (CURRENT_DATE - INTERVAL '18 years')

    UNION ALL

    -- Legal representative primary phone
    SELECT r.registration_id, lr.phone AS phone, TRUE AS is_legal_rep
    FROM registration r
    JOIN legal_representatives lr ON lr.registration_id = r.registration_id
    WHERE r.birth_date > (CURRENT_DATE - INTERVAL '18 years')

    UNION ALL

    -- Legal representative alternative phone (only if present)
    SELECT r.registration_id, lr.alternative_phone AS phone, TRUE AS is_legal_rep
    FROM registration r
    JOIN legal_representatives lr ON lr.registration_id = r.registration_id
    WHERE r.birth_date > (CURRENT_DATE - INTERVAL '18 years') AND lr.alternative_phone IS NOT NULL
  `;
  const { rows } = await getPool().query(query);
  return rows as Array<{ registration_id: number; phone: string; is_legal_rep: boolean }>;
}
