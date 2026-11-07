import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  Assistant,
  assistantCommandNames,
  AssistantHandle,
  assistantMcpServersProblem,
  assistantTeamProblem,
  AssistantsEvent,
  AssistantMcpServerInput,
  AssistantsUpdateInput,
  assistantHandleFromName,
  assistantIdFromThreadId,
  assistantThreadIdFor,
  isAssistantThreadId,
} from "./assistants.ts";

const isAssistantHandle = Schema.is(AssistantHandle);
const isUpdateInput = Schema.is(AssistantsUpdateInput);
const decode = Schema.decodeUnknownSync(Assistant);
const decodeEvent = Schema.decodeSync(AssistantsEvent);

describe("assistantHandleFromName", () => {
  it.each([
    ["Jarvis", "jarvis"],
    ["  Code Reviewer  ", "code-reviewer"],
    ["Assistente de Revisão", "assistente-de-revisao"],
    ["Ünïcödé Ñame", "unicode-name"],
    ["--hi--", "hi"],
    ["a".repeat(40), "a".repeat(32)],
    [`${"a".repeat(31)} b`, "a".repeat(31)],
    ["🤖", null],
    ["", null],
  ])("%j → %j", (name, handle) => {
    const result = assistantHandleFromName(name);
    expect(result).toBe(handle);
    if (result !== null) expect(isAssistantHandle(result)).toBe(true);
  });
});

describe("assistantCommandNames", () => {
  const names = (handles: string[]) =>
    assistantCommandNames(handles.map((handle) => ({ handle }))).map((entry) => entry.command);

  it.each([
    [
      ["jarvis", "code-reviewer"],
      ["jarvis", "code_reviewer"],
    ],
    [
      ["Research Bot", "Ação"],
      ["research_bot", "a__o"],
    ],
    [
      ["x-y", "x_y", "x-y"],
      ["x_y", "x_y_2", "x_y_3"],
    ],
    [
      ["a".repeat(40), "a".repeat(32)],
      ["a".repeat(32), `${"a".repeat(30)}_2`],
    ],
    [["--"], ["__"]],
  ])("%j → %j", (handles, commands) => {
    expect(names(handles)).toEqual(commands);
    for (const command of commands) expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
  });
});

describe("assistant thread ids", () => {
  it.each([
    ["jarvis", 1],
    ["0f6c-uuid-with:colon", 12],
  ])("round-trips %s generation %i", (assistantId, generation) => {
    const threadId = assistantThreadIdFor(assistantId, generation);
    expect(isAssistantThreadId(threadId)).toBe(true);
    expect(assistantIdFromThreadId(threadId)).toBe(assistantId);
  });

  it.each(["thread-1", "mcp:abc", "assistant:", "assistant:nogeneration", "Assistant:jarvis:1"])(
    "rejects %s",
    (threadId) => {
      expect(assistantIdFromThreadId(threadId)).toBeNull();
    },
  );
});

describe("Assistant", () => {
  const row = {
    id: "jarvis",
    handle: "jarvis",
    name: "Jarvis",
    projectId: "project-1",
    instructions: "",
    toolAccess: "full",
    isDefault: true,
    threadId: null,
    generation: 1,
    archivedAt: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
  };

  it("reads a row saved before budgets existed as having no budget", () => {
    expect(decode(row).budget).toBeNull();
  });

  it("reads a row saved before autonomy existed as only answering", () => {
    expect(decode(row).autonomy).toEqual({
      mode: "reply-only",
      rules: null,
      projectIds: null,
      channels: null,
    });
  });

  it("keeps a budget, filling the provider budget defaults", () => {
    const budget = decode({
      ...row,
      budget: { amountUsd: 5, period: "monthly", timeZone: "America/Sao_Paulo" },
    }).budget;
    expect(budget).toEqual({
      amountUsd: 5,
      period: "monthly",
      warnAtPercent: 80,
      blockWhenExceeded: false,
      timeZone: "America/Sao_Paulo",
    });
  });
});

