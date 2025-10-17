import { config as configDotenv } from "dotenv";
import { createClient, RedisClientType } from "redis";
import { AddQueueItem, RemoveQueueItem, QueueKey } from "../types/redisTypes";

configDotenv({ path: ".env" });

const client: RedisClientType = createClient({
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
    reconnectStrategy: (retries: number) => {
      if (retries > 20) {
        console.error("Too many attempts to reconnect. Redis connection was terminated. Closing app...");
        process.exit(1);
      }
      return Math.min(retries * 500, 5000);
    },
  },
});

client.on("error", (err: Error) => {
  console.error(err);
  process.exit(1);
});

let isConnected = false;
const FIRST_CONTACT_LOCK_PREFIX = "first-contact-welcome";

/**
 * Establishes a connection to the Redis client if not already connected.
 */
export async function connect(): Promise<void> {
  if (!isConnected) {
    await client.connect();
    isConnected = true;
  }
}

/**
 * Disconnects from the Redis client if a connection exists.
 */
export async function disconnect(): Promise<void> {
  if (isConnected) {
    await client.quit();
    isConnected = false;
  }
}

/**
 * Attempts to acquire a first-contact welcome lock for a given group + participant combination.
 * Returns true if the lock was acquired, false if it already exists, and null if Redis is unavailable.
 */
export async function tryAcquireFirstContactLock(
  groupJid: string,
  participantJid: string,
  ttlMs: number,
): Promise<boolean | null> {
  try {
    await connect();
    const key = `${FIRST_CONTACT_LOCK_PREFIX}:${groupJid}:${participantJid}`;
    const result = await client.set(key, "1", {
      NX: true,
      PX: ttlMs,
    });

    return result === "OK";
  } catch (error) {
    console.error("Falha ao adquirir lock de primeiro contato", error);
    return null;
  }
}

/**
 * Tests Redis connection and exits process if connection fails.
 */
export async function testRedisConnection(): Promise<void> {
  try {
    await connect();
    console.log("✅ Successfully connected to Redis");
    await disconnect();
  } catch (error) {
    console.error("❌ Failed to connect to Redis:", error);
    process.exit(1);
  }
}

/**
 * Retrieves and removes the first item from addQueue.
 */
export async function getFromAddQueue(): Promise<AddQueueItem | null> {
  await connect();
  const queueItem = await client.lPop(QueueKey.Add);
  return queueItem ? JSON.parse(queueItem) : null;
}

/**
 * Retrieves and removes the first item from removeQueue.
 */
export async function getFromRemoveQueue(): Promise<RemoveQueueItem | null> {
  await connect();
  const queueItem = await client.lPop(QueueKey.Remove);
  return queueItem ? JSON.parse(queueItem) : null;
}
