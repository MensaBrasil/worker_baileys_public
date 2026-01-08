import { PrismaPg } from "@prisma/adapter-pg";
import { config as configDotenv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

configDotenv({ path: ".env" });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to initialize PrismaClient");
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });
