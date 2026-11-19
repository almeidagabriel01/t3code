// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  HEAVY_JOB_ENV,
  heavyRoute,
  heavySegment,
  hookScript,
  interceptBashCall,
  isQueued,
  nameOf,
  lineParts,
  queueBashCall,
  readLine,
  workParts,
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
  // git's own options take a value before the subcommand.
  ["git -C apps/web -c user.name=t commit -m x", "git -C apps/web -c user.name=t commit -m x"],
  ["time ./gradlew assembleDebug", "time ./gradlew assembleDebug"],
  ["xcrun xcodebuild -scheme App build", "xcrun xcodebuild -scheme App build"],
  ["xcrun simctl boot 'iPhone 17'", "xcrun simctl boot 'iPhone 17'"],
  ["docker compose up -d", "docker compose up -d"],
  ["cargo test --locked", "cargo test --locked"],
  ["(cd web && vp build) | tail -5", "vp build"],
  ["make test", "make test"],
  ["cat > a.sh <<'EOF'\necho hi\nEOF\nvp test run", "vp test run"],
  ["timeout 110 vp test run", "timeout 110 vp test run"],
  ["(nohup vp test run > /tmp/a.log 2>&1 &)", "nohup vp test run > /tmp/a.log 2>&1"],
  ["nohup sh -c 'npx tsc --noEmit > /tmp/t.out' &", "nohup sh -c 'npx tsc --noEmit > /tmp/t.out'"],
  ["X=$(vp test run 2>&1 | tail -1)", "vp test run 2>&1"],
  ["nice -n 10 vp test run", "nice -n 10 vp test run"],
  // A prefix option's value is not the program.
  [
    "timeout -s KILL -k 5 3500 vp run check:changed",
    "timeout -s KILL -k 5 3500 vp run check:changed",
  ],
  ["timeout --signal TERM 60 vp test run", "timeout --signal TERM 60 vp test run"],
  ["nice --adjustment 5 vp test run", "nice --adjustment 5 vp test run"],
  ["env -u CI -C apps/server vp test run", "env -u CI -C apps/server vp test run"],
  ["caffeinate -w 123 vp test run", "caffeinate -w 123 vp test run"],
  ["time -f %e vp test run", "time -f %e vp test run"],
  [
    "nohup env -u CI timeout -s INT 10 vp test run",
    "nohup env -u CI timeout -s INT 10 vp test run",
  ],
  // A formatter or linter given its files is light: the heavy work beside it is the segment.
  ["vp fmt a.ts b.tsx && vp lint --no-ignore a.ts b.tsx && vp test run", "vp test run"],
  ['f=(a.ts); vp fmt "${f[@]}" && vp test run src/a.test.ts', "vp test run src/a.test.ts"],
  [
    "cd apps/server && pnpm exec vp fmt src/x.ts && pnpm exec effect-tsgo tsrs --noEmit",
    "pnpm exec effect-tsgo tsrs --noEmit",
  ],
  ["vp run fmt src/a.ts; vp run typecheck", "vp run typecheck"],
  // Without files it walks the whole tree: writing or checking, still heavy.
  ["vp fmt", "vp fmt"],
  ["vp fmt --check", "vp fmt --check"],
  ["vp fmt . && vp lint", "vp fmt ."],
  ["vp fmt apps/web && vp lint a.ts", "vp fmt apps/web"],
  ["pnpm run format", "pnpm run format"],
  ["vp lint", "vp lint"],
  ["vp lint --no-ignore", "vp lint --no-ignore"],
  ["oxlint .", "oxlint ."],
  ["eslint src", "eslint src"],
  // An expansion may name a folder or the whole tree, unless the line shows it lists files.
  ["vp fmt $(git ls-files)", "vp fmt $(git ls-files)"],
  ['vp fmt "$DIR"', 'vp fmt "$DIR"'],
  ["vp fmt $(find .)", "vp fmt $(find .)"],
  ["vp fmt `ls`", "vp fmt `ls`"],
  ["vp fmt $f 2>&1", "vp fmt $f 2>&1"],
  ["vp fmt src/$(x).ts", "vp fmt src/$(x).ts"],
  ["for f in $(git ls-files); do vp fmt $f; done", "vp fmt $f"],
  ["for f in a.ts; do f=apps; vp fmt $f; done", "vp fmt $f"],
  ['f=($(git ls-files)); vp fmt "${f[@]}"', 'vp fmt "${f[@]}"'],
  ['f=(a.ts); f+=(apps); vp fmt "${f[@]}"', 'vp fmt "${f[@]}"'],
  // A dot in a folder's name is not a file's extension.
  ["vp fmt apps/v1.2", "vp fmt apps/v1.2"],
  ["vp fmt packages/foo.bar", "vp fmt packages/foo.bar"],
];

