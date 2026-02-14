/**
 * Integration test: Real Postgres + Baileys transaction simulation
 *
 * This test exercises the actual Baileys auth-state transaction path against a
 * real PostgreSQL database, reproducing the conditions that may cause
 * `sendMessage` to throw silently (delivering the message but rejecting the
 * Promise due to a Postgres commit failure).
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * The tests will be SKIPPED automatically when Postgres is not reachable.
 *
 * NOTE: These tests use REAL timers (no vi.useFakeTimers) because fake timers
 * conflict with the pg Pool and Baileys' async-mutex internals.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import type { GroupParticipant, BaileysEventMap } from "baileys";
import { addTransactionCapability } from "baileys";
import pino from "pino";

import { usePostgresAuthState } from "../baileys/use-postgres-auth-state";
import {
  registerFirstContactWelcome,
} from "./firstContactWelcome";
import { tryAcquireFirstContactLock } from "../db/redis";

// ── Mock Redis (no real Redis needed for transaction tests) ─────────
vi.mock("../db/redis", () => ({
  tryAcquireFirstContactLock: vi.fn(),
}));

vi.mock("../utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("node:fs", () => ({
  promises: {
    readFile: vi.fn().mockResolvedValue(Buffer.from("fake-audio-data")),
  },
}));

// ── Postgres connectivity check (top-level await) ───────────────────
const PG_URL = process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/worker_test";

let pool: pg.Pool | null = null;

const pgAvailable = await (async (): Promise<boolean> => {
  const testPool = new pg.Pool({ connectionString: PG_URL, connectionTimeoutMillis: 3000 });
  try {
    const client = await testPool.connect();
    client.release();
    await testPool.end();
    return true;
  } catch {
    await testPool.end().catch(() => {});
    return false;
  }
})();

if (!pgAvailable) {
  console.warn(
    "\n\u26A0  Postgres not reachable at %s \u2014 skipping integration tests.\n   Run: docker compose -f docker-compose.test.yml up -d\n",
    PG_URL,
  );
}

// ── DDL for auth tables ─────────────────────────────────────────────
const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS "WaAuthCreds" (
    "sessionId" TEXT PRIMARY KEY,
    "creds" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS "WaAuthKey" (
    "id" BIGSERIAL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "value" JSONB,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE ("sessionId", "category", "keyId")
  );
`;

const TRUNCATE_SQL = `
  TRUNCATE TABLE "WaAuthKey";
  TRUNCATE TABLE "WaAuthCreds";
`;

// ── Logger for Baileys transaction layer ────────────────────────────
const testLogger = pino({ level: "silent" });

// ── Helpers ─────────────────────────────────────────────────────────
type EventHandler<K extends keyof BaileysEventMap> = (data: BaileysEventMap[K]) => Promise<void> | void;

function createMockSocketWithTransactionSendMessage(
  sendMessageImpl: (jid: string, content: unknown, options?: unknown) => Promise<unknown>,
) {
  const handlers = new Map<string, EventHandler<never>[]>();

  const ev = {
    on: vi.fn((event: string, handler: EventHandler<never>) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
  };

  const sock = {
    user: { id: "5511888888888:0@s.whatsapp.net" },
    ev,
    sendMessage: vi.fn(sendMessageImpl),
    groupMetadata: vi.fn().mockResolvedValue({
      id: "group-id@g.us",
      subject: "Primeiro Contato",
      participants: [],
    }),
  } as never;

  const emit = async <K extends keyof BaileysEventMap>(event: K, data: BaileysEventMap[K]) => {
    const list = handlers.get(event) ?? [];
    for (const handler of list) {
      await (handler as EventHandler<K>)(data);
    }
  };

  return { sock, emit, handlers };
}

// ── Test suite (REAL timers) ──

describe.skipIf(!pgAvailable)("Postgres transaction integration", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL });
    await pool.query(CREATE_TABLES_SQL);
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  beforeEach(async () => {
    await pool!.query(TRUNCATE_SQL);
    process.env.FIRST_CONTACT_GROUP_NAME = "Primeiro Contato";
    vi.mocked(tryAcquireFirstContactLock).mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.FIRST_CONTACT_GROUP_NAME;
    vi.restoreAllMocks();
  });

  // Helper: create a sendMessage that runs a real Baileys transaction
  function makeTxSendMessage(keysWithTx: ReturnType<typeof addTransactionCapability>) {
    let commitCount = 0;

    return async (jid: string, _content: unknown) => {
      const meId = "5511888888888:0@s.whatsapp.net";
      const result = await keysWithTx.transaction(async () => {
        // Simulate reading/writing Signal keys (what encryption would do)
        await keysWithTx.get("sender-key-memory", [`${jid}--sender-key`]);

        // Simulate writing updated sender key back
        await keysWithTx.set({
          "sender-key-memory": {
            [`${jid}--sender-key`]: {
              [meId]: { sessionVersion: 3, chainKey: { counter: commitCount, key: Buffer.alloc(32).toString("base64") } },
            },
          },
        });

        commitCount++;
        return { key: { id: `msg-${commitCount}` } };
      }, meId);

      return result;
    };
  }

  // Helper: wrap keys with fault injection
  function wrapKeysWithFaultInjection(
    originalKeys: { get: (...args: unknown[]) => unknown; set: (...args: unknown[]) => unknown },
    opts: { failOnNthSet?: number } = {},
  ) {
    let setCallCount = 0;

    return {
      get: (...args: unknown[]) => (originalKeys.get as Function)(...args),
      set: async (data: unknown) => {
        setCallCount++;
        if (opts.failOnNthSet && setCallCount === opts.failOnNthSet) {
          throw new Error(`Simulated Postgres commit failure on set() call #${setCallCount}`);
        }
        return (originalKeys.set as Function)(data);
      },
    };
  }

  it("normal transaction: sendMessage succeeds, keys persisted to Postgres", async () => {
    const { state } = await usePostgresAuthState(pool!, "test-normal");
    const keysWithTx = addTransactionCapability(state.keys, testLogger, {
      maxCommitRetries: 3,
      delayBetweenTriesMs: 100,
    });

    const txSendMessage = makeTxSendMessage(keysWithTx);
    const { sock, emit } = createMockSocketWithTransactionSendMessage(txSendMessage);
    registerFirstContactWelcome(sock);

    await emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });

    // Both messages should have been sent successfully
    expect(sock.sendMessage).toHaveBeenCalledTimes(2);

    // Verify data was actually written to Postgres
    const { rows } = await pool!.query(
      `SELECT * FROM "WaAuthKey" WHERE "sessionId" = 'test-normal' AND "category" = 'sender-key-memory'`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("commit failure on 1st send: with per-call try/catch, 2nd send IS still attempted", async () => {
    const { state } = await usePostgresAuthState(pool!, "test-fail-1st");
    const faultyKeys = wrapKeysWithFaultInjection(state.keys as never, { failOnNthSet: 1 });
    const keysWithTx = addTransactionCapability(faultyKeys as never, testLogger, {
      maxCommitRetries: 1,
      delayBetweenTriesMs: 10,
    });

    const txSendMessage = makeTxSendMessage(keysWithTx);
    const { sock, emit } = createMockSocketWithTransactionSendMessage(txSendMessage);
    registerFirstContactWelcome(sock);

    await emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });

    // KEY ASSERTION: Both sends attempted thanks to per-call try/catch.
    // 1st send throws (commit fails) but 2nd is still tried.
    expect(sock.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("commit failure on 2nd send: 1st message delivered, 2nd fails but doesn't crash", async () => {
    const { state } = await usePostgresAuthState(pool!, "test-fail-2nd");
    const faultyKeys = wrapKeysWithFaultInjection(state.keys as never, { failOnNthSet: 2 });
    const keysWithTx = addTransactionCapability(faultyKeys as never, testLogger, {
      maxCommitRetries: 1,
      delayBetweenTriesMs: 10,
    });

    const txSendMessage = makeTxSendMessage(keysWithTx);
    const { sock, emit } = createMockSocketWithTransactionSendMessage(txSendMessage);
    registerFirstContactWelcome(sock);

    await emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });

    // Both sends attempted. 1st succeeds, 2nd fails but is caught.
    expect(sock.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("concurrent joins: transaction mutex serializes sends correctly", async () => {
    const { state } = await usePostgresAuthState(pool!, "test-concurrent");
    const keysWithTx = addTransactionCapability(state.keys, testLogger, {
      maxCommitRetries: 3,
      delayBetweenTriesMs: 100,
    });

    const txSendMessage = makeTxSendMessage(keysWithTx);
    const { sock, emit } = createMockSocketWithTransactionSendMessage(txSendMessage);
    registerFirstContactWelcome(sock);

    await emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [
        { id: "5511111111111@s.whatsapp.net" } as GroupParticipant,
        { id: "5522222222222@s.whatsapp.net" } as GroupParticipant,
      ],
      action: "add",
    });

    // 2 participants x 2 messages = 4 sends through the transaction layer
    expect(sock.sendMessage).toHaveBeenCalledTimes(4);
  });

  it("commit retry succeeds: sendMessage resolves after transient Postgres failure", async () => {
    const { state } = await usePostgresAuthState(pool!, "test-retry");

    let setCallCount = 0;
    const flakeyKeys = {
      get: (...args: unknown[]) => (state.keys.get as Function)(...args),
      set: async (data: unknown) => {
        setCallCount++;
        if (setCallCount === 1) {
          throw new Error("Transient Postgres error");
        }
        return state.keys.set(data as never);
      },
    };

    const keysWithTx = addTransactionCapability(flakeyKeys as never, testLogger, {
      maxCommitRetries: 3,
      delayBetweenTriesMs: 50,
    });

    const txSendMessage = makeTxSendMessage(keysWithTx);
    const { sock, emit } = createMockSocketWithTransactionSendMessage(txSendMessage);
    registerFirstContactWelcome(sock);

    await emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });

    // Both messages sent — retry on the first commit succeeded
    expect(sock.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("production scenario: welcome delivered but Promise rejects, form still attempted", async () => {
    // This reproduces the suspected production bug:
    // 1. sendMessage sends the welcome text to WhatsApp (inside the transaction)
    // 2. Transaction commit to Postgres FAILS
    // 3. sendMessage's Promise rejects
    // 4. WITHOUT per-call try/catch: the rejection propagates, skipping the form
    // 5. WITH our fix (per-call try/catch): the form is still attempted

    const { state } = await usePostgresAuthState(pool!, "test-production");

    const timeline: string[] = [];

    let setCallCount = 0;
    const faultyKeys = {
      get: (...args: unknown[]) => (state.keys.get as Function)(...args),
      set: async (data: unknown) => {
        setCallCount++;
        if (setCallCount === 1) {
          timeline.push("commit-1-failed");
          throw new Error("Postgres pool exhausted / connection reset");
        }
        timeline.push(`commit-${setCallCount}-ok`);
        return state.keys.set(data as never);
      },
    };

    const keysWithTx = addTransactionCapability(faultyKeys as never, testLogger, {
      maxCommitRetries: 1,
      delayBetweenTriesMs: 10,
    });

    let sendCount = 0;
    const txSendMessage = async (jid: string, _content: unknown) => {
      sendCount++;
      const myNum = sendCount;
      const meId = "5511888888888:0@s.whatsapp.net";

      const result = await keysWithTx.transaction(async () => {
        timeline.push(`msg-${myNum}-delivered`);

        await keysWithTx.set({
          "sender-key-memory": {
            [`${jid}--key-${myNum}`]: { dummy: true },
          },
        });

        return { key: { id: `msg-${myNum}` } };
      }, meId);

      timeline.push(`msg-${myNum}-promise-resolved`);
      return result;
    };

    const { sock, emit } = createMockSocketWithTransactionSendMessage(txSendMessage);
    registerFirstContactWelcome(sock);

    await emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });

    // CRITICAL: Both sends were attempted
    expect(sock.sendMessage).toHaveBeenCalledTimes(2);

    // Timeline verification
    expect(timeline).toContain("msg-1-delivered");
    expect(timeline).toContain("commit-1-failed");
    // msg 1 promise did NOT resolve (it threw)
    expect(timeline).not.toContain("msg-1-promise-resolved");

    // msg 2 WAS attempted (our per-call try/catch works)
    expect(timeline).toContain("msg-2-delivered");
  });
});
