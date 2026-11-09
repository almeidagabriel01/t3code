import { describe, expect, it } from "vite-plus/test";

import { assistantMetaLabel, rankAssistants, visibleAssistants } from "./assistantList.ts";

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
  it.each([
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
  ])("orders $name", ({ entries, shells, expected }) => {
    expect(names(rankAssistants(entries, shells))).toEqual(expected);
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

describe("assistantMetaLabel", () => {
  it.each([
    ["needs", "Needs your approval in Leadership", "Needs you"],
    ["working", "Reading the repo", "Working"],
    ["working", "Working in Leadership", "Working in Leadership"],
    ["failed", "Last run failed", "Last run failed"],
    ["idle", "Idle", null],
  ] as const)("%s / %s", (mood, detail, expected) => {
    expect(assistantMetaLabel({ mood, detail, since: null, reading: false, queued: 0 })).toBe(
      expected,
    );
  });
});
