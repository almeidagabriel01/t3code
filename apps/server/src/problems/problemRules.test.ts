import { assert, describe, it } from "@effect/vitest";
import type { Assistant, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { projectScopeRefusal } from "../assistants/AssistantSandboxPolicy.ts";
import {
  cardTitle,
  classify,
  detectionEnabled,
  effectiveLevel,
  evidenceDescription,
  excerpt,
  fingerprint,
  noOwnerNotice,
  noticeHeader,
  normalize,
  folderOwner,
  reasonLabel,
  selectOwner,
  summaryOf,
  wakeText,
  type OwnerCandidate,
  type ProblemReason,
  type ProblemReport,
  type ProblemSource,
} from "./problemRules.ts";

const report = (overrides: Partial<ProblemReport> = {}): ProblemReport => ({
  key: "k",
  source: "runner",
  projectId: "p1",
  threadId: null,
  subject: null,
  command: null,
  error: "Exit code 1",
  where: null,
  at: 0,
  ...overrides,
});

describe("classify (PRO-01, PRO-30, PRO-31)", () => {
  const rows: ReadonlyArray<
    readonly [string, Partial<ProblemReport>, readonly [string, ProblemReason] | null]
  > = [
    [
      "zsh command not found",
      { error: "zsh:1: command not found: pnpm" },
      ["environment", "command-not-found"],
    ],
    [
      "spawn ENOENT",
      { source: "run", error: "spawn /opt/bin/codex ENOENT" },
      ["environment", "command-not-found"],
    ],
    ["exit 127", { error: "Exit code 127" }, ["environment", "command-not-found"]],
    [
      "auth 401",
      { source: "session", error: "API Error: 401 Unauthorized" },
      ["environment", "sign-in-expired"],
    ],
    [
      "token expired",
      { source: "run", error: "OAuth token has expired" },
      ["environment", "sign-in-expired"],
    ],
    ["dns", { error: "getaddrinfo ENOTFOUND registry.npmjs.org" }, ["environment", "network"]],
    ["refused", { error: "connect ECONNREFUSED 127.0.0.1:5432" }, ["environment", "network"]],
    ["disk", { error: "ENOSPC: no space left on device, write" }, ["environment", "disk-full"]],
    [
      "oom",
      { error: "FATAL ERROR: JavaScript heap out of memory" },
      ["environment", "out-of-memory"],
    ],
    ["exit 137", { error: "Exit code 137" }, ["environment", "out-of-memory"]],
    ["linux sync phase", { reason: "linux-sync" }, ["environment", "linux-sync"]],
    ["linux install phase", { reason: "linux-install" }, ["environment", "linux-install"]],
    ["linux lost", { reason: "linux-lost" }, ["environment", "linux-lost"]],
    ["provider run", { source: "run", error: "Overloaded" }, ["provider", "run-failed"]],
    [
      "provider session",
      { source: "session", error: "process exited" },
      ["provider", "session-failed"],
    ],
    ["ci", { source: "ci", error: "Checks failing on PR #4" }, ["ci", "checks-failing"]],
    [
      "scheduled",
      { source: "scheduled", error: "Thread not found" },
      ["scheduled-task", "scheduled-failed"],
    ],
    ["link", { source: "link", error: "fetch failed" }, ["connection", "link-unreachable"]],
    ["plain runner failure", { error: "Exit code 1" }, null],
  ];
  it.each(rows)("%s", (_name, input, expected) => {
    const result = classify(report(input));
    assert.deepEqual<unknown>(result === null ? null : [result.kind, result.reason], expected);
  });
});

describe("normalize and fingerprint (PRO-01, PRO-02, PRO-05)", () => {
  it("maps numbers, paths, ids, hashes and timestamps to fixed tokens", () => {
    assert.equal(
      normalize(
        "2026-11-13T10:00:01.123Z Job 4f1c2e9a failed in /Users/me/proj/src/a.ts after 31s id 0b5e3f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b at 10:01:02",
      ),
      "<time> job <hash> failed in <path> after <n>s id <id> at <time>",
    );
  });

  it("gives the same cause the same fingerprint across runs, and keeps causes apart", () => {
    const first = report({
      command: "pnpm test --run 12",
      error: "spawn /tmp/a1/bin/tsc ENOENT\nstack",
    });
    const again = report({
      key: "k2",
      command: "pnpm test --run 99",
      error: "spawn /tmp/b7/bin/tsc ENOENT",
    });
    const reason = classify(first)!.reason;
    assert.equal(fingerprint(first, "p1", reason), fingerprint(again, "p1", reason));
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["other project", fingerprint(first, "p2", reason)],
      ["other subject", fingerprint({ ...first, subject: "pr:2" }, "p1", reason)],
      ["other source", fingerprint({ ...first, source: "run" }, "p1", reason)],
      ["unclassified", fingerprint(first, "p1", null)],
    ];
    for (const [name, value] of rows) {
      assert.notEqual(value, fingerprint(first, "p1", reason), name);
    }
  });

  const E = "\u001b";
  const vitest = (rule: string, count: string) =>
    `${E}[31m${E}[2m${rule}[${count}]⎯${E}[22m${E}[39m\n\n${E}[41m${E}[1m FAIL ${E}[22m${E}[49m src/a.test.ts > runs\nAssertionError: expected 1 to equal 2`;
  it.each([
    [
      "vitest counters and rule widths",
      vitest("⎯".repeat(22), "50/62"),
      vitest("⎯".repeat(24), "3/4"),
    ],
    ["ANSI colour around the same line", `${E}[31mError: boom${E}[39m`, "Error: boom"],
    [
      "a labelled rule of another width",
      "⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯\nx",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 31 ⎯⎯\nx",
    ],
    [
      "one more file in the command",
      "vp test run src/a.ts src/b.ts",
      "vp test run src/a.ts src/b.ts src/c",
    ],
  ])("one failure is one card across %s", (_, first, again) => {
    const at = (text: string) =>
      fingerprint(
        report({ command: text.startsWith("vp ") ? text : "vp test run", error: text }),
        "p1",
        "linux-install",
      );
    assert.equal(at(first), at(again));
  });

  it.each([
    ["the failing test", vitest("⎯⎯", "1/2"), "Environment: FAIL  src/a.test.ts > runs"],
    [
      "a real install failure",
      "ERR_PNPM_FETCH_404 GET https://r/x: Not Found",
      "Environment: ERR_PNPM_FETCH_404 GET https://r/x: Not Found",
    ],
    ["output with only colour and rules", `${E}[31m⎯⎯[3/4]⎯${E}[39m\n`, "Environment: Failed"],
  ])("a card title names %s", (_, error, title) => {
    assert.equal(cardTitle("environment", error), title);
  });

  it("different failures still open different cards", () => {
    const at = (error: string) =>
      fingerprint(report({ command: "vp test run", error }), "p1", "linux-install");
    assert.notEqual(at(vitest("⎯⎯", "1/2")), at(vitest("⎯⎯", "1/2").replace("> runs", "> stops")));
  });

  it("a reported cause is the whole identity: other commands and errors are the same card", () => {
    const fault = report({ cause: "command-not-found:vp", command: "vp test", error: "vp: nope" });
    const same = fingerprint(fault, "p1", "command-not-found");
    assert.equal(
      fingerprint({ ...fault, command: "vp lint", error: "other text" }, "p1", "command-not-found"),
      same,
    );
    assert.notEqual(fingerprint({ ...fault, cause: "command-not-found:git" }, "p1", null), same);
    assert.notEqual(fingerprint(fault, "p2", "command-not-found"), same);
  });
});

