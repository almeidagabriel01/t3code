import { describe, expect, it } from "vite-plus/test";

import {
  assistantGroupFoldKey,
  assistantGroupFolds,
  rankAssistants,
  toggleFoldKey,
  visibleAssistants,
} from "./assistantList.ts";
import type { AssistantPresence } from "./assistantRobot.ts";

const entry = (name: string, threadId: string | null = `assistant:${name}:1`) => ({
  environmentId: "env",
  assistant: { id: name, name, threadId },
});
const shell = (
  id: string,
  extra: { updatedAt?: string; approvals?: boolean; working?: boolean } = {},
) =>
  ({
    environmentId: "env",
    id,
    title: id,
    updatedAt: extra.updatedAt ?? "2026-01-01T00:00:00.000Z",
    hasPendingApprovals: extra.approvals === true,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    queuedMessageCount: 0,
    blockedOnThreadWait: false,
    latestRun: extra.working ? { startedAt: "2026-01-01T00:00:00.000Z" } : null,
    runtime: extra.working ? { status: "running" } : null,
    source: { latestVisibleMessage: null },
  }) as unknown as Parameters<typeof rankAssistants>[1][number];

const names = (list: ReadonlyArray<{ entry: { assistant: { name: string } } }>) =>
  list.map(({ entry }) => entry.assistant.name);

describe("rankAssistants", () => {
  it.each<{
    name: string;
    entries: Array<ReturnType<typeof entry>>;
    shells: Array<ReturnType<typeof shell>>;
    /** What the shared status reads for an assistant, over its own chat. */
    status?: Record<string, AssistantPresence["mood"]>;
    expected: string[];
  }>([
    {
      name: "needs you, then working, then recent activity, then name",
      entries: [entry("ada"), entry("bob"), entry("cid"), entry("dee"), entry("eve")],
      shells: [
        shell("assistant:ada:1", { updatedAt: "2026-01-02T00:00:00.000Z" }),
        shell("assistant:bob:1", { working: true }),
        shell("assistant:cid:1", { approvals: true }),
        shell("assistant:dee:1", { updatedAt: "2026-01-05T00:00:00.000Z" }),
      ],
      expected: ["cid", "bob", "dee", "ada", "eve"],
    },
    {
      name: "no thread or no shell sorts last by name",
      entries: [entry("zed", null), entry("amy", null), entry("kim")],
      shells: [shell("assistant:kim:1")],
      expected: ["kim", "amy", "zed"],
    },
    {
      name: "work in a group thread counts as working",
      entries: [entry("ada"), entry("bob")],
      shells: [
        shell("assistant:ada:1", { updatedAt: "2026-02-01T00:00:00.000Z" }),
        shell("assistant:bob:1"),
        shell("assistant:bob:g-0123456789abcdef", { working: true }),
      ],
      expected: ["bob", "ada"],
    },
    {
      name: "the shared status over its own idle chat: a task that needs you, then one at work",
      entries: [entry("ada"), entry("bob"), entry("cid")],
      shells: [
        shell("assistant:ada:1", { updatedAt: "2026-02-01T00:00:00.000Z" }),
        shell("assistant:bob:1"),
        shell("assistant:cid:1"),
      ],
      status: { cid: "needs", bob: "working" },
      expected: ["cid", "bob", "ada"],
    },
  ])("orders $name", ({ entries, shells, expected, status = {} }) => {
    const ranked = rankAssistants(entries, shells, (row, presence) => {
      const mood = status[row.assistant.id];
      return mood === undefined ? presence : { ...presence, mood };
    });
    expect(names(ranked)).toEqual(expected);
  });
});

describe("visibleAssistants", () => {
  const ranked = (moods: string[]) => moods.map((mood, i) => ({ id: i, presence: { mood } }));
  it.each([
    {
      name: "all active plus five others",
      moods: ["needs", "working", ...Array(7).fill("idle")],
      shown: 7,
      hidden: 2,
    },
    { name: "few assistants show everything", moods: ["idle", "failed"], shown: 2, hidden: 0 },
    {
      name: "failed counts as other",
      moods: ["working", ...Array(6).fill("failed")],
      shown: 6,
      hidden: 1,
    },
  ])("keeps $name", ({ moods, shown, hidden }) => {
    const result = visibleAssistants(ranked(moods), false);
    expect([result.shown.length, result.hidden]).toEqual([shown, hidden]);
    expect(visibleAssistants(ranked(moods), true)).toMatchObject({ hidden: 0 });
  });
});

describe("assistantGroupFolds", () => {
  const ranked = (list: ReadonlyArray<readonly [string, string, string?]>) =>
    list.map(([name, mood, environmentId = "env"]) => ({
      entry: { environmentId, assistant: { id: name, name, threadId: null } },
      presence: { mood, detail: "", since: null, reading: false, queued: 0 },
    })) as unknown as Parameters<typeof assistantGroupFolds>[0];
  const team = (id: string, memberIds: string[], environmentId = "env") => ({
    environmentId,
    team: { id, memberIds },
  });
  it.each([
    {
      name: "no groups leaves everyone loose",
      ranked: [["jarvis", "idle"]] as const,
      teams: [],
      loose: ["jarvis"],
      groups: [],
    },
    {
      name: "a member stands only in its group, in rank order",
      ranked: [
        ["cid", "needs"],
        ["bob", "working"],
        ["jarvis", "idle"],
        ["ada", "idle"],
      ] as const,
      teams: [team("dev", ["ada", "bob", "cid", "ghost"])],
      loose: ["jarvis"],
      groups: [{ id: "dev", members: ["cid", "bob", "ada"] }],
    },
    {
      name: "one assistant in two groups shows under each",
      ranked: [
        ["ada", "working"],
        ["bob", "idle"],
      ] as const,
      teams: [team("dev", ["ada"]), team("content", ["ada", "bob"]), team("empty", [])],
      loose: [],
      groups: [
        { id: "dev", members: ["ada"] },
        { id: "content", members: ["ada", "bob"] },
        { id: "empty", members: [] },
      ],
    },
    {
      name: "a group only takes members from its own environment",
      ranked: [
        ["ada", "idle", "env"],
        ["ada", "idle", "other"],
      ] as const,
      teams: [team("dev", ["ada"], "other")],
      loose: ["env:ada"],
      groups: [{ id: "dev", members: ["other:ada"] }],
    },
  ])("$name", (row) => {
    const label = (item: { entry: { environmentId: string; assistant: { id: string } } }) =>
      row.name.includes("environment")
        ? `${item.entry.environmentId}:${item.entry.assistant.id}`
        : item.entry.assistant.id;
    const result = assistantGroupFolds(ranked(row.ranked), row.teams);
    expect(result.loose.map(label)).toEqual(row.loose);
    expect(
      result.groups.map((group) => ({
        id: group.team.team.id,
        members: group.members.map(label),
      })),
    ).toEqual(row.groups);
  });

  it("toggles one fold key and keeps the others", () => {
    const key = assistantGroupFoldKey("env", "dev");
    expect(key).toBe("group:env:dev");
    expect(toggleFoldKey(["project:env:p1"], key)).toEqual(["project:env:p1", key]);
    expect(toggleFoldKey(["project:env:p1", key], key)).toEqual(["project:env:p1"]);
  });
});
