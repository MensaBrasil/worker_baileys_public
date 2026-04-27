import * as fs from "node:fs";
import * as path from "node:path";
import {
  Browsers,
  type ConnectionState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type GroupMetadata,
  makeWASocket,
  useMultiFileAuthState,
} from "baileys";
import { Command } from "commander";
import { config as configDotenv } from "dotenv";
import { getAuthStateDir } from "../baileys/auth-state-dir";
import { getMemberPhoneNumbers } from "../db/pgsql";
import type { BoomError } from "../types/errorTypes";
import { phoneToUserJid } from "../utils/phoneToJid";

configDotenv({ path: ".env" });

type AdminRole = "admin" | "superadmin";

interface RegistrationPhones {
  registration_id: number;
  phones: Array<{ digits: string; is_legal_rep: boolean }>; // normalized digits with type
}

interface GroupAdminMatch {
  groupId: string; // without @g.us suffix
  groupName: string | null;
  matches: Array<{
    registration_id: number;
    phone: string; // digits
    is_legal_rep: boolean;
    role: AdminRole;
  }>;
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

function parseIds(input: string): number[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
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
        reject(new Error("Sessão desconectada. Apague a pasta local de autenticação e vincule novamente."));
      }
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      sock.ev.off("connection.update", onUpdate);
    };
    timer = setTimeout(() => {
      if (!resolved) {
        cleanup();
        reject(new Error("Tempo limite excedido aguardando conexão com o WhatsApp."));
      }
    }, timeoutMs);
    sock.ev.on("connection.update", onUpdate);
  });
}

async function loadPhonesForRegistrations(ids: number[]): Promise<RegistrationPhones[]> {
  const out: RegistrationPhones[] = [];
  for (const id of ids) {
    const rows = await getMemberPhoneNumbers(id);
    const phones = rows
      .map((r) => ({ digits: String(r.phone || "").replace(/\D/g, ""), is_legal_rep: Boolean(r.is_legal_rep) }))
      .filter((p) => p.digits.length > 0);
    out.push({ registration_id: id, phones });
  }
  return out;
}

function indexPhonesByJid(
  registrations: RegistrationPhones[],
): Map<string, { registration_id: number; phone: string; is_legal_rep: boolean }[]> {
  const map = new Map<string, { registration_id: number; phone: string; is_legal_rep: boolean }[]>();
  for (const r of registrations) {
    for (const ph of r.phones) {
      try {
        const jid = phoneToUserJid(ph.digits);
        const arr = map.get(jid) ?? [];
        arr.push({ registration_id: r.registration_id, phone: ph.digits, is_legal_rep: ph.is_legal_rep });
        map.set(jid, arr);
      } catch {
        // ignore invalid
      }
    }
  }
  return map;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("getAdmins")
    .description(
      "Busca grupos e verifica se telefones ligados aos registration_ids são admins/superadmins nesses grupos.",
    )
    .requiredOption("--ids <ids>", "IDs de inscrição separados por vírgula.")
    .parse(process.argv);

  const { ids } = program.opts<{ ids: string }>();
  const parsedIds = parseIds(ids);
  if (!parsedIds.length) {
    console.error("❌ Nenhum ID de inscrição válido informado. Exemplo: --ids 1234, 4569,7894");
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState(getAuthStateDir());
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

  console.log("✅ Conectado. Buscando grupos...");
  const groupsRecord = await sock.groupFetchAllParticipating();
  const groups: GroupMetadata[] = Object.values(groupsRecord);

  if (!groups.length) {
    console.log("Nenhum grupo encontrado para este cliente.");
  }

  // Load phones for registrations and index by JID for quick lookup
  console.log("Carregando telefones das inscrições:", parsedIds.join(", "));
  const regPhones = await loadPhonesForRegistrations(parsedIds);
  const jidIndex = indexPhonesByJid(regPhones);

  const results: GroupAdminMatch[] = [];

  for (const g of groups) {
    const groupId = g.id.replace(/@g\.us$/, "");
    const groupName = g.subject ?? null;
    const matches: GroupAdminMatch["matches"] = [];

    for (const p of g.participants ?? []) {
      const role = (p.admin as AdminRole | null) ?? null; // "admin" | "superadmin" | undefined
      if (!role) continue;

      const list = jidIndex.get(p.id);
      if (!list?.length) continue;

      for (const item of list) {
        matches.push({
          registration_id: item.registration_id,
          phone: item.phone,
          is_legal_rep: item.is_legal_rep,
          role,
        });
      }
    }

    if (matches.length) {
      results.push({ groupId, groupName, matches });
    }
  }

  // Persist to tools_results
  const outDir = ensureToolsDir();
  const file = path.join(outDir, `getAdmins-${nowStamp()}.json`);
  fs.writeFileSync(file, JSON.stringify({ registrations: parsedIds, results }, null, 2));

  // Console summary
  console.log("\nResumo:");
  if (!results.length) {
    console.log("Nenhuma correspondência de admin encontrada para as inscrições informadas.");
  } else {
    for (const r of results) {
      console.log(`- Grupo: ${r.groupName ?? r.groupId} (${r.groupId})`);
      for (const m of r.matches) {
        console.log(`  • inscrição=${m.registration_id} telefone=${m.phone} papel=${m.role}`);
      }
    }
  }

  console.log(`\n📁 Resultado detalhado salvo em: ${file}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Erro:", err?.message || err);
  process.exit(1);
});