describe("folderOwner", () => {
  const roots = [
    { id: "web", root: "/repo/web" },
    { id: "web-wt", root: "/wt/web/feature/" },
    { id: "nested", root: "/repo/web/packages/inner" },
  ];
  it.each([
    ["the root itself", "/repo/web", "web"],
    ["a folder inside the root", "/repo/web/apps/server", "web"],
    ["a worktree, with a trailing slash on its root", "/wt/web/feature/apps", "web-wt"],
    ["the longest root wins", "/repo/web/packages/inner/src", "nested"],
    ["a sibling that only shares a prefix", "/repo/web2", null],
    ["no root holds it", "/elsewhere", null],
  ])("%s", (_name, folder, expected) => {
    assert.equal(folderOwner(folder, roots), expected);
  });
});

const owner = (overrides: Partial<OwnerCandidate> & { id: string }): OwnerCandidate => ({
  name: overrides.id,
  scope: "all",
  projectIds: [],
  notifies: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  threadId: `assistant:${overrides.id}`,
  ...overrides,
});

describe("selectOwner (PRO-10, PRO-12, PRO-13)", () => {
  const jarvis = owner({ id: "jarvis", createdAt: "2026-01-01T00:00:00.000Z" });
  const ops = owner({ id: "ops", scope: "project", projectIds: ["p1", "p2"] });
  const rows: ReadonlyArray<
    readonly [string, ReadonlyArray<OwnerCandidate>, string, string | null]
  > = [
    ["project-scoped only", [ops], "p1", "ops"],
    ["project-scoped without the project", [ops], "p9", null],
    ["all-scope only", [jarvis], "p1", "jarvis"],
    ["both: the project one wins", [jarvis, ops], "p2", "ops"],
    ["both, other project: all-scope", [jarvis, ops], "p9", "jarvis"],
    ["none", [], "p1", null],
    [
      "tie: autonomy on wins",
      [jarvis, owner({ id: "late", notifies: true, createdAt: "2026-05-01T00:00:00.000Z" })],
      "p1",
      "late",
    ],
    [
      "tie: then the oldest",
      [
        owner({ id: "b", createdAt: "2026-03-01T00:00:00.000Z" }),
        owner({ id: "a2", createdAt: "2026-02-01T00:00:00.000Z" }),
      ],
      "p1",
      "a2",
    ],
    [
      "owner removed: archived is skipped",
      [{ ...ops, archivedAt: "2026-02-01T00:00:00.000Z" }, jarvis],
      "p1",
      "jarvis",
    ],
    ["owner lost the project", [{ ...ops, projectIds: ["p2"] }, jarvis], "p1", "jarvis"],
    ["no thread yet is skipped", [{ ...jarvis, threadId: null }], "p1", null],
  ];
  it.each(rows)("%s", (_name, candidates, projectId, expected) => {
    assert.equal(selectOwner(candidates, projectId)?.id ?? null, expected);
  });

  it.effect("agrees with projectScopeRefusal: the owner may always act in the project", () =>
    Effect.gen(function* () {
      const candidates = [jarvis, ops, owner({ id: "solo", scope: "project", projectIds: ["p3"] })];
      for (const projectId of ["p1", "p2", "p3", "p9"]) {
        for (const subset of [candidates, candidates.slice(1), [candidates[2]!]]) {
          const chosen = selectOwner(subset, projectId);
          if (chosen === null) continue;
          const assistant = {
            id: chosen.id,
            scope: chosen.scope,
            projectIds: chosen.projectIds,
            projectId: chosen.projectIds[0] ?? "home",
          } as unknown as Assistant;
          const refusal = yield* projectScopeRefusal(
            Option.some({
              forThread: () => Effect.succeedSome({ assistant, current: true }),
              teamsOf: () => Effect.succeed([]),
              sandboxEnvironmentId: Effect.succeedNone,
              taskOwner: () => Effect.succeedNone,
            }),
            { threadId: chosen.threadId as ThreadId, projectId: projectId as ProjectId },
          );
          assert.isTrue(Option.isNone(refusal), `${chosen.id} in ${projectId}`);
        }
      }
    }),
  );
});

