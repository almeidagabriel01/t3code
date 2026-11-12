// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { labelOf, launchOf, parseHeavyArgs, selfPrefix, withWorkers } from "./heavyCli.ts";
import * as Queue from "./queueFile.ts";

const BIN = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));
const children: NodeChildProcess.ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-cli-"));
  dirs.push(dir);
  return dir;
};

/** The program holds the slot until its stdin closes, so the test decides when each one finishes. */
const holdProgram = (marker: string, name: string) =>
  `const fs=require("fs");fs.appendFileSync(${JSON.stringify(marker)},"start ${name}\\n");` +
  `console.log("started ${name}");process.stdin.resume();` +
  `process.stdin.on("end",()=>{fs.appendFileSync(${JSON.stringify(marker)},"end ${name}\\n")})`;

const heavy = (
  dir: string,
  program: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = {},
  options: ReadonlyArray<string> = ["--"],
) => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [BIN, "heavy", "--queue-dir", dir, ...options, ...program],
    {
      stdio: ["pipe", "pipe", "pipe"],
      // Undefined drops a variable: a run of these tests inside a queue job must still queue.
      env: { ...process.env, T3CODE_HEAVY_JOB: undefined, ...env },
    },
  );
  children.push(child);
  let out = "";
  let err = "";
  const waiters: Array<() => void> = [];
  const notify = () => waiters.splice(0).forEach((wake) => wake());
  child.stdout.on("data", (chunk) => ((out += chunk), notify()));
  child.stderr.on("data", (chunk) => ((err += chunk), notify()));
  const until = (stream: "out" | "err", text: string) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if ((stream === "out" ? out : err).includes(text)) resolve();
        else waiters.push(check);
      };
      check();
    });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, until, exited, stdout: () => out, stderr: () => err };
};

