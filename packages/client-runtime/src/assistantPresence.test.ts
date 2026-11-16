import { ASSISTANT_ICON_IDS, ThreadId, type Assistant } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ASSISTANT_ICONS, assistantIconFor } from "./assistantIcons.ts";
import {
  ASSISTANT_ACCENTS,
  assistantAccent,
  assistantJoins,
  assistantPresenceSections,
  assistantPresenceStatus,
  assistantSenderLook,
  assistantSenders,
  assistantThreadSenders,
  continuesAssistantSender,
  messageAssistantId,
} from "./assistantPresence.ts";

const jarvis = { id: "jarvis", name: "Jarvis" } as Assistant;

const sent = (id: string, senderThreadId?: string, text = "hi") => ({
  id,
  role: "user",
  text,
  createdBy: "agent" as const,
  ...(senderThreadId === undefined ? {} : { senderThreadId }),
});
const reply = (name: string, threadId: string) => ({
  kind: "reply" as const,
  name,
  handle: name.toLowerCase(),
  threadId: ThreadId.make(threadId),
  requestId: `g:to:${name}`,
  files: [],
  text: "ok",
});
const groupReplies = {
  context: {
    teammate: { entries: [reply("Ada", "assistant:ada:1"), reply("Bo", "assistant:bo:1")] },
  },
};

describe("assistantSenders", () => {
  it("groups an assistant's messages and skips everyone else's", () => {
    const senders = assistantSenders(
      [
        sent("m1"),
        sent("m2", "assistant:jarvis:1"),
        sent("m3", "worker-thread"),
        sent("m4", "assistant:revisor:2"),
        sent("m5", "assistant:jarvis:3"),
      ],
      [jarvis],
    );
    expect(senders).toEqual([
      {
        assistantId: "jarvis",
        assistant: jarvis,
        firstMessageId: "m2",
        lastMessageId: "m5",
        count: 2,
      },
      {
        assistantId: "revisor",
        assistant: null,
        firstMessageId: "m4",
        lastMessageId: "m4",
        count: 1,
      },
    ]);
  });

  it("counts each teammate of a group's replies, not the one that delivered them", () => {
    const messages = [
      sent("m1", "assistant:ada:1"),
      { ...sent("m2", "assistant:bo:1"), ...groupReplies },
      sent("m3", "assistant:bo:1"),
    ];
    expect(assistantSenders(messages, []).map((s) => [s.assistantId, s.count])).toEqual([
      ["ada", 2],
      ["bo", 2],
    ]);
    expect([...assistantJoins(messages)]).toEqual([
      ["m1", ["ada"]],
      ["m2", ["bo"]],
    ]);
  });

  it.each([
    [{}, null],
    [{ senderThreadId: "plain-thread" }, null],
    [{ senderThreadId: "assistant:jarvis:1" }, "jarvis"],
  ])("reads the sender of %o", (message, expected) => {
    expect(messageAssistantId(message)).toBe(expected);
  });
});

describe("continuesAssistantSender", () => {
  const from = (assistant: string, text = "hi") => ({
    role: "user",
    text,
    createdBy: "agent" as const,
    senderThreadId: `assistant:${assistant}:1`,
  });
  const group = { ...from("ada"), ...groupReplies };
  it.each([
    ["the same assistant again", from("ada"), from("ada"), true],
    ["another assistant", from("ada"), from("bo"), false],
    ["the first message", from("ada"), undefined, false],
    ["after an answer", from("ada"), { ...from("ada"), role: "assistant" }, false],
    ["after a person's message", from("ada"), { role: "user", text: "hi" }, false],
    ["after a group's replies", from("ada"), group, false],
    ["a group's replies", group, from("ada"), false],
  ])("%s", (_name, message, previous, expected) => {
    expect(continuesAssistantSender(message, previous)).toBe(expected);
  });
});

