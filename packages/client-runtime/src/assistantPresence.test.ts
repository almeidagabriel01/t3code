import { ASSISTANT_ICON_IDS, type Assistant } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ASSISTANT_ICONS, assistantIconFor } from "./assistantIcons.ts";
import {
  ASSISTANT_ACCENTS,
  assistantAccent,
  assistantPresenceSections,
  assistantPresenceStatus,
  assistantSenders,
  assistantThreadSenders,
  messageAssistantId,
} from "./assistantPresence.ts";

const jarvis = { id: "jarvis", name: "Jarvis" } as Assistant;

describe("assistantSenders", () => {
  it("groups an assistant's messages and skips everyone else's", () => {
    const senders = assistantSenders(
      [
        { id: "m1" },
        { id: "m2", senderThreadId: "assistant:jarvis:1" },
        { id: "m3", senderThreadId: "worker-thread" },
        { id: "m4", senderThreadId: "assistant:revisor:2" },
        { id: "m5", senderThreadId: "assistant:jarvis:3" },
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

  it.each([
    [{}, null],
    [{ senderThreadId: "plain-thread" }, null],
    [{ senderThreadId: "assistant:jarvis:1" }, "jarvis"],
  ])("reads the sender of %o", (message, expected) => {
    expect(messageAssistantId(message)).toBe(expected);
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

describe("presence rows", () => {
  it.each([
    [false, 1, false, "Idle · 1 message here"],
    [false, 6, false, "Idle · 6 messages here"],
    [true, 2, true, "Working · 2 messages here · Asks before acting"],
    [true, 0, true, "Working · Asks before acting"],
  ])("working %s, %i messages, asks %s → %s", (working, count, asks, expected) => {
    expect(assistantPresenceStatus(working, { count }, asks)).toBe(expected);
  });

  it.each([
    { name: "mixed", working: ["b", "d"], expected: { working: ["b", "d"], idle: ["a", "c"] } },
    { name: "all idle", working: [], expected: { working: [], idle: ["a", "b", "c", "d"] } },
    {
      name: "all working",
      working: ["a", "b", "c", "d"],
      expected: { working: ["a", "b", "c", "d"], idle: [] },
    },
  ])("lists Working before Idle in speaking order: $name", ({ working, expected }) => {
    expect(assistantPresenceSections(["a", "b", "c", "d"], (id) => working.includes(id))).toEqual(
      expected,
    );
  });
});
