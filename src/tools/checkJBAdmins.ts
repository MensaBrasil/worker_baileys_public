import { Command } from "commander";
import { config as configDotenv } from "dotenv";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  type ConnectionState,
  type GroupMetadata,
} from "baileys";
import * as fs from "fs";
import * as path from "path";
import { getUnderageMemberAndLegalPhones } from "../db/pgsql";
import { usePostgresAuthState } from "../baileys/use-postgres-auth-state";
import { getAuthPool } from "../db/authStatePg";
import type { BoomError } from "../types/errorTypes";

configDotenv({ path: ".env" });

type AdminRole = "admin" | "superadmin";

interface PhoneRecord {
  registration_id: number;
  phone: string; // digits
  is_legal_rep: boolean;
}

interface GroupAdminMatch {
  groupId: string;
  groupName: string | null;
  matches: Array<PhoneRecord & { role: AdminRole }>;
}

function ensureToolsDir(): string {
  const dir = path.join(process.cwd(), "tools_results");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
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

function phoneToUserJid(input: string): string {
  const digits = (input || "").replace(/\D/g, "");
  if (!digits) throw new Error(`Invalid number: "${input}"`);
  return `${digits}@s.whatsapp.net`;
}

function indexPhonesByJid(records: PhoneRecord[]): Map<string, PhoneRecord[]> {
  const map = new Map<string, PhoneRecord[]>();
  for (const r of records) {
    try {
      const jid = phoneToUserJid(r.phone);
      const arr = map.get(jid) ?? [];
      arr.push(r);
      map.set(jid, arr);
    } catch {
      // ignore invalid numbers
    }
  }
  return map;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("getJBAdmins")
    .description(
      "Fetch groups and check if underage members (<18) or their legal representatives are admins/superadmins.",
    )
    .parse(process.argv);

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

  console.log("✅ Connected. Fetching groups...");
  const groupsRecord = await sock.groupFetchAllParticipating();
  const groups: GroupMetadata[] = Object.values(groupsRecord);

  if (!groups.length) {
    console.log("No groups found for this client.");
  }

  console.log("Loading underage members and legal representatives phones from DB...");
  const underage = await getUnderageMemberAndLegalPhones();

  // Normalize digits only for safety
  const normalized: PhoneRecord[] = underage
    .map((r) => ({
      registration_id: r.registration_id,
      phone: String(r.phone || "").replace(/\D/g, ""),
      is_legal_rep: Boolean(r.is_legal_rep),
    }))
    .filter((r) => r.phone.length > 0);

  const jidIndex = indexPhonesByJid(normalized);

  const results: GroupAdminMatch[] = [];

  for (const g of groups) {
    const groupId = g.id.replace(/@g\.us$/, "");
    const groupName = g.subject ?? null;
    const matches: GroupAdminMatch["matches"] = [];

    for (const p of g.participants ?? []) {
      const role = (p.admin as AdminRole | null) ?? null; // "admin" | "superadmin"
      if (!role) continue;

      const list = jidIndex.get(p.id);
      if (!list?.length) continue;

      for (const item of list) {
        matches.push({ ...item, role });
      }
    }

    if (matches.length) {
      results.push({ groupId, groupName, matches });
    }
  }

  const outDir = ensureToolsDir();
  const file = path.join(outDir, `getJBAdmins-${nowStamp()}.json`);
  fs.writeFileSync(file, JSON.stringify({ results }, null, 2));

  console.log("\nSummary:");
  if (!results.length) {
    console.log("No admin matches among underage members or their representatives.");
  } else {
    for (const r of results) {
      console.log(`- Group: ${r.groupName ?? r.groupId} (${r.groupId})`);
      for (const m of r.matches) {
        const who = m.is_legal_rep ? "legal_rep" : "member";
        console.log(`  • reg=${m.registration_id} phone=${m.phone} type=${who} role=${m.role}`);
      }
    }
  }

  console.log(`\n📁 Saved detailed results to: ${file}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error:", err?.message || err);
  process.exit(1);
});
