import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AssistantGroupMessage,
  AssistantGroupsPostInput,
  assistantGroupLeadingAddress,
  assistantGroupTaskActions,
  isAssistantGroupThreadId,
  splitAssistantTransferText,
} from "./assistantGroups.ts";

const ada = { id: "ada", handle: "ada", name: "Ada" };
const beto = { id: "beto", handle: "beto-r", name: "Beto Rocha" };
const members = [ada, beto];

describe("assistantGroupLeadingAddress", () => {
  it.each([
    ["@ada what now?", [ada]],
    ["@ada @beto-r compare", [ada, beto]],
    ["  @Ada, @betorocha: compare", [ada, beto]],
    ["@ada @ada twice", [ada]],
    ["@everyone status?", members],
    ["@ada @everyone", members],
    ["@nobody hi", null],
    ["@ada @nobody hi", [ada]],
    ["hi @ada", null],
    ["no mention", null],
  ])("%s", (text, expected) => {
    expect(assistantGroupLeadingAddress(text, members)).toEqual(expected);
  });

  it("@everyone in an empty group names no one", () => {
    expect(assistantGroupLeadingAddress("@everyone hi", [])).toBeNull();
  });
});

describe("assistantGroupTaskActions", () => {
  it.each([
    ["queued", ["stop"]],
    ["running", ["stop"]],
    ["waiting", ["stop"]],
    ["paused", ["resume", "reassign", "cancel"]],
    ["failed", ["resume", "reassign", "cancel"]],
    ["completed", []],
    ["cancelled", []],
  ] as const)("%s", (status, expected) => {
    expect(assistantGroupTaskActions({ status })).toEqual(expected);
  });
});

it.each([
  ["assistant:ada:g-0123456789abcdef", true],
  ["assistant:ada:3", false],
  ["assistant:ada:g-0123", false],
  ["thread-1:g-0123456789abcdef", false],
])("isAssistantGroupThreadId(%s)", (threadId, expected) => {
  expect(isAssistantGroupThreadId(threadId)).toBe(expected);
});

it.each([
  ["plain text", { body: "plain text", files: null }],
  [
    "@beto see this\nFiles copied to the shared folder for you:\n- [a.csv](</s/a.csv>)",
    { body: "@beto see this", files: "- [a.csv](</s/a.csv>)" },
  ],
])("splitAssistantTransferText(%s)", (text, expected) => {
  expect(splitAssistantTransferText(text)).toEqual(expected);
});

describe("group message attachments", () => {
  const image = {
    type: "image",
    id: "pending-1",
    name: "a.png",
    mimeType: "image/png",
    sizeBytes: 3,
  };
  const file = {
    type: "file",
    id: "pending-2",
    name: "a.pdf",
    mimeType: "application/pdf",
    sizeBytes: 5,
  };
  const message = {
    id: "gm:1",
    teamId: "t1",
    seq: 1,
    author: "user",
    assistantId: null,
    authorLabel: null,
    kind: "message",
    text: "@ada look",
    replyToMessageId: null,
    taskId: null,
    createdAt: "2026-11-09T10:00:00.000Z",
  };

  it("decodes a message with images and files, and one from an older server without any", () => {
    const decode = Schema.decodeUnknownSync(AssistantGroupMessage);
    expect(decode({ ...message, attachments: [image, file] }).attachments).toHaveLength(2);
    expect(decode(message).attachments).toBeUndefined();
  });

  it("accepts attachments on a post and refuses more than a turn can carry", () => {
    const decode = Schema.decodeUnknownSync(AssistantGroupsPostInput);
    const post = { teamId: "t1", text: "@ada look" };
    expect(decode({ ...post, attachments: [image, file] }).attachments).toHaveLength(2);
    expect(decode(post).attachments).toBeUndefined();
    expect(() =>
      decode({ ...post, attachments: Array.from({ length: 101 }, () => image) }),
    ).toThrow();
  });
});