describe("detectionEnabled (PRO-41)", () => {
  const rows: ReadonlyArray<
    readonly [string, boolean, boolean | undefined, string | null, boolean]
  > = [
    ["global on", true, undefined, "p1", true],
    ["global off", false, undefined, "p1", false],
    ["project off wins", true, false, "p1", false],
    ["project on wins", false, true, "p1", true],
    ["other project inherits", true, false, "p2", true],
    ["no project inherits", true, false, null, true],
  ];
  it.each(rows)("%s", (_name, global, project, projectId, expected) => {
    const settings = {
      detectProblems: global,
      projectSettingsOverrides:
        project === undefined ? {} : { ["p1" as ProjectId]: { detectProblems: project } },
    };
    assert.equal(detectionEnabled(settings, projectId), expected);
  });
});

describe("levels and text (PRO-04, PRO-11, PRO-12, PRO-21..25)", () => {
  it("a read-only owner only tells", () => {
    assert.equal(effectiveLevel("fix-small", "read-only"), "tell");
    assert.equal(effectiveLevel("fix-small", "full"), "fix-small");
  });

  it("titles and notices use the approved wording, with secrets redacted", () => {
    assert.equal(
      cardTitle("environment", "command not found: pnpm.\nmore"),
      "Environment: command not found: pnpm",
    );
    assert.equal(cardTitle("repeated", ""), "Repeated failure: Failed");
    assert.equal(noticeHeader("Shop", "Disk full", 12), "Problem in Shop: Disk full. Card #12.");
    assert.equal(
      noOwnerNotice("Shop"),
      "No assistant can work on Shop. Give one access in Assistants.",
    );
    assert.notInclude(
      excerpt("token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"),
      "abcdefghijklmnop",
    );
    assert.notInclude(summaryOf("Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"), "ghp_abcdef");
  });

  it("lists every reason and source label", () => {
    const reasons: ReadonlyArray<readonly [ProblemReason, string]> = [
      ["command-not-found", "Command not found"],
      ["sign-in-expired", "Sign-in expired"],
      ["network", "Network or DNS failure"],
      ["disk-full", "Disk full"],
      ["out-of-memory", "Out of memory"],
      ["linux-sync", "Linux sync failed"],
      ["linux-install", "Dependency install on Linux failed"],
      ["linux-lost", "Linux dropped the job"],
      ["session-failed", "Provider session failed"],
      ["run-failed", "Run failed"],
      ["checks-failing", "Checks failing on PR #7"],
      ["scheduled-failed", "Scheduled run failed"],
      ["link-unreachable", "Link unreachable"],
      ["repeated", "Seen 3 times in 24 hours"],
    ];
    for (const [reason, label] of reasons) assert.equal(reasonLabel(reason, 7), label);
  });

  it("describes the evidence with the approved labels", () => {
    const sources: ReadonlyArray<readonly [ProblemSource, string]> = [
      ["runner", "Runner"],
      ["run", "Agent run"],
      ["ci", "Pull request checks"],
      ["scheduled", "Scheduled task"],
      ["session", "Provider session"],
      ["link", "Environment link"],
    ];
    for (const [source, label] of sources) {
      const text = evidenceDescription({
        source,
        reason: "network",
        command: "pnpm i",
        error: "line one\nline two",
        where: "Linux",
        firstSeen: Date.UTC(2026, 10, 13, 9, 5),
        lastSeen: Date.UTC(2026, 10, 13, 10, 0),
        threads: [{ id: "thread-1", title: "Fix" }],
      });
      assert.include(text, `- **Source:** ${label}`);
      assert.include(text, source === "ci" ? "- **Check:** `pnpm i`" : "- **Command:** `pnpm i`");
      assert.include(text, "- **Reason:** Network or DNS failure");
      assert.include(text, "- **Where:** Linux");
      assert.include(text, "- **First seen:** 2026-11-13 09:05 UTC");
      assert.include(text, "- **Last seen:** 2026-11-13 10:00 UTC");
      assert.match(text, /- \*\*Threads:\*\* \[Fix\]\([^)]*thread-1[^)]*\)/);
      assert.include(text, "```\nline one\nline two\n```");
    }
    const bare = evidenceDescription({
      source: "link",
      reason: "link-unreachable",
      command: null,
      error: "fetch failed",
      where: null,
      firstSeen: 0,
      lastSeen: 0,
      threads: [],
    });
    assert.notInclude(bare, "Command");
    assert.notInclude(bare, "Threads");
    assert.include(bare, "- **Error:** fetch failed");
  });

  it("tells the owner what its level allows and never to push or deploy without an OK", () => {
    const one = [
      {
        header: "Problem in A: x. Card #1.",
        cardId: "c1",
        projectId: "p1",
        description: "- e",
        count: 1,
        reassigned: false,
      },
    ];
    const tell = wakeText(one, "tell");
    assert.include(tell, 'Your level is "Tell me"');
    assert.include(tell, "Start nothing");
    assert.include(tell, "found a problem and filed a card for it");
    const offer = wakeText(one, "offer");
    assert.include(offer, "Start only after the user agrees");
    const fix = wakeText(
      [...one, { ...one[0]!, cardId: "c2", count: 3, reassigned: true }],
      "fix-small",
    );
    assert.include(fix, "If the fix is small, start it now");
    assert.include(fix, "link_thread");
    assert.include(fix, "run_finished");
    assert.include(fix, "found 2 problems");
    assert.include(fix, "It moved to you");
    for (const text of [tell, offer, fix]) {
      assert.include(
        text,
        "Never push, merge, deploy, delete files, branches or data, or open a pull request",
      );
      assert.include(text, "Do not call notify_user");
      assert.include(text, "t3_kanban ignore_problem");
    }
  });
});
