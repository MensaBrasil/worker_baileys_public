import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GroupParticipant, WASocket, BaileysEventMap } from "baileys";

// Mock dependencies before importing the module under test
vi.mock("../db/redis", () => ({
  tryAcquireFirstContactLock: vi.fn(),
}));

vi.mock("../utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({
  promises: {
    readFile: vi.fn().mockResolvedValue(Buffer.from("fake-audio-data")),
  },
}));

import {
  normalizeParticipantId,
  jidToDigitsKey,
  participantTag,
  registerFirstContactWelcome,
} from "./firstContactWelcome";
import { tryAcquireFirstContactLock } from "../db/redis";

// ──────────────────────────────────────────────────────────────────────
// Pure function tests
// ──────────────────────────────────────────────────────────────────────

describe("jidToDigitsKey", () => {
  it("extracts digits from a PN JID", () => {
    expect(jidToDigitsKey("5511999999999@s.whatsapp.net")).toBe("5511999999999");
  });

  it("extracts digits from a LID JID (strips :device suffix)", () => {
    expect(jidToDigitsKey("123456789:0@lid")).toBe("123456789");
  });

  it("extracts digits from a bare number", () => {
    expect(jidToDigitsKey("5511999999999")).toBe("5511999999999");
  });

  it("returns original string for non-numeric JID", () => {
    expect(jidToDigitsKey("status@broadcast")).toBe("status@broadcast");
  });

  it("handles group JID", () => {
    expect(jidToDigitsKey("120363123456789@g.us")).toBe("120363123456789");
  });
});

describe("normalizeParticipantId", () => {
  it("returns null for null/undefined", () => {
    expect(normalizeParticipantId(null)).toBeNull();
    expect(normalizeParticipantId(undefined)).toBeNull();
  });

  it("returns the string directly if given a string", () => {
    expect(normalizeParticipantId("5511999@s.whatsapp.net")).toBe("5511999@s.whatsapp.net");
  });

  it("prefers phoneNumber over id (LID scenario)", () => {
    const participant = {
      id: "123456:0@lid",
      phoneNumber: "5511999999999@s.whatsapp.net",
      lid: "123456:0@lid",
    } as GroupParticipant;
    expect(normalizeParticipantId(participant)).toBe("5511999999999@s.whatsapp.net");
  });

  it("falls back to id when phoneNumber is not set", () => {
    const participant = {
      id: "5511999999999@s.whatsapp.net",
    } as GroupParticipant;
    expect(normalizeParticipantId(participant)).toBe("5511999999999@s.whatsapp.net");
  });

  it("falls back to id when phoneNumber is empty string", () => {
    const participant = {
      id: "123456:0@lid",
      phoneNumber: "",
    } as GroupParticipant;
    expect(normalizeParticipantId(participant)).toBe("123456:0@lid");
  });

  it("falls back through jid, lid, user fields", () => {
    // Only lid set
    const p = { lid: "123:0@lid" } as unknown as GroupParticipant;
    expect(normalizeParticipantId(p)).toBe("123:0@lid");
  });
});

