import type { TeammateMessagePart } from "@t3tools/client-runtime/teammateMessage";
import { describe, expect, it } from "vite-plus/test";

import { assistantFeedBlocks, assistantFeedIndex } from "./assistantFeedBlocks";

const part = (overrides: Partial<TeammateMessagePart>): TeammateMessagePart => ({
  kind: "reply",
  name: "Front",
  handle: "front",
  threadId: "assistant:front:1",
  requestId: "g:to:front",
  expectsReply: undefined,
  status: "done",
  files: [],
  text: "Feito.",
  ...overrides,
});

describe("assistantFeedBlocks", () => {
  it.each([
    [
      "an assistant's plain message, under its sender",
      {
        parts: undefined,
        presenceAssistantId: "jarvis",
        index: { joins: new Map([["m1", ["jarvis"]]]), continued: new Set(["m1"]) },
      },
      [
        {
          key: "m1",
          assistantId: "jarvis",
          threadId: "assistant:jarvis:1",
          fallbackName: undefined,
          status: undefined,
          text: "oi",
          joined: true,
          continues: true,
          long: false,
        },
      ],
    ],
    [
      "a group's replies, one block each, the time on the last",
      {
        parts: [
          part({ files: ["/shared/f/shot.png"] }),
          part({
            name: "Back",
            threadId: "assistant:back:1",
            requestId: "g:to:back",
            status: "blocked",
            text: "Falhou.",
          }),
        ],
        presenceAssistantId: "back",
        index: { joins: new Map([["m1", ["front"]]]), continued: new Set(["m1"]) },
      },
      [
        {
          key: "reply:assistant:front:1:g:to:front",
          assistantId: "front",
          threadId: "assistant:front:1",
          fallbackName: "Front",
          status: "done",
          text: "Feito.\n\n- [shot.png](</shared/f/shot.png>)",
          joined: true,
          continues: false,
          long: false,
        },
        {
          key: "reply:assistant:back:1:g:to:back",
          assistantId: "back",
          threadId: "assistant:back:1",
          fallbackName: "Back",
          status: "blocked",
          text: "Falhou.",
          joined: false,
          continues: false,
          long: false,
        },
      ],
    ],
    [
      "a teammate on a thread that is not an assistant's, under that thread",
      {
        parts: [part({ threadId: "worker", text: "x".repeat(2_000) })],
        presenceAssistantId: null,
        index: { joins: new Map(), continued: new Set<string>() },
      },
      [
        {
          key: "reply:worker:g:to:front",
          assistantId: "worker",
          threadId: "worker",
          fallbackName: "Front",
          status: "done",
          text: "x".repeat(2_000),
          joined: false,
          continues: false,
          long: true,
        },
      ],
    ],
    [
      "anyone else's message as nothing of its own",
      {
        parts: undefined,
        presenceAssistantId: null,
        index: { joins: new Map(), continued: new Set<string>() },
      },
      null,
    ],
  ])("shows %s", (_name, input, expected) => {
    expect(
      assistantFeedBlocks({
        message: { id: "m1", senderThreadId: "assistant:jarvis:1" },
        renderedText: "oi",
        ...input,
      }),
    ).toEqual(expected);
  });
});

it("assistantFeedIndex: joins on first messages, continues only back-to-back runs", () => {
  const from = (id: string, assistant: string) => ({
    type: "message",
    message: {
      id,
      role: "user",
      text: "hi",
      createdBy: "agent" as const,
      senderThreadId: `assistant:${assistant}:1`,
    },
  });
  const index = assistantFeedIndex([
    from("a1", "ada"),
    from("a2", "ada"),
    { type: "activity-group" },
    from("a3", "ada"),
    from("b1", "bo"),
    from("b2", "bo"),
  ]);
  expect([...index.continued]).toEqual(["a2", "b2"]);
  expect([...index.joins]).toEqual([
    ["a1", ["ada"]],
    ["b1", ["bo"]],
  ]);
});
