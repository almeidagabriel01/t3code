import { ASSISTANT_ICON_IDS, type Assistant } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ASSISTANT_ICONS, assistantIconFor } from "./assistantIcons.ts";
import {
  ASSISTANT_ACCENTS,
  assistantAccent,
  assistantInitial,
  assistantSenders,
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
    expect(assistantInitial(" bia ")).toBe("B");
    expect(assistantInitial("")).toBe("?");
  });
});
