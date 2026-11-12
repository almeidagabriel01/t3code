// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  HEAVY_JOB_ENV,
  heavySegment,
  hookScript,
  isQueued,
  nameOf,
  queueBashCall,
  unwrapRemoto,
} from "./heavyHook.ts";

const PREFIX = "ELECTRON_RUN_AS_NODE=1 '/app/t3' heavy --queue-dir '/q'";
const bash = (toolInput: Record<string, unknown>) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: toolInput,
  tool_use_id: "toolu_1",
});

const HEAVY: ReadonlyArray<readonly [string, string]> = [
  ["vp test run", "vp test run"],
  ["vp test run src/a.test.ts", "vp test run src/a.test.ts"],
  ["cd apps/server && vp run typecheck", "vp run typecheck"],
  [
    "VITEST_MAX_WORKERS=2 vp run check:changed main",
    "VITEST_MAX_WORKERS=2 vp run check:changed main",
  ],
  ["pnpm --filter web run build", "pnpm --filter web run build"],
  ["npm test", "npm test"],
  ["npm t", "npm t"],
  ["yarn build", "yarn build"],
  ["vpr test:unit", "vpr test:unit"],
  ["npx vitest run", "npx vitest run"],
  ["pnpm exec playwright test", "pnpm exec playwright test"],
  ["bunx tsc --noEmit", "bunx tsc --noEmit"],
  ["node --test test/*.mjs", "node --test test/*.mjs"],
  ["git add a && git commit -m 'fix: x'", "git commit -m 'fix: x'"],
  ["time ./gradlew assembleDebug", "time ./gradlew assembleDebug"],
  ["xcrun xcodebuild -scheme App build", "xcrun xcodebuild -scheme App build"],
  ["xcrun simctl boot 'iPhone 17'", "xcrun simctl boot 'iPhone 17'"],
  ["docker compose up -d", "docker compose up -d"],
  ["cargo test --locked", "cargo test --locked"],
  ["(cd web && vp build) | tail -5", "vp build"],
  ["make test", "make test"],
];

const LIGHT = [
  "ls -la",
  "git status && git log --format=%H -3",
  "git checkout -b fix-build",
  "git commit --no-verify -m 'wip'",
  "git commit -n -m 'wip'",
  "cat build.md",
  "rg docker apps/server",
  "rg 'vp test run' docs",
  "echo vitest",
  "test -f package.json && echo yes",
  "vp run dev",
  "pnpm install",
  "node scripts/x.mjs",
  "npx prettier --check .",
  "pnpm exec",
  "cargo",
  "vpr dev",
  "",
];

describe("heavy Bash commands", () => {
  it.each(HEAVY)("%s is heavy, at %s", (command, segment) => {
    expect(heavySegment(command)).toBe(segment);
  });

  it.each(LIGHT)("%s is light", (command) => {
    expect(heavySegment(command)).toBeNull();
  });

  it.each([
    ["t3 heavy -- vp test run", true],
    ["t3 heavy --name 'Server tests' -- vp test run", true],
    [`${PREFIX} -- vp test run`, true],
    [
      "ELECTRON_RUN_AS_NODE=1 '/Applications/T3 Code.app/Contents/MacOS/T3 Code' heavy --queue-dir '/x' -- vp",
      true,
    ],
    ["remoto vp test run", true],
    ["cd apps/web && remoto pnpm test", true],
    ["vp test run heavyQueue", false],
    ["rg heavy apps", false],
    ["echo remoto && vp test run", false],
  ])("%s already queued: %s", (command, queued) => {
    expect(isQueued(command)).toBe(queued);
  });

  it.each([
    ["vp test run src/a.test.ts --watch", "vp test run"],
    ["git commit -m 'fix build'", "git commit"],
    ["npx vitest", "npx vitest"],
  ])("names %s as %s", (segment, name) => {
    expect(nameOf(segment)).toBe(name);
  });
});

describe("the PreToolUse answer", () => {
  it("wraps the whole line in the queue, keeping every field and raising the timeout", () => {
    const answer = queueBashCall(
      bash({
        command: "cd apps/server && vp test run 'it''s'",
        description: "Server tests",
        timeout: 120_000,
        run_in_background: false,
        dangerouslyDisableSandbox: true,
        futureField: { kept: true },
      }),
      PREFIX,
    );
    expect(answer).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          command: `${PREFIX} --name 'vp test run' -- "\${SHELL:-/bin/sh}" -c 'cd apps/server && vp test run '\\''it'\\'''\\''s'\\'''`,
          description: "Server tests",
          timeout: 600_000,
          run_in_background: false,
          dangerouslyDisableSandbox: true,
          futureField: { kept: true },
        },
      },
    });
    expect(answer!.hookSpecificOutput).not.toHaveProperty("permissionDecision");
  });

  it("never lowers a longer timeout and leaves a background call's limit alone", () => {
    const longer = queueBashCall(bash({ command: "vp build", timeout: 900_000 }), PREFIX);
    expect(longer!.hookSpecificOutput.updatedInput.timeout).toBe(900_000);
    const background = queueBashCall(
      bash({ command: "vp build", run_in_background: true }),
      PREFIX,
    );
    expect(background!.hookSpecificOutput.updatedInput).not.toHaveProperty("timeout");
  });

  it.each([
    ["a light command", bash({ command: "ls" }), {}],
    ["an already queued one", bash({ command: "t3 heavy -- vp test run" }), {}],
    ["a call inside a queue job", bash({ command: "vp test run" }), { T3CODE_HEAVY_JOB: "1" }],
    ["another tool", { tool_name: "Read", tool_input: { command: "vp test" } }, {}],
    ["no command", bash({}), {}],
    ["a non-object input", "vp test run", {}],
    ["a non-object tool input", { tool_name: "Bash", tool_input: "vp test" }, {}],
  ])("leaves %s alone", (_why, input, env) => {
    expect(queueBashCall(input, PREFIX, env)).toBeNull();
  });
});