describe("participantTag", () => {
  it("extracts part before @", () => {
    expect(participantTag("5511999@s.whatsapp.net")).toBe("5511999");
  });

  it("extracts part before @ for LID", () => {
    expect(participantTag("123456:0@lid")).toBe("123456:0");
  });

  it("returns empty for null", () => {
    expect(participantTag(null)).toBe("");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Integration tests with mocked socket
// ──────────────────────────────────────────────────────────────────────

type EventHandler<K extends keyof BaileysEventMap> = (data: BaileysEventMap[K]) => Promise<void> | void;

function createMockSocket() {
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
    sendMessage: vi.fn().mockResolvedValue({ key: { id: "msg-id" } }),
    groupMetadata: vi.fn().mockResolvedValue({
      id: "group-id@g.us",
      subject: "Primeiro Contato",
      participants: [],
    }),
  } as unknown as WASocket;

  const emit = async <K extends keyof BaileysEventMap>(event: K, data: BaileysEventMap[K]) => {
    const list = handlers.get(event) ?? [];
    for (const handler of list) {
      await (handler as EventHandler<K>)(data);
    }
  };

  return { sock, emit, handlers };
}

describe("registerFirstContactWelcome - welcome flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.FIRST_CONTACT_GROUP_NAME = "Primeiro Contato";
    vi.mocked(tryAcquireFirstContactLock).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.FIRST_CONTACT_GROUP_NAME;
    vi.restoreAllMocks();
  });

  it("sends welcome text then sends form text", async () => {
    const { sock, emit } = createMockSocket();
    registerFirstContactWelcome(sock);

    const sendMessage = vi.mocked(sock.sendMessage);

    // Simulate a participant joining
    const updatePromise = emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });

    // Let the sendMessage calls resolve
    await vi.advanceTimersByTimeAsync(100);
    await updatePromise;

    // Should have sent exactly 2 messages: welcome text + form
    expect(sendMessage).toHaveBeenCalledTimes(2);

    // First call: welcome text with mentions
    const firstCall = sendMessage.mock.calls[0]!;
    expect(firstCall[0]).toBe("group-id@g.us");
    expect(firstCall[1]).toHaveProperty("text");
    expect(firstCall[1]).toHaveProperty("mentions");
    expect((firstCall[1] as { text: string }).text).toContain("novo mensan");

    // Second call: form text
    const secondCall = sendMessage.mock.calls[1]!;
    expect(secondCall[0]).toBe("group-id@g.us");
    expect((secondCall[1] as { text: string }).text).toContain("Nome (pronome?)");
  });

  it("continues sending form even if welcome text fails", async () => {
    const { sock, emit } = createMockSocket();
    const sendMessage = vi.mocked(sock.sendMessage);

    // First call (welcome text) rejects, second call (form) succeeds
    sendMessage.mockRejectedValueOnce(new Error("send failed")).mockResolvedValueOnce({ key: { id: "msg2" } } as never);

    registerFirstContactWelcome(sock);

    const updatePromise = emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });

    await vi.advanceTimersByTimeAsync(100);
    await updatePromise;

    // Both calls should have been attempted
    expect(sendMessage).toHaveBeenCalledTimes(2);

    // Second call is the form, and it should succeed
    const secondCall = sendMessage.mock.calls[1]!;
    expect((secondCall[1] as { text: string }).text).toContain("Nome (pronome?)");
  });

  it("skips welcome when lock is already held by another worker", async () => {
    vi.mocked(tryAcquireFirstContactLock).mockResolvedValue(false);

    const { sock, emit } = createMockSocket();
    registerFirstContactWelcome(sock);

    await emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });

    expect(vi.mocked(sock.sendMessage)).not.toHaveBeenCalled();
  });
});

