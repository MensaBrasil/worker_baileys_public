import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { createClient, RedisClientType } from "redis";
import { config as configDotenv } from "dotenv";
import { QueueKey } from "../types/redisTypes";

configDotenv({ path: ".env" });

const client: RedisClientType = createClient({
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
  },
});

async function connectToRedis(): Promise<void> {
  try {
    await client.connect();
    console.log("✅ Connected to Redis");
  } catch (error) {
    console.error("❌ Failed to connect to Redis:", error);
    process.exit(1);
  }
}

async function disconnectFromRedis(): Promise<void> {
  await client.quit();
}

async function getQueue(queueKey: string): Promise<unknown[]> {
  const queueData = await client.lRange(queueKey, 0, -1);
  return queueData.map((item) => JSON.parse(item));
}

async function saveQueueToFile(queueData: unknown[], filename: string): Promise<void> {
  const queueDir = path.join(process.cwd(), "tools_results");

  if (!fs.existsSync(queueDir)) {
    fs.mkdirSync(queueDir, { recursive: true });
  }

  const filePath = path.join(queueDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(queueData, null, 2));
  console.log(`📁 Queue saved to ${filePath}`);
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .option("--add", "Get add queue")
    .option("--remove", "Get remove queue")
    .option("--all", "Get all queues")
    .parse();

  const options = program.opts();

  if (!options.add && !options.remove && !options.all) {
    console.error("❌ Please specify --add, --remove, or --all");
    process.exit(1);
  }

  await connectToRedis();

  try {
    if (options.add || options.all) {
      const addQueue = await getQueue(QueueKey.Add);
      await saveQueueToFile(addQueue, "addQueue.json");
    }

    if (options.remove || options.all) {
      const removeQueue = await getQueue(QueueKey.Remove);
      await saveQueueToFile(removeQueue, "removeQueue.json");
    }
  } catch (error) {
    console.error("❌ Error processing queues:", error);
  } finally {
    await disconnectFromRedis();
  }
}

main().catch(console.error);