describe("assistantThreadSenders", () => {
  const qa = { id: "qa", name: "QA" } as Assistant;
  const sender = (assistant: Assistant, count: number) => ({
    assistantId: assistant.id,
    assistant,
    firstMessageId: `${assistant.id}-1`,
    lastMessageId: `${assistant.id}-${count}`,
    count,
  });
  const ownerOnly = { assistantId: "qa", assistant: qa, firstMessageId: "", lastMessageId: "" };
  it.each([
    { name: "no task, no senders", senders: [], owner: null, expected: [] },
    { name: "a sender only", senders: [sender(jarvis, 2)], owner: null, expected: ["jarvis:2"] },
    { name: "the owner with no message", senders: [], owner: qa, expected: ["qa:0"] },
    { name: "the owner who also wrote", senders: [sender(qa, 2)], owner: qa, expected: ["qa:2"] },
    {
      name: "the owner and another sender",
      senders: [sender(jarvis, 1)],
      owner: qa,
      expected: ["qa:0", "jarvis:1"],
    },
  ])("one entry per assistant: $name", ({ senders, owner, expected }) => {
    const merged = assistantThreadSenders(senders, owner);
    expect(merged.map((entry) => `${entry.assistantId}:${entry.count}`)).toEqual(expected);
    if (owner !== null && !senders.some((entry) => entry.assistantId === owner.id)) {
      expect(merged[0]).toEqual({ ...ownerOnly, count: 0 });
    }
  });
});

describe("assistant icons", () => {
  it("has one drawable definition per contract id and ignores unknown ids", () => {
    expect(ASSISTANT_ICONS.map((icon) => icon.id)).toEqual([...ASSISTANT_ICON_IDS]);
    for (const icon of ASSISTANT_ICONS) {
      expect(icon.label).not.toBe("");
      expect(icon.paths.length).toBeGreaterThan(0);
      expect(assistantIconFor(icon.id)).toBe(icon);
    }
    expect([
      assistantIconFor(null),
      assistantIconFor(undefined),
      assistantIconFor("laser"),
    ]).toEqual([null, null, null]);
  });
});

describe("assistant look", () => {
  it("keeps one accent per assistant and an uppercase initial", () => {
    expect(assistantAccent("jarvis")).toBe(assistantAccent("jarvis"));
    expect(ASSISTANT_ACCENTS).toContain(assistantAccent("revisor"));
  });
});

describe("assistantSenderLook", () => {
  const status = (mood: string) => ({ mood, reading: false, since: null }) as never;
  const qa = { assistant: { id: "qa" } as Assistant };
  it.each([
    { mood: "needs", expected: ["waiting", "needs"] },
    { mood: "working", expected: ["working", "working"] },
    { mood: "failed", expected: ["failed", "idle"] },
    { mood: "idle", expected: ["idle", "idle"] },
  ] as const)("face and section agree: $mood", ({ mood, expected }) => {
    const look = assistantSenderLook(qa, status(mood));
    expect([look.face, look.section]).toEqual(expected);
  });

  it("a removed assistant sleeps", () => {
    expect(assistantSenderLook({ assistant: null }, status("working"))).toEqual({
      face: "sleeping",
      section: "working",
    });
  });
});

describe("presence rows", () => {
  it.each([
    ["idle", 1, false, "Idle · 1 message here"],
    ["idle", 6, false, "Idle · 6 messages here"],
    ["working", 2, true, "Working · 2 messages here · Asks before acting"],
    ["needs", 2, false, "Needs you · 2 messages here"],
    ["working", 0, true, "Working · Asks before acting"],
  ] as const)("%s, %i messages, asks %s → %s", (section, count, asks, expected) => {
    expect(assistantPresenceStatus(section, { count }, asks)).toBe(expected);
  });

  it("lists Needs you, then Working, then Idle, in speaking order", () => {
    const sectionOf = (id: string) =>
      id === "c"
        ? ("needs" as const)
        : id === "b" || id === "d"
          ? ("working" as const)
          : ("idle" as const);
    expect(assistantPresenceSections(["a", "b", "c", "d", "e"], sectionOf)).toEqual({
      needs: ["c"],
      working: ["b", "d"],
      idle: ["a", "e"],
    });
  });
});
