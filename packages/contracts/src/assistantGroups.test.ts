import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AssistantGroupMessage,
  AssistantGroupsPostInput,
  assistantGroupAddress,
  assistantGroupMentions,
  assistantGroupProjectIds,
  assistantGroupProjectMentionRanges,
  assistantGroupProjectMentions,
  assistantGroupProjectSlug,
  assistantGroupProjectSlugs,
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

describe("assistantGroupProjectMentions", () => {
  const projects = [
    { id: "p1", name: "Billing API" },
    { id: "p2", name: "agenda-instagram" },
    { id: "p3", name: "Café" },
  ];
  it.each([
    ["a one-word name", "deploy #cafe now", ["p3"]],
    ["a name with spaces, as hyphens", "fix #billing-api.", ["p1"]],
    ["a hyphenated name", "(#agenda-instagram) post it", ["p2"]],
    ["case and accents ignored", "#BILLING-API and #Café", ["p1", "p3"]],
    ["each project once", "#cafe or #cafe", ["p3"]],
    ["an unknown project", "see #nope and issue #42", []],
    ["a heading or a word with #", "# Billing api\nsee page#cafe", []],
    ["code and links", "`#cafe` https://x.dev/#cafe", []],
  ])("%s", (_name, text, ids) => {
    expect(assistantGroupProjectMentions(text, projects).map((project) => project.id)).toEqual(ids);
  });
  it("gives each mention's offsets, without trailing punctuation", () => {
    expect(
      assistantGroupProjectMentionRanges("fix #billing-api. #cafe", projects).map((found) => [
        found.start,
        found.end,
        found.project.id,
      ]),
    ).toEqual([
      [4, 16, "p1"],
      [18, 23, "p3"],
    ]);
  });
});

describe("assistantGroupProjectSlugs", () => {
  const projects = [
    { id: "p4", name: "My App (v2)" },
    { id: "p5", name: "C++" },
    { id: "p6", name: "Foo & Bar" },
    { id: "p7", name: "api." },
    { id: "p8", name: "Ação Rápida" },
    { id: "p9", name: "++" },
    { id: "p3", name: "core" },
    { id: "p1", name: "Core" },
    { id: "p2", name: "Core 2" },
  ];
  it.each([
    ["punctuation", "p4", "my-app-v2", "ship #my-app-v2 today"],
    ["a symbol at the end", "p5", "c", "fix #c."],
    ["a symbol between words", "p6", "foo-bar", "(#foo-bar)"],
    ["a trailing dot", "p7", "api", "see #api"],
    ["accents", "p8", "acao-rapida", "#Ação-Rápida"],
    ["nothing left", "p9", "project", "in #project"],
    ["the first id of a collision", "p1", "core", "#core"],
    ["a later id, past a slug another title makes", "p3", "core-3", "#core-3"],
    ["a title that makes the suffix itself", "p2", "core-2", "#core-2"],
  ])("%s", (_name, id, slug, text) => {
    expect(assistantGroupProjectSlugs(projects).get(id)).toBe(slug);
    expect(assistantGroupProjectSlugs([...projects].reverse()).get(id)).toBe(slug);
    expect(assistantGroupProjectMentions(text, projects).map((project) => project.id)).toEqual([
      id,
    ]);
  });
  it("names one project the same way alone", () => {
    expect(assistantGroupProjectSlug("My App (v2)")).toBe("my-app-v2");
  });
});

describe("assistantGroupProjectIds", () => {
  it("joins the members' project lists in member order, once each, home project as a fallback", () => {
    expect(
      assistantGroupProjectIds([
        { projectId: "home" as never, projectIds: ["p2" as never, "p1" as never] },
        { projectId: "p3" as never, projectIds: [] },
        { projectId: "home" as never, projectIds: ["p1" as never] },
      ]),
    ).toEqual(["p2", "p1", "p3"]);
    expect(assistantGroupProjectIds([])).toEqual([]);
  });
});
