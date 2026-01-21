import { Command } from "commander";
import { config as configDotenv } from "dotenv";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  type ConnectionState,
  type GroupMetadata,
  type WASocket,
} from "baileys";
import * as fs from "fs";
import * as path from "path";
import { usePostgresAuthState } from "../baileys/use-postgres-auth-state";
import { getAuthPool } from "../db/authStatePg";
import type { BoomError } from "../types/errorTypes";
import { delaySecs } from "../utils/delay";
import { findParticipant, isParticipantAdmin } from "../utils/waParticipants";

configDotenv({ path: ".env" });

function parseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number. Got: "${raw}"`);
  return n;
}

function ensureToolsDir(): string {
  const dir = path.join(process.cwd(), "tools_results");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds(),
  )}`;
}

const DEFAULT_MIN_DELAY = parseEnvNumber("MIN_DELAY", 3);
const DEFAULT_MAX_DELAY = parseEnvNumber("MAX_DELAY", 6);
const DEFAULT_DELAY_JITTER = parseEnvNumber("DELAY_JITTER", 1);
const DEFAULT_CALL_TIMEOUT_MS = parseEnvNumber("CALL_TIMEOUT_MS", 15_000);

function parseNumberOption(label: string, value: string | undefined, fallback: number): number {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Opção ${label} deve ser numérica. Recebido: "${value}"`);
  return n;
}

function extractDigits(input: string): string | null {
  const beforeAt = input.split("@")[0] ?? "";
  const beforeColon = beforeAt.split(":")[0] ?? beforeAt;
  const digits = beforeColon.replace(/\D/g, "");
  return digits || null;
}

function normalizeUserJid(input: string): { normalized: string; digits: string } {
  const digits = extractDigits(input);
  if (!digits) throw new Error(`JID inválido: "${input}"`);

  let domain = "s.whatsapp.net";
  if (input.includes("@")) {
    const parts = input.split("@");
    if (parts[1] && parts[1].trim()) domain = parts[1].trim();
  }

  return { normalized: `${digits}@${domain}`, digits };
}

function asStatusCode(status: unknown): number | null {
  if (typeof status === "number") return status;
  if (typeof status === "string" && status.trim() !== "") {
    const n = Number(status);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`Operation timed out after ${ms}ms`)), ms);
  });
  try {
    const res = await Promise.race([p, timeout]);
    return res as T;
  } finally {
    if (t) clearTimeout(t);
  }
}

async function waitForOpen(sock: ReturnType<typeof makeWASocket>, timeoutMs = 60_000): Promise<void> {
  let resolved = false;
  let timer: NodeJS.Timeout | null = null;
  return new Promise<void>((resolve, reject) => {
    const onUpdate = (u: Partial<ConnectionState>) => {
      const c = u.connection;
      const code = (u.lastDisconnect?.error as BoomError | undefined)?.output?.statusCode as number | undefined;
      if (c === "open") {
        cleanup();
        resolved = true;
        resolve();
      } else if (code === DisconnectReason.loggedOut) {
        cleanup();
        reject(new Error("Session logged out. Re-link the device (auth DB)."));
      }
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      sock.ev.off("connection.update", onUpdate);
    };
    timer = setTimeout(() => {
      if (!resolved) {
        cleanup();
        reject(new Error("Timeout waiting for WhatsApp connection."));
      }
    }, timeoutMs);
    sock.ev.on("connection.update", onUpdate);
  });
}

function getSelfIdentity(sock: WASocket): { id: string | null; alt: string | null } {
  const selfId = sock.user?.id ?? null;
  const selfAlt = (sock.user as { phoneNumber?: string } | undefined)?.phoneNumber ?? null;
  return { id: selfId, alt: selfAlt };
}

function isAdminRole(role: unknown): boolean {
  return role === "admin" || role === "superadmin";
}

async function ensureGroupMetadata(sock: WASocket, meta: GroupMetadata, timeoutMs: number): Promise<GroupMetadata> {
  if (meta.participants?.length) return meta;
  try {
    return await withTimeout(sock.groupMetadata(meta.id), timeoutMs);
  } catch {
    return meta;
  }
}

async function tryParticipantsUpdate(
  sock: WASocket,
  groupJid: string,
  userJid: string,
  action: "add" | "remove" | "demote" | "promote",
  timeoutMs: number,
): Promise<{ ok: boolean; status: number | null; error?: string }> {
  try {
    const resp = await withTimeout(sock.groupParticipantsUpdate(groupJid, [userJid], action), timeoutMs);
    if (Array.isArray(resp) && resp.length > 0) {
      const status = asStatusCode(resp[0]?.status);
      const ok = status == null || status === 200 || status === 207;
      return { ok, status };
    }
    return { ok: true, status: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: null, error: msg };
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("addAdminToAllGroups")
    .description("Adiciona e promove um JID em todos os grupos/comunidades onde este cliente é admin.")
    .argument("[jid]", "JID do usuário alvo (ex: 5521911112222:29@s.whatsapp.net)")
    .option("--jid <jid>", "JID do usuário alvo (ex: 5521911112222:29@s.whatsapp.net)")
    .option("--min-delay <seconds>", "Delay mínimo entre operações (segundos)")
    .option("--max-delay <seconds>", "Delay máximo entre operações (segundos)")
    .option("--delay-jitter <seconds>", "Jitter adicional para o delay (segundos)")
    .option("--timeout-ms <ms>", "Timeout por chamada Baileys (ms)")
    .parse(process.argv);

  const opts = program.opts<{
    jid?: string;
    minDelay?: string;
    maxDelay?: string;
    delayJitter?: string;
    timeoutMs?: string;
  }>();

  const targetInput = opts.jid ?? program.args[0];
  if (!targetInput) {
    console.error("❌ Informe o JID alvo. Ex: --jid 5521911112222:29@s.whatsapp.net");
    process.exit(1);
  }

  const { normalized: targetJid } = normalizeUserJid(targetInput);
  const minDelay = parseNumberOption("--min-delay", opts.minDelay, DEFAULT_MIN_DELAY);
  const maxDelay = parseNumberOption("--max-delay", opts.maxDelay, DEFAULT_MAX_DELAY);
  const delayJitter = parseNumberOption("--delay-jitter", opts.delayJitter, DEFAULT_DELAY_JITTER);
  const timeoutMs = parseNumberOption("--timeout-ms", opts.timeoutMs, DEFAULT_CALL_TIMEOUT_MS);

  if (maxDelay < minDelay) {
    console.error("❌ --max-delay deve ser >= --min-delay.");
    process.exit(1);
  }

  const { state, saveCreds } = await usePostgresAuthState(getAuthPool(), "default");
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu("Desktop"),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock.ev.on("creds.update", saveCreds);

  await waitForOpen(sock);

  const { id: selfId, alt: selfAlt } = getSelfIdentity(sock);
  if (!selfId && !selfAlt) {
    throw new Error("Identidade do cliente indisponível.");
  }

  console.log("✅ Connected. Fetching groups...");
  const groupsRecord = await sock.groupFetchAllParticipating();
  const groups: GroupMetadata[] = Object.values(groupsRecord);

  if (!groups.length) {
    console.log("Nenhum grupo encontrado para este cliente.");
    process.exit(0);
  }

  let totalAdminGroups = 0;
  let skippedNotAdmin = 0;
  let alreadyAdmin = 0;
  let added = 0;
  let promoted = 0;
  let addFailed = 0;
  let promoteFailed = 0;

  for (const g of groups) {
    const meta = await ensureGroupMetadata(sock, g, timeoutMs);
    const groupJid = meta.id;
    const groupName = meta.subject ?? groupJid;

    const selfIsAdmin = isParticipantAdmin(meta, selfId ?? null, { altId: selfAlt ?? null });
    if (!selfIsAdmin) {
      skippedNotAdmin++;
      continue;
    }

    totalAdminGroups++;

    const participant = findParticipant(meta, targetInput, { altId: targetJid });
    const participantRole = (participant as { admin?: unknown } | undefined)?.admin;
    if (participant && isAdminRole(participantRole)) {
      alreadyAdmin++;
      console.log(`✔ Já é admin: ${groupName} (${groupJid})`);
      continue;
    }

    let didAction = false;

    if (participant) {
      console.log(`🔼 Promovendo para admin em ${groupName} (${groupJid})`);
      const promoteAttempt = await tryParticipantsUpdate(sock, groupJid, targetJid, "promote", timeoutMs);
      didAction = true;
      if (promoteAttempt.ok) {
        promoted++;
      } else {
        promoteFailed++;
        console.warn(`⚠️ Falha ao promover em ${groupName}: ${promoteAttempt.error ?? "status desconhecido"}`);
      }
    } else {
      console.log(`➕ Adicionando em ${groupName} (${groupJid})`);
      const addAttempt = await tryParticipantsUpdate(sock, groupJid, targetJid, "add", timeoutMs);
      didAction = true;

      if (addAttempt.status === 409) {
        console.log(`ℹ️ Já estava no grupo. Promovendo em ${groupName} (${groupJid})`);
        const promoteAttempt = await tryParticipantsUpdate(sock, groupJid, targetJid, "promote", timeoutMs);
        if (promoteAttempt.ok) {
          promoted++;
        } else {
          promoteFailed++;
          console.warn(`⚠️ Falha ao promover em ${groupName}: ${promoteAttempt.error ?? "status desconhecido"}`);
        }
      } else if (addAttempt.ok) {
        added++;
        console.log(`🔼 Promovendo para admin em ${groupName} (${groupJid})`);
        const promoteAttempt = await tryParticipantsUpdate(sock, groupJid, targetJid, "promote", timeoutMs);
        if (promoteAttempt.ok) {
          promoted++;
        } else {
          promoteFailed++;
          console.warn(`⚠️ Falha ao promover em ${groupName}: ${promoteAttempt.error ?? "status desconhecido"}`);
        }
      } else {
        addFailed++;
        console.warn(`⚠️ Falha ao adicionar em ${groupName}: ${addAttempt.error ?? "status desconhecido"}`);
      }
    }

    if (didAction) {
      await delaySecs(minDelay, maxDelay, delayJitter);
    }
  }

  console.log("\nResumo:");
  console.log(`- Grupos/comunidades onde sou admin: ${totalAdminGroups}`);
  console.log(`- Ignorados (não sou admin): ${skippedNotAdmin}`);
  console.log(`- Já era admin: ${alreadyAdmin}`);
  console.log(`- Adicionado: ${added}`);
  console.log(`- Promovido: ${promoted}`);
  console.log(`- Falhas ao adicionar: ${addFailed}`);
  console.log(`- Falhas ao promover: ${promoteFailed}`);

  const outDir = ensureToolsDir();
  const file = path.join(outDir, `addAdminToAllGroups-${nowStamp()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        target: targetJid,
        delay: { min: minDelay, max: maxDelay, jitter: delayJitter },
        timeoutMs,
        summary: {
          totalAdminGroups,
          skippedNotAdmin,
          alreadyAdmin,
          added,
          promoted,
          addFailed,
          promoteFailed,
        },
      },
      null,
      2,
    ),
  );
  console.log(`\n📁 JSON salvo em: ${file}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error:", err?.message || err);
  process.exit(1);
});
