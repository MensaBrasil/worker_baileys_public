import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { config as configDotenv } from "dotenv";
import { createClient, type RedisClientType } from "redis";
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
    console.log("✅ Conectado ao Redis");
  } catch (error) {
    console.error("❌ Falha ao conectar ao Redis:", error);
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
  console.log(`📁 Fila salva em ${filePath}`);
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .option("--add", "Obter fila de adição")
    .option("--remove", "Obter fila de remoção")
    .option("--all", "Obter todas as filas")
    .parse();

  const options = program.opts();

  if (!options.add && !options.remove && !options.all) {
    console.error("❌ Informe --add, --remove ou --all");
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
    console.error("❌ Erro ao processar filas:", error);
  } finally {
    await disconnectFromRedis();
  }
}

main().catch((error) => {
  console.error("❌ Erro inesperado:", error);
});
