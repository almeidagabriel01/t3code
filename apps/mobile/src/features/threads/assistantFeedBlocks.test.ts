import type { TeammateMessagePart } from "@t3tools/client-runtime/teammateMessage";
import { describe, expect, it } from "vite-plus/test";

import { assistantContinuedMessageIds, assistantFeedBlocks } from "./assistantFeedBlocks";

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
        joins: ["jarvis"],
        continued: true,
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
          showTimestamp: true,
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
        joins: ["front"],
        continued: true,
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
          showTimestamp: false,
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
          showTimestamp: true,
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
        joins: undefined,
        continued: false,
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
          showTimestamp: true,
          continues: false,
          long: true,
        },
      ],
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

it("assistantContinuedMessageIds: only back-to-back messages of one assistant continue", () => {
  const from = (id: string, assistant: string) => ({
    id,
    role: "user",
    text: "hi",
    createdBy: "agent" as const,
    senderThreadId: `assistant:${assistant}:1`,
  });
  const continued = assistantContinuedMessageIds([
    from("a1", "ada"),
    from("a2", "ada"),
    null,
    from("a3", "ada"),
    from("b1", "bo"),
    from("b2", "bo"),
  ]);
  expect([...continued]).toEqual(["a2", "b2"]);
});