const LIGHT = [
  "ls -la",
  "git status && git log --format=%H -3",
  "git checkout -b fix-build",
  "git commit --no-verify -m 'wip'",
  "git commit -n -m 'wip'",
  "git -C web commit -n -m wip",
  "git -c commit.gpgsign=false log",
  "cat build.md",
  "rg docker apps/server",
  "rg 'vp test run' docs",
  "echo vitest",
  "test -f package.json && echo yes",
  "vp run dev",
  // Rows 15 and 16: what keeps running is load, never a queue job.
  "vp run dev:desktop",
  "npx expo start",
  "vp test --watch",
  "pnpm exec vitest watch",
  "cd apps/web && vp run dev",
  "pnpm install",
  "node scripts/x.mjs",
  "npx prettier --check .",
  "pnpm exec",
  "cargo",
  "vpr dev",
  "",
  // A heredoc is a script's text, not commands: editing a test file is not running it.
  "cd /w && python3 - <<'EOF'\ns = 'cd apps/server && vp test run'\nEOF",
  "cat <<-END > notes.md\n\tvp run build && npm test\n\tEND",
  // Quoted text and patterns are arguments, never commands.
  'grep -v "t3 heavy" log.txt',
  'grep "a\\|vitest" src/x.ts',
  "git log --grep 'vp test run' -1",
  "bash -c 'echo vitest'",
  // A formatter given its files one by one, or one file on stdin.
  "vp fmt apps/web/src/a.ts apps/web/src/b.tsx",
  "vp fmt a.ts b.tsx",
  "vp fmt --stdin-filepath=a.ts",
  "for f in a.ts b.tsx; do vp fmt $f 2>&1; done",
  'f=(a.ts b.tsx); vp fmt "${f[@]}"',
  "pnpm exec vp fmt src/x.ts",
  "./node_modules/.bin/vp fmt apps/web/src/a.tsx",
  "vpr fmt a.ts",
  "vp fmt --check a.ts",
  "vp fmt --stdin-filepath a.ts < a.ts",
  "vp fmt --stdin-filepath=a.ts < a.ts > out.ts",
  "vp fmt --check --ignore-path=.fmt-empty-ignore a.ts b.tsx",
  // A linter given its files touches only those, like a formatter.
  "vp lint a.ts b.tsx",
  "vp lint --no-ignore a.ts b.tsx",
  'files=(a.ts b.tsx); vp lint --no-ignore "${files[@]}"',
  "pnpm exec vp lint src/x.ts",
  "oxlint src/a.ts",
  "npx eslint --fix src/a.ts",
  'for f in $(git diff --name-only t3/fork2...HEAD); do command vp fmt --stdin-filepath=$f < $f 2>/dev/null | cmp -s - $f || echo "fmt diff $f"; done; echo fmt-done',
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
    [`cd "/a b" && remoto vp test`, true],
    ["cd '/a b' && remoto vp test", true],
    ["vp test run heavyQueue", false],
    ["rg heavy apps", false],
    ["echo remoto && vp test run", false],
    // Text is never a call; and a call does not cover heavy work outside it.
    ['vp test run 2>&1 | grep -v "t3 heavy"', false],
    ["git commit -m 'feat: t3 heavy -- vp test'", false],
    ["t3 heavy -- vp lint && vp test run", false],
    [
      "A='/Applications/T3 Code (Beta).app/Contents'; ELECTRON_RUN_AS_NODE=1 \"$A/MacOS/T3 Code (Beta)\" \"$A/Resources/app.asar/apps/server/dist/bin.mjs\" heavy --queue-dir /q -- sh -c 'vp test'",
      true,
    ],
  ])("%s already queued: %s", (command, queued) => {
    expect(isQueued(command)).toBe(queued);
  });

  it.each([
    ["vp test run src/a.test.ts --watch", "vp test run"],
    ["git commit -m 'fix build'", "git commit"],
    ["git -C web commit -m 'fix build'", "git commit"],
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
          command: `${PREFIX} --request-id 'toolu_1' --name 'vp test run' -- "\${SHELL:-/bin/sh}" -c 'cd apps/server && vp test run '\\''it'\\'''\\''s'\\'''`,
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

  it.each([
    ["toolu_9", " --request-id 'toolu_9' --name"],
    ["", " --name"],
    [42, " --name"],
  ])("passes the call's tool-use id %j on, so a repeat attaches to its job", (id, expected) => {
    const answer = queueBashCall({ ...bash({ command: "vp build" }), tool_use_id: id }, PREFIX);
    expect(answer!.hookSpecificOutput.updatedInput.command).toContain(
      `${PREFIX}${expected} 'vp build'`,
    );
  });

  it("never lowers a longer timeout and gives a background call the background limit", () => {
    const longer = queueBashCall(bash({ command: "vp build", timeout: 900_000 }), PREFIX);
    expect(longer!.hookSpecificOutput.updatedInput.timeout).toBe(900_000);
    const background = queueBashCall(
      bash({ command: "vp build", run_in_background: true }),
      PREFIX,
    );
    expect(background!.hookSpecificOutput.updatedInput.timeout).toBe(7_200_000);
    expect(background!.hookSpecificOutput).not.toHaveProperty("additionalContext");
  });

  const probed =
    (startsNow: boolean, runsOn: "mac" | "linux" = "mac") =>
    () => ({
      startsNow,
      runsOn,
      position: startsNow ? null : 3,
      reason: startsNow ? null : "2 jobs running",
    });

  it.each([
    ["starts now", probed(true), false, false, 600_000, null],
    [
      "waits on this Mac, in T3",
      probed(false),
      true,
      true,
      7_200_000,
      "Queued on this Mac (position 3, 2 jobs running)",
    ],
    [
      "waits on Linux, outside T3",
      probed(false, "linux"),
      false,
      true,
      7_200_000,
      "Queued on Linux (position 3, 2 jobs running)",
    ],
  ] as const)("a call that %s", (_why, probe, inT3, background, timeout, note) => {
    const answer = queueBashCall(
      bash({ command: "vp build", description: "Build", timeout: 120_000 }),
      PREFIX,
      {},
      { probe, inT3 },
    )!.hookSpecificOutput;
    expect(answer.updatedInput).toMatchObject({ description: "Build", timeout });
    expect("run_in_background" in answer.updatedInput).toBe(background);
    const context = (answer as { additionalContext?: string }).additionalContext;
    if (note === null) expect(context).toBeUndefined();
    else {
      expect(context).toContain(note);
      if (background) {
        expect(context).toContain(inT3 ? "t3_background_wait" : "Claude Code tells you");
      }
    }
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

describe("scripts the line runs", () => {
  const files: Record<string, string | null> = {
    "/tmp/s/verify.sh": "cd /w && vp test run",
    "./verify": "#!/bin/bash\nset -e\nvp run typecheck\n",
    "./env-verify": "#!/usr/bin/env zsh\nnpx tsc --noEmit\n",
    "./tool": "#!/usr/bin/env node\nrequire('x')\n",
    "light.sh": "echo hi\nls\n",
    "./light.sh": "echo hi\n",
    "missing.sh": null,
  };
  const read = (word: string) => files[word] ?? null;
  const command = (line: string) =>
    queueBashCall(bash({ command: line }), PREFIX, {}, { readScript: read })?.hookSpecificOutput
      .updatedInput.command ?? null;

  it.each([
    ["bash /tmp/s/verify.sh", "bash /tmp/s/verify.sh"],
    ["sh -e /tmp/s/verify.sh a b", "sh /tmp/s/verify.sh a"],
    ["/tmp/s/verify.sh", "verify.sh"],
    ["./verify", "verify"],
    ["./env-verify --fast", "env-verify"],
    ["cd /w && ./verify", "verify"],
  ])("queues %j, whose script runs heavy work, as %j", (line, name) => {
    expect(command(line)).toBe(
      `${PREFIX} --request-id 'toolu_1' --name '${name}' -- "\${SHELL:-/bin/sh}" -c '${line}'`,
    );
  });

  it.each(["bash light.sh", "./tool", "./light.sh", "bash -c 'echo hi'", "sh -s < light.sh"])(
    "leaves %j alone: its script runs nothing heavy, or it is no script",
    (line) => {
      expect(command(line)).toBeNull();
    },
  );

  // The Runner decides where it runs: a script it couldn't read is no reason to stay here.
  it.each([
    ["bash missing.sh", "bash missing.sh"],
    ["./missing.sh", "missing.sh"],
  ])("queues %j, whose script can't be read, as %j", (line, name) => {
    expect(command(line)).toBe(
      `${PREFIX} --request-id 'toolu_1' --name '${name}' -- "\${SHELL:-/bin/sh}" -c '${line}'`,
    );
  });

  it("reads no script without a reader, as before", () => {
    expect(queueBashCall(bash({ command: "bash /tmp/s/verify.sh" }), PREFIX)).toBeNull();
  });
});

describe("an agent's own remoto call", () => {
  it.each([
    ["remoto vp test run", [], true, "vp test run"],
    [
      "cd apps/server && remoto vp test run src/a.test.ts",
      ["apps/server"],
      true,
      "vp test run src/a.test.ts",
    ],
    [`cd "/a b" && cd 'c' && remoto vp test`, ["/a b", "c"], true, "vp test"],
    [
      "cd /Users/me/repo/apps/web && remoto pnpm exec vp test run a.test.ts 2>&1 | grep -E x",
      ["/Users/me/repo/apps/web"],
      true,
      "pnpm exec vp test run a.test.ts 2>&1 | grep -E x",
    ],
    ["  remoto ./scripts/check.sh --all", [], true, "./scripts/check.sh --all"],
    ["cd /w && vp test run", ["/w"], false, "vp test run"],
    ["cd /w && cd $X && remoto vp test", ["/w"], true, "cd $X && vp test"],
    ["ls && remoto vp test run", [], true, "ls && vp test run"],
    ["REMOTO_HOST=pc remoto vp test", [], true, "REMOTO_HOST=pc vp test"],
    ["cd /w && (cd x && vp test)", ["/w"], false, "(cd x && vp test)"],
    ["cd /w; vp test", [], false, "cd /w; vp test"],
    ["remoto", [], false, "remoto"],
  ])("%j starts in %j, remoto %s, running %j", (line, dirs, remoto, command) => {
    expect(lineParts(line)).toEqual({ dirs, remoto, command });
  });

  it("with the Runner on, is queued as written and named by its own command; `t3 heavy` unwraps it", () => {
    const answer = queueBashCall(
      bash({ command: "cd apps/server && remoto vp test run" }),
      PREFIX,
      {},
      { runner: true },
    );
    expect(answer!.hookSpecificOutput.updatedInput.command).toBe(
      `${PREFIX} --request-id 'toolu_1' --name 'vp test run' -- "\${SHELL:-/bin/sh}" -c 'cd apps/server && remoto vp test run'`,
    );
    const script = queueBashCall(bash({ command: "remoto ./x.sh" }), PREFIX, {}, { runner: true });
    expect(script!.hookSpecificOutput.updatedInput.command).toContain("--name 'x.sh'");
  });

  it.each([
    ["the Runner off", "remoto vp test run", false],
    ["the Runner off, after another command", "ls && remoto vp test run", false],
  ])("is left to remoto with %s, so it never runs twice", (_why, command, runner) => {
    expect(queueBashCall(bash({ command }), PREFIX, {}, { runner })).toBeNull();
  });

  // Queued or left to the agent's remoto.
  it.each([
    [`cd /w/s && remoto sh -c 'vp test run'`, true, null, true],
    [`cd /w/s && remoto sh -c 'vp test run'`, false, null, false],
    [`remoto sh -c 'cd /w && remoto vp test'`, true, null, true],
    [`sh -c 'cd /w && remoto vp test run'`, true, null, false],
    [`cd /w && bash -lc "remoto pnpm exec vp test run"`, true, null, false],
    [`vp lint && sh -c 'remoto vp test'`, true, null, true],
    [`cd /w && vp lint && remoto vp test`, true, null, true],
    // Local heavy work beside the inner remoto still queues.
    [`sh -c 'vp lint && remoto vp test'`, true, null, true],
    [`sh -c 'vp lint && remoto vp test'`, false, null, true],
    ["sh ./check.sh", true, "cd /w && remoto vp test run", false],
    ["sh ./check.sh", true, "vp lint && remoto vp test run", true],
    // `t3 heavy` inside hands off like `remoto`.
    ["sh ./check.sh", true, "t3 heavy -- vp lint && remoto vp test run", false],
    ["sh ./check.sh", true, "vp lint && t3 heavy -- vp test run", true],
    [
      "sh ./check.sh",
      true,
      `vp lint\nELECTRON_RUN_AS_NODE=1 '/App/T3 Code' '/App/bin.mjs' heavy --queue-dir '/q' -- vp test run`,
      true,
    ],
    ["remoto vp test run", false, null, false],
  ])("%j (Runner %s, script %j) queued %s", (command, runner, body, queued) => {
    const readScript = () => body;
    const answer = queueBashCall(bash({ command }), PREFIX, {}, { runner, readScript });
    expect(answer !== null).toBe(queued);
    // A script that calls remoto is never Linux work, so it is never wrapped in another.
    if (body !== null) expect(workParts(readLine(command, readScript).parts)).toEqual([]);
  });
});

describe("the one switch every entry point reads", () => {
  it.each([
    [true, false, "queue"],
    [false, false, "direct"],
    [false, true, "queue"],
    [true, true, "queue"],
  ] as const)("queue %s, Runner %s: %s", (enabled, runner, route) => {
    const heavy = bash({ command: "vp test run", description: "Tests" });
    expect(heavyRoute({ enabled, runner })).toBe(route);
    expect(interceptBashCall(heavy, PREFIX, { enabled, runner })).toEqual(
      route === "direct" ? null : queueBashCall(heavy, PREFIX, {}, { runner }),
    );
  });

  it("admission's Mac gate reads only the queue", () => {
    expect(heavyRoute({ enabled: false })).toBe("direct");
    expect(heavyRoute({ enabled: true })).toBe("queue");
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

  it.each(["bash verify.sh", "./verify", "sh /tmp/s/check.sh --all", "zsh -e run.zsh"])(
    "hands %j to T3, which reads the script it runs",
    (command) => {
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