describe("an agent's own remoto call", () => {
  it.each([
    ["remoto vp test run", "vp test run"],
    [
      "cd apps/server && remoto vp test run src/a.test.ts",
      "cd apps/server && vp test run src/a.test.ts",
    ],
    ["  remoto ./scripts/check.sh --all", "./scripts/check.sh --all"],
    ["ls && remoto vp test run", null],
    ["REMOTO_HOST=pc remoto vp test", null],
    ["remoto", null],
  ])("%j unwraps to %j", (command, unwrapped) => {
    expect(unwrapRemoto(command)).toBe(unwrapped);
  });

  it("with the Runner on, becomes one job sent to Linux instead of a second wrapper", () => {
    const answer = queueBashCall(
      bash({ command: "cd apps/server && remoto vp test run" }),
      PREFIX,
      {},
      { runner: true },
    );
    expect(answer!.hookSpecificOutput.updatedInput.command).toBe(
      `${PREFIX} --runner linux --name 'vp test run' -- "\${SHELL:-/bin/sh}" -c 'cd apps/server && vp test run'`,
    );
    const script = queueBashCall(bash({ command: "remoto ./x.sh" }), PREFIX, {}, { runner: true });
    expect(script!.hookSpecificOutput.updatedInput.command).toContain(
      "--runner linux --name 'x.sh'",
    );
  });

  it.each([
    ["the Runner off", "remoto vp test run", false],
    ["a shape it cannot unwrap", "ls && remoto vp test run", true],
  ])("is left to remoto with %s, so it never runs twice", (_why, command, runner) => {
    expect(queueBashCall(bash({ command }), PREFIX, {}, { runner })).toBeNull();
  });
});

describe("the sh pre-filter installed for sessions outside T3", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-hook-"));
  const script = (hookCommand: string) => {
    const path = NodePath.join(dir, `${NodeFS.readdirSync(dir).length}.sh`);
    NodeFS.writeFileSync(path, hookScript(hookCommand));
    return path;
  };
  // Stands in for `t3 heavy hook`: says it was reached.
  const reached = script("printf T3");
  const run = (path: string, command: unknown, env: NodeJS.ProcessEnv = {}) =>
    NodeChildProcess.execFileSync("/bin/sh", [path], {
      // Claude Code's field order: the session's paths come before the tool input.
      input: JSON.stringify({
        session_id: "s",
        transcript_path: "/Users/me/.claude/projects/vp-go/s.jsonl",
        cwd: "/Users/me/go",
        ...bash({ command, description: "Run vp tests", timeout: 1000 }),
      }),
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
    });
  // Every way the classifier can still find a heavy command: after a cd, on a later line, after a tab.
  const variants = (command: string) => [
    command,
    `cd /tmp && ${command}`,
    `echo start\n${command}`,
    `\t${command}`,
    `NODE_OPTIONS="--max-old-space-size=4096 --x" ${command}`,
  ];

  it.each(HEAVY.flatMap(([command]) => variants(command)))(
    "hands %j to T3, as the classifier calls it heavy",
    (command) => {
      expect(heavySegment(command)).not.toBeNull();
      expect(run(reached, command)).toBe("T3");
    },
  );

  it("hands a remoto call to T3, which decides whether the Runner takes it", () => {
    expect(run(reached, "remoto ./scripts/check.sh")).toBe("T3");
  });

  it.each(["ls -la", "git status && git log --format=%H -3", "cat build.md", "rg TODO apps"])(
    "answers %j itself with no output",
    (command) => {
      expect(run(reached, command)).toBe("");
    },
  );

  it("passes the command through when T3 is gone, fails, or the call runs inside a queue job", () => {
    expect(run(script("/nonexistent/t3 heavy hook"), "vp test run")).toBe("");
    expect(run(script("printf partial; exit 3"), "vp test run")).toBe("");
    expect(run(reached, "vp test run", { [HEAVY_JOB_ENV]: "1" })).toBe("");
  });
});
