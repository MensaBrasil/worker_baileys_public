import { config as configDotenv } from "dotenv";
import { Pool } from "pg";

configDotenv({ path: ".env" });

function readAuthEnv(): string {
  const { DATABASE_URL } = process.env as NodeJS.ProcessEnv & { DATABASE_URL?: string };
  if (!DATABASE_URL) {
    throw new Error("Missing required auth DB env var: DATABASE_URL");
  }
  return DATABASE_URL;
}

let authPool: Pool | null = null;

export function getAuthPool(): Pool {
  if (authPool) return authPool;
  const connectionString = readAuthEnv();
  authPool = new Pool({ connectionString });

  authPool.on("error", (err) => {
    console.error("[auth-pg] Pool error:", err);
  });

  return authPool;
}