describe("Assistant icon", () => {
  const stored = {
    id: "a1",
    handle: "a",
    name: "A",
    projectId: "p",
    instructions: "",
    toolAccess: "full",
    isDefault: false,
    threadId: null,
    generation: 1,
    archivedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const decode = Schema.decodeUnknownSync(Assistant);

  it.each([
    [undefined, null],
    [null, null],
    ["spark", "spark"],
    ["from-a-newer-client", "from-a-newer-client"],
  ])("decodes %j as %j", (icon, expected) => {
    expect(decode({ ...stored, ...(icon === undefined ? {} : { icon }) }).icon).toBe(expected);
  });

  it("accepts only known ids on write", () => {
    expect(isUpdateInput({ assistantId: "a1", icon: "spark" })).toBe(true);
    expect(isUpdateInput({ assistantId: "a1", icon: null })).toBe(true);
    expect(isUpdateInput({ assistantId: "a1", icon: "laser" })).toBe(false);
  });
});

describe("assistant connectors", () => {
  const http = {
    name: "docs",
    transport: "http",
    url: "https://x.test/mcp",
    enabled: true,
  } as const;
  const stdio = { name: "files", transport: "stdio", command: "npx", enabled: true } as const;

  it.each([
    ["a valid http and stdio pair", [http, stdio], null],
    ["an empty list", [], null],
    [
      "a reserved name",
      [{ ...http, name: "t3-code" }],
      '"t3-code" is reserved for T3\'s own tools.',
    ],
    [
      "the direct reserved name",
      [{ ...http, name: "t3-code-direct" }],
      '"t3-code-direct" is reserved for T3\'s own tools.',
    ],
    ["a repeated name", [http, { ...stdio, name: "docs" }], 'Two connectors are named "docs".'],
    [
      "an http connector without a URL",
      [{ ...http, url: undefined }],
      '"docs" needs an http or https URL.',
    ],
    ["a non-http URL", [{ ...http, url: "ftp://x.test" }], '"docs" needs an http or https URL.'],
    ["a garbage URL", [{ ...http, url: "not a url" }], '"docs" needs an http or https URL.'],
    ["a blank command", [{ ...stdio, command: "  " }], '"files" needs a command.'],
    [
      "a repeated header",
      [{ ...http, headers: [{ key: "A" }, { key: "A", value: "x" }] }],
      '"docs" repeats a header or variable name.',
    ],
    [
      "a repeated env name",
      [{ ...stdio, env: [{ key: "A" }, { key: "A" }] }],
      '"files" repeats a header or variable name.',
    ],
    [
      "too many connectors",
      Array.from({ length: 21 }, (_, i) => ({ ...http, name: `s${i}` })),
      "At most 20 connectors.",
    ],
  ] as const)("%s", (_label, servers, problem) => {
    expect(assistantMcpServersProblem(servers)).toBe(problem);
  });

  const isInput = Schema.is(AssistantMcpServerInput);
  it.each([
    ["docs_2", true],
    ["Docs", false],
    ["has space", false],
    ["-lead", false],
    ["", false],
    ["a".repeat(33), false],
  ])("name %j is valid: %s", (name, valid) => {
    expect(isInput({ ...http, name })).toBe(valid);
  });

  it("decodes old rows with defaults and ignores unknown fields", () => {
    const decoded = decode({
      id: "a1",
      handle: "a",
      name: "A",
      projectId: "p",
      instructions: "",
      toolAccess: "full",
      isDefault: false,
      threadId: null,
      generation: 1,
      archivedAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      mcpServers: [{ name: "docs", transport: "http", url: "https://x.test", future: 1 }],
    });
    expect(decoded.mcpServers).toEqual([
      {
        name: "docs",
        transport: "http",
        url: "https://x.test",
        args: [],
        headers: [],
        env: [],
        enabled: true,
      },
    ]);
    expect(decode({ ...decoded, mcpServers: undefined }).mcpServers).toEqual([]);
    // Rows from before avatars and scopes: no avatar, everywhere, the legacy icon untouched.
    expect([decoded.avatar, decoded.scope, decoded.icon]).toEqual([null, "all", null]);
    expect(decode({ ...decoded, icon: "scout" }).icon).toBe("scout");
  });
});

describe("assistantTeamProblem", () => {
  it.each([
    ["two members, no leader", { memberIds: ["a", "b"] }, null],
    ["a leader with a title", { memberIds: ["a", "b"], leaderId: "a", leaderTitle: "CEO" }, null],
    ["one member", { memberIds: ["a"] }, null],
    ["no members", { memberIds: [] }, null],
    ["a repeated member", { memberIds: ["a", "a"] }, "twice"],
    ["a leader outside the team", { memberIds: ["a", "b"], leaderId: "c" }, "must be a member"],
    ["a title without a leader", { memberIds: ["a", "b"], leaderTitle: "CEO" }, "needs a leader"],
    ["a blank title without a leader", { memberIds: ["a", "b"], leaderTitle: " " }, null],
  ])("%s", (_name, team, problem) => {
    const found = assistantTeamProblem(team);
    if (problem === null) expect(found).toBeNull();
    else expect(found).toContain(problem);
  });

  it("an old snapshot without teams still decodes, with none", () => {
    const decoded = decodeEvent({ type: "snapshot", assistants: [] });
    expect(decoded).toMatchObject({ type: "snapshot", teams: [] });
  });
});