describe("t3 heavy", () => {
  it("runs concurrent commands one at a time, in the order they queued", async () => {
    const dir = tempDir();
    const marker = NodePath.join(dir, "marker.txt");
    const run = (name: string, env?: NodeJS.ProcessEnv) =>
      heavy(dir, [process.execPath, "-e", holdProgram(marker, name)], env);

    const first = run("1", { T3CODE_THREAD_ID: "thread-1" });
    await first.until("out", "started 1");
    expect(Queue.read(dir)[0]).toMatchObject({ threadId: "thread-1", cwd: process.cwd() });
    const second = run("2");
    await second.until("err", "waiting: position 1 (running: ");
    const third = run("3");
    await third.until("err", "waiting: position 2");
    second.child.stdin.end();
    third.child.stdin.end();
    first.child.stdin.end();

    expect(await Promise.all([first.exited, second.exited, third.exited])).toEqual([0, 0, 0]);
    expect(NodeFS.readFileSync(marker, "utf8").trim().split("\n")).toEqual([
      "start 1",
      "end 1",
      "start 2",
      "end 2",
      "start 3",
      "end 3",
    ]);
    expect(Queue.read(dir)).toEqual([]);
  });

  it("frees the place of a killed waiter and exits 125 when the user removes one", async () => {
    const dir = tempDir();
    const marker = NodePath.join(dir, "marker.txt");
    const run = (name: string) => heavy(dir, [process.execPath, "-e", holdProgram(marker, name)]);

    const first = run("1");
    await first.until("out", "started 1");
    const second = run("2");
    await second.until("err", "position 1");
    const third = run("3");
    await third.until("err", "position 2");
    const fourth = run("4");
    await fourth.until("err", "position 3");

    second.child.kill("SIGKILL");
    await third.until("err", "position 1");
    await fourth.until("err", "position 2");
    const removed = Queue.read(dir).find(
      (entry) => entry.startedAt === null && entry.pid === fourth.child.pid,
    )!;
    expect(Queue.cancel(dir, removed.id)).toBe("ok");
    expect(await fourth.exited).toBe(125);
    expect(fourth.stderr()).toContain("Removed from the heavy queue by the user.");

    third.child.stdin.end();
    first.child.stdin.end();
    expect(await Promise.all([first.exited, third.exited])).toEqual([0, 0]);
  });

  it("passes the program's exit code through, and a waiter interrupted leaves the queue", async () => {
    const dir = tempDir();
    const failing = heavy(dir, [process.execPath, "-e", "process.exit(7)"]);
    expect(await failing.exited).toBe(7);

    const holder = heavy(dir, [process.execPath, "-e", holdProgram(NodePath.join(dir, "m"), "h")]);
    await holder.until("out", "started h");
    const waiter = heavy(dir, [process.execPath, "-e", ""]);
    await waiter.until("err", "position 1");
    waiter.child.kill("SIGTERM");
    expect(await waiter.exited).toBe(143);
    expect(Queue.read(dir)).toHaveLength(1);
    holder.child.stdin.end();
    expect(await holder.exited).toBe(0);
  });

  it("reports a missing program and a program that cannot start", async () => {
    const dir = tempDir();
    const none = heavy(dir, []);
    expect(await none.exited).toBe(2);
    expect(none.stderr()).toContain("Usage: t3 heavy");
    const missing = heavy(dir, ["/nonexistent/t3-heavy-program"]);
    expect(await missing.exited).toBe(127);
    expect(Queue.read(dir)).toEqual([]);
  });

  it("tells the started program its worker count and that it holds a slot", async () => {
    const dir = tempDir();
    const show = `console.log([process.env.T3_HEAVY_WORKERS,process.env.VITEST_MAX_WORKERS,process.env.T3CODE_HEAVY_JOB].join(","))`;
    const run = heavy(dir, [process.execPath, "-e", show], { VITEST_MAX_WORKERS: undefined });
    expect(await run.exited).toBe(0);
    // The count depends on this machine's load right now: the cores free, at least two.
    const [workers, vitest, job] = run.stdout().trim().split(",");
    expect(Number(workers)).toBeGreaterThanOrEqual(2);
    expect(Number(workers)).toBeLessThan(Math.max(3, NodeOS.availableParallelism()));
    expect([vitest, job]).toEqual([workers, "1"]);
    const kept = heavy(dir, [process.execPath, "-e", show], { VITEST_MAX_WORKERS: "2" });
    await kept.until("out", `,2,1`);
    expect(await kept.exited).toBe(0);
  });

  it("inside a queue job runs at once without queuing, so it never waits on its own slot", async () => {
    const dir = tempDir();
    const marker = NodePath.join(dir, "m");
    const nested = heavy(dir, [process.execPath, "-e", holdProgram(marker, "n")], {
      T3CODE_HEAVY_JOB: "1",
    });
    await nested.until("out", "started n");
    expect(Queue.read(dir)).toEqual([]);
    nested.child.stdin.end();
    expect(await nested.exited).toBe(0);
  });

  it("queues agents' jobs low, the user's normal, and --priority high as asked", async () => {
    const dir = tempDir();
    const marker = NodePath.join(dir, "m");
    const holder = heavy(dir, [process.execPath, "-e", holdProgram(marker, "h")], {
      T3CODE_THREAD_ID: "t",
    });
    await holder.until("out", "started h");
    const user = heavy(dir, [process.execPath, "-e", ""], {
      T3CODE_THREAD_ID: undefined,
      CLAUDECODE: undefined,
    });
    await user.until("err", "position 1");
    const high = heavy(dir, [process.execPath, "-e", ""], { CLAUDECODE: "1" }, [
      "--priority",
      "high",
      "--",
    ]);
    await high.until("err", "position 2");
    expect(Queue.read(dir).map((entry) => entry.priority)).toEqual(["low", "normal", "high"]);
    holder.child.stdin.end();
    expect(await Promise.all([holder.exited, user.exited, high.exited])).toEqual([0, 0, 0]);
  });

  it("as a hook, wraps a heavy Bash call into this queue and fails open on anything else", async () => {
    const dir = tempDir();
    const hook = (stdin: string, env: NodeJS.ProcessEnv = {}) => {
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [BIN, "heavy", "hook", "--queue-dir", dir],
        {
          input: stdin,
          encoding: "utf8",
          env: { ...process.env, T3CODE_HEAVY_JOB: undefined, ...env },
        },
      );
      return { code: result.status, out: result.stdout };
    };
    const call = {
      tool_name: "Bash",
      tool_input: { command: "vp test run", description: "Run tests" },
    };
    const wrapped = hook(JSON.stringify(call));
    expect(wrapped.code).toBe(0);
    const answer = JSON.parse(wrapped.out);
    expect(answer.hookSpecificOutput.updatedInput).toMatchObject({
      description: "Run tests",
      timeout: 600_000,
    });
    expect(answer.hookSpecificOutput.updatedInput.command).toContain(
      `heavy --queue-dir '${dir}' --name 'vp test run' -- `,
    );
    expect(hook("not json")).toEqual({ code: 0, out: "" });
    expect(hook(JSON.stringify(call), { T3CODE_HEAVY_JOB: "1" })).toEqual({ code: 0, out: "" });
    expect(hook(JSON.stringify({ ...call, tool_input: { command: "ls" } }))).toEqual({
      code: 0,
      out: "",
    });
  });

  it("labels a shell-wrapped line by the line, and starts itself the same way again", () => {
    expect(labelOf("/bin/zsh", ["-c", "cd x && vp test run"])).toBe("cd x && vp test run");
    expect(labelOf("vp", ["test", "run"])).toBe("vp test run");
    expect(labelOf("zsh", ["script.sh"])).toBe("zsh script.sh");
    expect(selfPrefix("/q dir", { ELECTRON_RUN_AS_NODE: "1" })).toMatch(
      /^ELECTRON_RUN_AS_NODE=1 '.+' heavy --queue-dir '\/q dir'$/,
    );
    expect(selfPrefix("/q", {})).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it.each([
    [true, "darwin", "/usr/sbin/taskpolicy", ["-b", "vp", "test"], "background"],
    [false, "darwin", "vp", ["test"], "normal"],
    [true, "linux", "vp", ["test"], null],
  ] as const)("starts in the background: %s on %s", (background, platform, program, args, qos) => {
    expect(launchOf("vp", ["test"], background, platform)).toEqual({ program, args, qos });
  });

  it.each([
    { program: "vp", args: ["test", "run"], expected: ["test", "run"] },
    {
      program: "/usr/bin/node",
      args: ["--test", "a.js"],
      expected: ["--test", "a.js", "--test-concurrency=4"],
    },
    {
      program: "node",
      args: ["--test", "--test-concurrency=1"],
      expected: ["--test", "--test-concurrency=1"],
    },
    { program: "node", args: ["a.js"], expected: ["a.js"] },
    { program: "playwright", args: ["test"], expected: ["test", "--workers=4"] },
    { program: "playwright", args: ["test", "--workers=1"], expected: ["test", "--workers=1"] },
    { program: "playwright", args: ["install"], expected: ["install"] },
  ])("hands $program $args the admitted workers", ({ program, args, expected }) => {
    const run = withWorkers(program, args, 4, { PATH: "/bin" });
    expect(run.args).toEqual(expected);
    expect(run.env).toEqual({
      PATH: "/bin",
      T3CODE_HEAVY_JOB: "1",
      T3_HEAVY_WORKERS: "4",
      VITEST_MAX_WORKERS: "4",
    });
  });

  it("parses the queue dir and the separator", () => {
    expect(parseHeavyArgs(["--queue-dir", "/q", "--", "vp", "test"])).toEqual({
      dir: "/q",
      name: undefined,
      priority: undefined,
      program: "vp",
      args: ["test"],
    });
    expect(parseHeavyArgs(["--priority", "high", "--", "vp"]).priority).toBe("high");
    expect(parseHeavyArgs(["--priority", "urgent", "--", "vp"]).priority).toBeUndefined();
    expect(
      parseHeavyArgs(["--name", "Server tests", "--queue-dir", "/q", "--", "vp", "test"]),
    ).toMatchObject({
      name: "Server tests",
      dir: "/q",
      program: "vp",
    });
    expect(parseHeavyArgs(["--queue-dir", "/q", "--name", "  ", "--", "vp"]).name).toBeUndefined();
    expect(parseHeavyArgs(["vp"]).dir).toBe(Queue.defaultQueueDir());
  });
});
