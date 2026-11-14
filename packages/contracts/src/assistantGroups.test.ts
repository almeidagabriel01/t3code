import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AssistantGroupMessage,
  AssistantGroupsEvent,
  AssistantGroupsPostInput,
  assistantGroupAddress,
  assistantGroupMentions,
  assistantGroupTaskActions,
  isAssistantGroupThreadId,
  splitAssistantTransferText,
} from "./assistantGroups.ts";

const ada = { id: "ada", handle: "ada", name: "Ada" };
const beto = { id: "beto", handle: "beto-r", name: "Beto Rocha" };
const ana = { id: "ana", handle: "ana-p", name: "Ana Paula" };
const anaMaria = { id: "anam", handle: "anam", name: "Ana Paula Maria" };
const jose = { id: "jose", handle: "jose", name: "José Álvaro" };

describe("assistantGroupAddress", () => {
  it.each([
    ["@ada what now?", [ada]],
    ["@ada @beto-r compare", [ada, beto]],
    ["  @Ada, @betorocha: compare", [ada, beto]],
    ["@ada @ada twice", [ada]],
    ["@everyone status?", [ada, beto, jose]],
    ["@ada @everyone", [ada, beto, jose]],
    ["@nobody hi", null],
    ["@ada @nobody hi", [ada]],
    ["no mention", null],
    ["", null],
    // anywhere in the text
    ["hi @ada", [ada]],
    ["obrigado @Ada", [ada]],
    ["thanks @ada, and @beto-r too", [ada, beto]],
    ["(@ada)", [ada]],
    ["ok.@ada", [ada]],
    // names with spaces: full name, case and accents ignored, handle too
    ["@Beto Rocha look", [beto]],
    ["@beto   rocha look", [beto]],
    ["@BETO ROCHA!", [beto]],
    ["@beto rocha, @ada", [beto, ada]],
    ["@beto only", null],
    ["@Jose Alvaro vem", [jose]],
    ["@JOSÉ ÁLVARO vem", [jose]],
    ["@josealvaro vem", [jose]],
    ["@jose vem", [jose]],
    // a quote or reply marker before the @ still addresses
    ["> earlier text\n@ada answer this", [ada]],
    ["> @ada said so", [ada]],
    // not an address: code, links, emails, inside a word
    ["run `@ada` now", null],
    ["```\n@ada\n```", null],
    ["```\n@ada never closed", null],
    ["see https://x.com/@ada/post", null],
    ["see www.x.com/@ada", null],
    ["mail ada@x.com", null],
    ["mail me@ada", null],
    ["@adamant thing", null],
    ["@ada-x thing", null],
    // code skipped, the rest still counts
    ["`@ada` is a handle, ask @beto-r", [beto]],
    ["```\n@ada\n```\nbut @beto-r", [beto]],
  ])("%j", (text, expected) => {
    expect(assistantGroupAddress(text, [ada, beto, jose])).toEqual(expected);
  });

  it("takes the longest name when one is a prefix of another", () => {
    const group = [ana, anaMaria, { id: "an", handle: "an", name: "Ana" }];
    expect(assistantGroupAddress("@Ana Paula Maria ok", group)).toEqual([anaMaria]);
    expect(assistantGroupAddress("@Ana Paula ok", group)).toEqual([ana]);
    expect(assistantGroupAddress("@Ana ok", group)).toEqual([group[2]]);
    expect(assistantGroupAddress("@Ana Silva ok", group)).toEqual([group[2]]);
  });

  it("@everyone in an empty group names no one", () => {
    expect(assistantGroupAddress("@everyone hi", [])).toBeNull();
  });
});

describe("assistantGroupMentions", () => {
  it("returns each mention's span in the original text", () => {
    const text = "Oi @José Álvaro e @everyone, não @x";
    expect(
      assistantGroupMentions(text, [jose]).map((found) => [
        text.slice(found.start, found.end),
        found.member?.id ?? null,
      ]),
    ).toEqual([
      ["@José Álvaro", "jose"],
      ["@everyone", null],
    ]);
  });
});

describe("assistantGroupTaskActions", () => {
  it.each([
    ["queued", ["stop"]],
    ["running", ["stop"]],
    ["waiting", ["stop"]],
    ["usage_limited", ["stop"]],
    ["paused", ["resume", "reassign", "cancel"]],
    ["failed", ["resume", "reassign", "cancel"]],
    ["completed", []],
    ["cancelled", []],
  ] as const)("%s", (status, expected) => {
    expect(assistantGroupTaskActions({ status })).toEqual(expected);
  });
});

const decodeGroupsEvent = Schema.decodeUnknownSync(AssistantGroupsEvent);

describe("group task status on the wire", () => {
  const task = (status: string, extra: Record<string, unknown> = {}) => ({
    id: `task-${status}`,
    teamId: "team-1",
    rootId: `task-${status}`,
    parentId: null,
    kind: "root",
    requestMessageId: "message-1",
    ownerId: "ada",
    instruction: "Do it",
    status,
    reason: null,
    threadId: "assistant:ada:g-0123456789abcdef",
    createdAt: "2026-11-13T12:00:00.000Z",
    updatedAt: "2026-11-13T12:00:00.000Z",
    ...extra,
  });

  it("keeps the list when a newer server sends a status this client does not know", () => {
    const event = decodeGroupsEvent({
      type: "snapshot",
      messages: [],
      tasks: [
        task("running"),
        task("usage_limited", { resetAt: "2026-11-13T18:00:00.000Z" }),
        task("added_by_newer_server"),
      ],
      hasMore: false,
    });

    expect(event.type === "snapshot" && event.tasks).toMatchObject([
      { status: "running" },
      { status: "usage_limited", resetAt: "2026-11-13T18:00:00.000Z" },
      { status: "failed" },
    ]);
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
