import { describe, expect, it } from "@effect/vitest";

import { heavySegment, isQueued, nameOf, queueBashCall } from "./heavyHook.ts";

const PREFIX = "ELECTRON_RUN_AS_NODE=1 '/app/t3' heavy --queue-dir '/q'";
const bash = (toolInput: Record<string, unknown>) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: toolInput,
  tool_use_id: "toolu_1",
});

describe("heavy Bash commands", () => {
  it.each([
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
  ])("%s is heavy, at %s", (command, segment) => {
    expect(heavySegment(command)).toBe(segment);
  });

  it.each([
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
  ])("%s is light", (command) => {
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
