import { Command } from "commander";
import { config as configDotenv } from "dotenv";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  type ConnectionState,
  type GroupMetadata,
} from "baileys";
import * as fs from "fs";
import * as path from "path";
import { getUnderageLegalRepPhones, getUnderageMemberPhonesWithAge } from "../db/pgsql";
import type { BoomError } from "../types/errorTypes";

configDotenv({ path: ".env" });

type AgeBucket = "JB" | "MENOR13";

interface UnderageRecord {
  registration_id: number;
  phone: string;
  age: number;
}

interface GroupEntry {
  registration_id: number;
  phone: string;
  age: number;
  bucket: AgeBucket;
}

interface LegalRepEntry {
  registration_id: number;
  phone: string;
}

interface GroupReport {
  groupId: string;
  groupName: string | null;
  members: GroupEntry[];
  legal_reps: LegalRepEntry[];
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
        reject(new Error("Session logged out. Re-link the device (./auth)."));
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

function parseEnvNumber(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    if (fallback != null) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number. Got: "${raw}"`);
  return n;
}

function classifyAge(age: number): AgeBucket | null {
  if (!Number.isFinite(age) || age < 0) return null;
  if (age < 13) return "MENOR13";
  if (age < 18) return "JB";
  return null;
}

function extractDigits(input: string | undefined | null): string | null {
  if (!input) return null;
  const beforeAt = input.split("@")[0] ?? "";
  const beforeColon = beforeAt.split(":")[0] ?? beforeAt;
  const digits = beforeColon.replace(/\D/g, "");
  return digits || null;
}

function indexByDigits(records: UnderageRecord[]): Map<string, UnderageRecord[]> {
  const map = new Map<string, UnderageRecord[]>();
  for (const r of records) {
    const digits = extractDigits(r.phone);
    if (!digits) continue;
    const arr = map.get(digits) ?? [];
    arr.push(r);
    map.set(digits, arr);
  }
  return map;
}

function indexLegalRepsByDigits(
  records: Array<{ registration_id: number; phone: string }>,
): Map<string, Array<{ registration_id: number; phone: string }>> {
  const map = new Map<string, Array<{ registration_id: number; phone: string }>>();
  for (const r of records) {
    const digits = extractDigits(r.phone);
    if (!digits) continue;
    const arr = map.get(digits) ?? [];
    arr.push(r);
    map.set(digits, arr);
  }
  return map;
}

function collectParticipantDigits(p: Record<string, unknown>): Set<string> {
  const digits = new Set<string>();
  const push = (val: unknown) => {
    if (typeof val !== "string") return;
    const d = extractDigits(val);
    if (d) digits.add(d);
  };
  push(p.id);
  push((p as { jid?: unknown }).jid);
  push((p as { phoneNumber?: unknown }).phoneNumber);
  push((p as { lid?: unknown }).lid);
  push((p as { user?: unknown }).user);
  return digits;
}

function formatDuration(seconds: number): string {
  const sec = Math.max(0, Math.round(seconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("reportUnderageGroups")
    .description("Generate report of underage members (JBs and <13) present in groups.")
    .parse(process.argv);

  const { state, saveCreds } = await useMultiFileAuthState("./auth");
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

  console.log("✅ Connected. Fetching groups...");
  const groupsRecord = await sock.groupFetchAllParticipating();
  const groups: GroupMetadata[] = Object.values(groupsRecord);

  if (!groups.length) {
    console.log("No groups found for this client.");
  }

  console.log("Loading underage member phones + ages from DB...");
  const underage = await getUnderageMemberPhonesWithAge();
  const legalReps = await getUnderageLegalRepPhones();

  const normalized: UnderageRecord[] = underage
    .map((r) => ({
      registration_id: r.registration_id,
      phone: String(r.phone || "").replace(/\D/g, ""),
      age: Number(r.age),
    }))
    .filter((r) => r.phone.length > 0 && Number.isFinite(r.age));

  const digitsIndex = indexByDigits(normalized);
  const legalRepsNormalized: Array<{ registration_id: number; phone: string }> = legalReps
    .map((r) => ({
      registration_id: r.registration_id,
      phone: String(r.phone || "").replace(/\D/g, ""),
    }))
    .filter((r) => r.phone.length > 0);

  const legalRepsIndex = indexLegalRepsByDigits(legalRepsNormalized);

  const results: GroupReport[] = [];
  const jbPhones = new Set<string>();
  const menor13Phones = new Set<string>();
  let jbEntries = 0;
  let menor13Entries = 0;
  let legalRepEntries = 0;
  const legalRepPhones = new Set<string>();

  for (const g of groups) {
    const groupId = g.id.replace(/@g\.us$/, "");
    const groupName = g.subject ?? null;
    const members: GroupEntry[] = [];
    const legal_rep_entries: LegalRepEntry[] = [];

    for (const p of g.participants ?? []) {
      const participantDigits = collectParticipantDigits(p as unknown as Record<string, unknown>);
      if (!participantDigits.size) continue;

      for (const d of participantDigits) {
        const list = digitsIndex.get(d);
        if (list?.length) {
          for (const item of list) {
            const bucket = classifyAge(item.age);
            if (!bucket) continue;
            const entry: GroupEntry = {
              registration_id: item.registration_id,
              phone: item.phone,
              age: item.age,
              bucket,
            };
            members.push(entry);
            if (bucket === "JB") {
              jbEntries += 1;
              jbPhones.add(item.phone);
            } else if (bucket === "MENOR13") {
              menor13Entries += 1;
              menor13Phones.add(item.phone);
            }
          }
        }

        const reps = legalRepsIndex.get(d);
        if (reps?.length) {
          for (const item of reps) {
            legal_rep_entries.push({ registration_id: item.registration_id, phone: item.phone });
            legalRepEntries += 1;
            legalRepPhones.add(item.phone);
          }
        }
      }
    }

    if (members.length || legal_rep_entries.length) {
      results.push({ groupId, groupName, members, legal_reps: legal_rep_entries });
    }
  }

  const MIN_DELAY = parseEnvNumber("MIN_DELAY");
  const MAX_DELAY = parseEnvNumber("MAX_DELAY");
  const CALL_TIMEOUT_MS = parseEnvNumber("CALL_TIMEOUT_MS", 15_000);
  const avgDelaySecs = (MIN_DELAY + MAX_DELAY) / 2;
  const perRemovalSecs = avgDelaySecs + CALL_TIMEOUT_MS / 1000;
  const totalRemovalSecs = perRemovalSecs * jbEntries;

  const summary = {
    jb: {
      group_entries: jbEntries,
      unique_phones: jbPhones.size,
    },
    menor13: {
      group_entries: menor13Entries,
      unique_phones: menor13Phones.size,
    },
    legal_reps: {
      group_entries: legalRepEntries,
      unique_phones: legalRepPhones.size,
    },
    removal_estimate: {
      env_min_delay_secs: MIN_DELAY,
      env_max_delay_secs: MAX_DELAY,
      env_call_timeout_ms: CALL_TIMEOUT_MS,
      avg_per_removal_secs: Number(perRemovalSecs.toFixed(2)),
      total_estimated_secs: Number(totalRemovalSecs.toFixed(2)),
      total_estimated_human: formatDuration(totalRemovalSecs),
      notes: "Estimate assumes 1 removal attempt per group entry + avg delay between removals.",
    },
  };

  const outDir = ensureToolsDir();
  const file = path.join(outDir, `reportUnderageGroups-${nowStamp()}.json`);
  fs.writeFileSync(file, JSON.stringify({ summary, results }, null, 2));

  console.log("\nSummary:");
  console.log(`- JBs (13-17) em grupos: ${summary.jb.group_entries} entradas / ${summary.jb.unique_phones} telefones`);
  console.log(
    `- <13 em grupos: ${summary.menor13.group_entries} entradas / ${summary.menor13.unique_phones} telefones`,
  );
  console.log(
    `- Responsaveis em grupos: ${summary.legal_reps.group_entries} entradas / ${summary.legal_reps.unique_phones} telefones`,
  );
  console.log(
    `- Estimativa media p/ remover todos JBs: ${summary.removal_estimate.total_estimated_human} ` +
      `(${summary.removal_estimate.total_estimated_secs}s)`,
  );
  console.log(`\n📁 Saved detailed results to: ${file}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error:", err?.message || err);
  process.exit(1);
});
