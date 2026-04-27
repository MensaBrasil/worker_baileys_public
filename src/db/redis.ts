import { config as configDotenv } from "dotenv";
import { createClient, type RedisClientType } from "redis";
import { type AddQueueItem, QueueKey, type RemoveQueueItem } from "../types/redisTypes";

configDotenv({ path: ".env" });

const client: RedisClientType = createClient({
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
    reconnectStrategy: (retries: number) => {
      if (retries > 20) {
        console.error("Tentativas de reconexão ao Redis excedidas. Conexão encerrada. Fechando o app...");
        process.exit(1);
      }
      return Math.min(retries * 500, 5000);
    },
  },
});

client.on("error", (err: Error) => {
  console.error("Erro no Redis:", err);
  process.exit(1);
});

let isConnected = false;
const FIRST_CONTACT_LOCK_PREFIX = "first-contact-welcome";
const CONSENT_AUTO_REPLY_COOLDOWN_PREFIX = "consent-auto-reply";
const CONSENT_AUTO_REPLY_COOLDOWN_SECONDS = 24 * 60 * 60;

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
 * Checks whether a consent auto-reply was already sent to this phone during the cooldown window.
 */
export async function hasConsentAutoReplyCooldown(phone: string): Promise<boolean> {
  await connect();
  const key = `${CONSENT_AUTO_REPLY_COOLDOWN_PREFIX}:${phone}`;
  return (await client.exists(key)) === 1;
}

/**
 * Registers a consent auto-reply cooldown for 24 hours after the reply is sent.
 */
export async function registerConsentAutoReplySent(phone: string): Promise<void> {
  await connect();
  const key = `${CONSENT_AUTO_REPLY_COOLDOWN_PREFIX}:${phone}`;
  await client.set(key, "1", {
    EX: CONSENT_AUTO_REPLY_COOLDOWN_SECONDS,
  });
}

/**
 * Tests Redis connection and exits process if connection fails.
 */
export async function testRedisConnection(): Promise<void> {
  try {
    await connect();
    console.log("✅ Conexão com o Redis realizada com sucesso");
    await disconnect();
  } catch (error) {
    console.error("❌ Falha ao conectar ao Redis:", error);
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
 * Re-enqueues an addQueue item to the end of the queue.
 */
export async function requeueAddQueue(item: AddQueueItem): Promise<void> {
  await connect();
  await client.rPush(QueueKey.Add, JSON.stringify(item));
}

/**
 * Retrieves and removes the first item from removeQueue.
 */
export async function getFromRemoveQueue(): Promise<RemoveQueueItem | null> {
  await connect();
  const queueItem = await client.lPop(QueueKey.Remove);
  return queueItem ? JSON.parse(queueItem) : null;
}

/**
 * Re-enqueues a removeQueue item to the end of the queue.
 */
export async function requeueRemoveQueue(item: RemoveQueueItem): Promise<void> {
  await connect();
  await client.rPush(QueueKey.Remove, JSON.stringify(item));
}