describe("registerFirstContactWelcome - audio reply flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.FIRST_CONTACT_GROUP_NAME = "Primeiro Contato";
    vi.mocked(tryAcquireFirstContactLock).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.FIRST_CONTACT_GROUP_NAME;
    vi.restoreAllMocks();
  });

  it("sends audio when participant replies '1'", async () => {
    const { sock, emit } = createMockSocket();
    const sendMessage = vi.mocked(sock.sendMessage);
    registerFirstContactWelcome(sock);

    // First: simulate participant join
    const joinPromise = emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });
    await vi.advanceTimersByTimeAsync(100);
    await joinPromise;

    sendMessage.mockClear();

    // Then: simulate the "1" reply
    const replyPromise = emit("messages.upsert", {
      messages: [
        {
          key: {
            remoteJid: "group-id@g.us",
            participant: "5511999999999@s.whatsapp.net",
            fromMe: false,
            id: "reply-msg-id",
          },
          message: { conversation: "1" },
        },
      ] as BaileysEventMap["messages.upsert"]["messages"],
      type: "notify",
    });
    await vi.advanceTimersByTimeAsync(100);
    await replyPromise;

    // Should have sent the audio
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = sendMessage.mock.calls[0]!;
    expect(call[0]).toBe("group-id@g.us");
    expect(call[1]).toHaveProperty("audio");
    expect(call[1]).toHaveProperty("mimetype", "audio/mpeg");
  });

  it("matches audio request when JID format differs (LID join, PN reply)", async () => {
    const { sock, emit } = createMockSocket();
    const sendMessage = vi.mocked(sock.sendMessage);
    registerFirstContactWelcome(sock);

    // Join event uses LID format but with phoneNumber available
    const joinPromise = emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@lid",
      participants: [
        {
          id: "123456789:0@lid",
          phoneNumber: "5511999999999@s.whatsapp.net",
        } as GroupParticipant,
      ],
      action: "add",
    });
    await vi.advanceTimersByTimeAsync(100);
    await joinPromise;

    sendMessage.mockClear();

    // Reply comes with PN format participant
    const replyPromise = emit("messages.upsert", {
      messages: [
        {
          key: {
            remoteJid: "group-id@g.us",
            participant: "5511999999999@s.whatsapp.net",
            fromMe: false,
            id: "reply-msg-id",
          },
          message: { conversation: "1" },
        },
      ] as BaileysEventMap["messages.upsert"]["messages"],
      type: "notify",
    });
    await vi.advanceTimersByTimeAsync(100);
    await replyPromise;

    // Should still match and send audio
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toHaveProperty("audio");
  });

  it("does NOT send audio for non-'1' replies", async () => {
    const { sock, emit } = createMockSocket();
    const sendMessage = vi.mocked(sock.sendMessage);
    registerFirstContactWelcome(sock);

    // Join
    const joinPromise = emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });
    await vi.advanceTimersByTimeAsync(100);
    await joinPromise;

    sendMessage.mockClear();

    // Reply with "hello" instead of "1"
    await emit("messages.upsert", {
      messages: [
        {
          key: {
            remoteJid: "group-id@g.us",
            participant: "5511999999999@s.whatsapp.net",
            fromMe: false,
            id: "reply-msg-id",
          },
          message: { conversation: "hello" },
        },
      ] as BaileysEventMap["messages.upsert"]["messages"],
      type: "notify",
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("handles audio send failure gracefully (does not throw)", async () => {
    const { sock, emit } = createMockSocket();
    const sendMessage = vi.mocked(sock.sendMessage);
    registerFirstContactWelcome(sock);

    // Join
    const joinPromise = emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });
    await vi.advanceTimersByTimeAsync(100);
    await joinPromise;

    // Make audio send fail
    sendMessage.mockRejectedValueOnce(new Error("media upload failed"));

    // Should not throw
    const replyPromise = emit("messages.upsert", {
      messages: [
        {
          key: {
            remoteJid: "group-id@g.us",
            participant: "5511999999999@s.whatsapp.net",
            fromMe: false,
            id: "reply-msg-id",
          },
          message: { conversation: "1" },
        },
      ] as BaileysEventMap["messages.upsert"]["messages"],
      type: "notify",
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(replyPromise).resolves.toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Additional mocked-socket scenarios
// ──────────────────────────────────────────────────────────────────────

describe("registerFirstContactWelcome - multiple participants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.FIRST_CONTACT_GROUP_NAME = "Primeiro Contato";
    vi.mocked(tryAcquireFirstContactLock).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.FIRST_CONTACT_GROUP_NAME;
    vi.restoreAllMocks();
  });

  it("sends welcome + form for EACH new participant in a batch add", async () => {
    const { sock, emit } = createMockSocket();
    const sendMessage = vi.mocked(sock.sendMessage);
    registerFirstContactWelcome(sock);

    const updatePromise = emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [
        { id: "5511111111111@s.whatsapp.net" } as GroupParticipant,
        { id: "5522222222222@s.whatsapp.net" } as GroupParticipant,
      ],
      action: "add",
    });

    // Each participant needs: welcome(send) + form(send)
    // Two participants = 4 sends
    await vi.advanceTimersByTimeAsync(100);
    await updatePromise;

    // 2 participants × 2 messages each = 4 sendMessage calls
    expect(sendMessage).toHaveBeenCalledTimes(4);

    // First participant: welcome + form
    expect((sendMessage.mock.calls[0]![1] as { text: string }).text).toContain("novo mensan");
    expect((sendMessage.mock.calls[0]![1] as { mentions: string[] }).mentions).toEqual([
      "5511111111111@s.whatsapp.net",
    ]);
    expect((sendMessage.mock.calls[1]![1] as { text: string }).text).toContain("Nome (pronome?)");

    // Second participant: welcome + form
    expect((sendMessage.mock.calls[2]![1] as { text: string }).text).toContain("novo mensan");
    expect((sendMessage.mock.calls[2]![1] as { mentions: string[] }).mentions).toEqual([
      "5522222222222@s.whatsapp.net",
    ]);
    expect((sendMessage.mock.calls[3]![1] as { text: string }).text).toContain("Nome (pronome?)");
  });

  it("skips the bot's own JID when it appears in participants", async () => {
    const { sock, emit } = createMockSocket();
    const sendMessage = vi.mocked(sock.sendMessage);
    registerFirstContactWelcome(sock);

    const updatePromise = emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [
        // Bot's own JID (matches sock.user.id)
        { id: "5511888888888:0@s.whatsapp.net" } as GroupParticipant,
        { id: "5511999999999@s.whatsapp.net" } as GroupParticipant,
      ],
      action: "add",
    });

    await vi.advanceTimersByTimeAsync(100);
    await updatePromise;

    // Only the non-bot participant should get messages (welcome + form = 2)
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe("registerFirstContactWelcome - Mensampa Regional group", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Enable both groups
    process.env.FIRST_CONTACT_GROUP_NAME = "Primeiro Contato";
    vi.mocked(tryAcquireFirstContactLock).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.FIRST_CONTACT_GROUP_NAME;
    vi.restoreAllMocks();
  });

  it("sends Mensampa Regional welcome text for that group", async () => {
    const { sock, emit } = createMockSocket();
    const sendMessage = vi.mocked(sock.sendMessage);
    const groupMetadata = vi.mocked(sock.groupMetadata);

    // Return "Mensampa Regional" for this group
    groupMetadata.mockResolvedValue({
      id: "mensampa-group@g.us",
      subject: "Mensampa Regional",
      participants: [],
    } as never);

    registerFirstContactWelcome(sock);

    const updatePromise = emit("group-participants.update", {
      id: "mensampa-group@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });

    await vi.advanceTimersByTimeAsync(100);
    await updatePromise;

    // Should send the Mensampa Regional welcome (1 message, not the first contact welcome+form)
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const text = (sendMessage.mock.calls[0]![1] as { text: string }).text;
    expect(text).toContain("Seja muito bem-vindo(a)!");
    expect(text).toContain("regras disponíveis na descrição do grupo");
  });

  it("does NOT send first contact welcome for Mensampa Regional group", async () => {
    const { sock, emit } = createMockSocket();
    const sendMessage = vi.mocked(sock.sendMessage);
    const groupMetadata = vi.mocked(sock.groupMetadata);

    groupMetadata.mockResolvedValue({
      id: "mensampa-group@g.us",
      subject: "Mensampa Regional",
      participants: [],
    } as never);

    registerFirstContactWelcome(sock);

    const updatePromise = emit("group-participants.update", {
      id: "mensampa-group@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });

    await vi.advanceTimersByTimeAsync(100);
    await updatePromise;

    // None of the messages should contain the first contact form
    for (const call of sendMessage.mock.calls) {
      const text = (call[1] as { text?: string }).text ?? "";
      expect(text).not.toContain("Nome (pronome?)");
    }
  });
});

describe("registerFirstContactWelcome - groupMetadata failure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.FIRST_CONTACT_GROUP_NAME = "Primeiro Contato";
    vi.mocked(tryAcquireFirstContactLock).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.FIRST_CONTACT_GROUP_NAME;
    vi.restoreAllMocks();
  });

  it("does not send any messages when groupMetadata throws", async () => {
    const { sock, emit } = createMockSocket();
    const sendMessage = vi.mocked(sock.sendMessage);
    const groupMetadata = vi.mocked(sock.groupMetadata);

    groupMetadata.mockRejectedValue(new Error("group metadata not available"));

    registerFirstContactWelcome(sock);

    await emit("group-participants.update", {
      id: "unknown-group@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });

    // groupMetadata failed, group not matched → no messages
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("ignores 'remove' actions", async () => {
    const { sock, emit } = createMockSocket();
    const sendMessage = vi.mocked(sock.sendMessage);
    registerFirstContactWelcome(sock);

    await emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "remove",
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("ignores events with empty participants array", async () => {
    const { sock, emit } = createMockSocket();
    const sendMessage = vi.mocked(sock.sendMessage);
    registerFirstContactWelcome(sock);

    await emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [],
      action: "add",
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("registerFirstContactWelcome - sendMessage failure simulation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.FIRST_CONTACT_GROUP_NAME = "Primeiro Contato";
    vi.mocked(tryAcquireFirstContactLock).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.FIRST_CONTACT_GROUP_NAME;
    vi.restoreAllMocks();
  });

  it("still registers audio pending even if welcome text throws (form still sent)", async () => {
    const { sock, emit } = createMockSocket();
    const sendMessage = vi.mocked(sock.sendMessage);

    // Welcome throws, form succeeds
    sendMessage
      .mockRejectedValueOnce(new Error("transaction commit failed"))
      .mockResolvedValueOnce({ key: { id: "form-msg" } } as never);

    registerFirstContactWelcome(sock);

    const joinPromise = emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });
    await vi.advanceTimersByTimeAsync(100);
    await joinPromise;

    // Both sends attempted
    expect(sendMessage).toHaveBeenCalledTimes(2);

    sendMessage.mockClear();

    // Now the participant replies "1" — audio should still be pending
    const replyPromise = emit("messages.upsert", {
      messages: [
        {
          key: {
            remoteJid: "group-id@g.us",
            participant: "5511999999999@s.whatsapp.net",
            fromMe: false,
            id: "reply-msg-id",
          },
          message: { conversation: "1" },
        },
      ] as BaileysEventMap["messages.upsert"]["messages"],
      type: "notify",
    });
    await vi.advanceTimersByTimeAsync(100);
    await replyPromise;

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toHaveProperty("audio");
  });

  it("both welcome and form fail — still does not throw (outer catch works)", async () => {
    const { sock, emit } = createMockSocket();
    const sendMessage = vi.mocked(sock.sendMessage);

    sendMessage
      .mockRejectedValueOnce(new Error("send failed 1"))
      .mockRejectedValueOnce(new Error("send failed 2"));

    registerFirstContactWelcome(sock);

    const updatePromise = emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });
    await vi.advanceTimersByTimeAsync(100);

    // Should not throw
    await expect(updatePromise).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("Redis lock null → skips welcome entirely (continue statement)", async () => {
    vi.mocked(tryAcquireFirstContactLock).mockResolvedValue(null);

    const { sock, emit } = createMockSocket();
    registerFirstContactWelcome(sock);

    const updatePromise = emit("group-participants.update", {
      id: "group-id@g.us",
      author: "author@s.whatsapp.net",
      participants: [{ id: "5511999999999@s.whatsapp.net" } as GroupParticipant],
      action: "add",
    });
    await vi.advanceTimersByTimeAsync(100);
    await updatePromise;

    expect(vi.mocked(sock.sendMessage)).not.toHaveBeenCalled();
  });
});
