// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  heavyLaunch,
  launchOf,
  linuxLine,
  parseHeavyArgs,
  selfPrefix,
  withWorkers,
} from "./heavyCli.ts";
import { isQueued, queueBashCall } from "./heavyHook.ts";
import { jobOf, labelOf } from "./jobEntry.ts";
import {
  DEFAULT_MACHINE_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  eligibilityOf,
  NEEDS_GIT,
} from "./runner.ts";
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
  cwd?: string,
) => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [BIN, "heavy", "--queue-dir", dir, ...options, ...program],
    {
      cwd,
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

  it("runs a repeated request once and answers every caller with its code", async () => {
    const dir = tempDir();
    const marker = NodePath.join(dir, "marker.txt");
    const program = [
      process.execPath,
      "-e",
      `require("fs").appendFileSync(${JSON.stringify(marker)},"ran\\n");console.log("started");` +
        `process.stdin.resume();process.stdin.on("end",()=>process.exit(3))`,
    ];
    const options = ["--request-id", "toolu_same", "--"];
    const first = heavy(dir, program, {}, options);
    await first.until("out", "started");
    const again = heavy(dir, program, {}, options);
    first.child.stdin.end();
    again.child.stdin.end();
    expect(await Promise.all([first.exited, again.exited])).toEqual([3, 3]);
    // After the job ended, a third call gets the code without running it.
    const late = heavy(dir, program, {}, options);
    late.child.stdin.end();
    expect(await late.exited).toBe(3);
    expect(NodeFS.readFileSync(marker, "utf8")).toBe("ran\n");
  });

  it("--now starts at once past a full slot, as the user's Start now does", async () => {
    const dir = tempDir();
    const marker = NodePath.join(dir, "marker.txt");
    Queue.setMaxRunning(dir, 1);
    const first = heavy(dir, [process.execPath, "-e", holdProgram(marker, "1")]);
    await first.until("out", "started 1");
    const now = heavy(dir, [process.execPath, "-e", holdProgram(marker, "2")], {}, ["--now", "--"]);
    await now.until("out", "started 2");
    expect(Queue.read(dir).find((entry) => entry.pid === now.child.pid)).toMatchObject({
      forced: true,
    });
    first.child.stdin.end();
    now.child.stdin.end();
    expect(await Promise.all([first.exited, now.exited])).toEqual([0, 0]);
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

  it("passes the exit code through; an interrupted waiter leaves, an agent's keeps its place", async () => {
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

    // An agent's waiter keeps its place instead, and the same command run again takes it back.
    const asAgent = { T3CODE_THREAD_ID: "thread-1" };
    const agent = heavy(dir, [process.execPath, "-e", ""], asAgent);
    await agent.until("err", "position 1");
    agent.child.kill("SIGTERM");
    expect(await agent.exited).toBe(143);
    expect(agent.stderr()).toContain(
      "[t3 heavy] stopped while waiting (position 1); run the same command again within 10 min to keep this place.",
    );
    const kept = Queue.read(dir)[1]!;
    expect(kept.orphanedAt).toBeDefined();
    const retry = heavy(dir, [process.execPath, "-e", ""], asAgent);
    await retry.until("err", "position 1");
    expect(Queue.read(dir).map((entry) => [entry.id, entry.pid])).toEqual([
      [Queue.read(dir)[0]!.id, holder.child.pid],
      [kept.id, retry.child.pid],
    ]);
    holder.child.stdin.end();
    expect(await Promise.all([holder.exited, retry.exited])).toEqual([0, 0]);
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

  it("a Linux part outside a Linux job ends with a clear error, running nothing", async () => {
    const dir = tempDir();
    const marker = NodePath.join(dir, "ran");
    const child = NodeChildProcess.spawn(
      process.execPath,
      [BIN, "heavy", "linux-part", "--queue-dir", dir, "--", "touch", marker],
      { env: { ...process.env, T3CODE_HEAVY_JOB: undefined, T3CODE_REMOTO: undefined } },
    );
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(code).toBe(2);
    expect(err).toBe("[t3 heavy] linux-part runs only inside a Linux job.\n");
    expect(NodeFS.existsSync(marker)).toBe(false);
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

  it("queue off runs direct with the Runner off, and tracks an ungated job with it on", async () => {
    const dir = tempDir();
    const marker = NodePath.join(dir, "m");
    Queue.setEnabled(dir, false);
    const direct = heavy(dir, [process.execPath, "-e", holdProgram(marker, "d")]);
    await direct.until("out", "started d");
    expect(Queue.read(dir)).toEqual([]);
    direct.child.stdin.end();
    expect(await direct.exited).toBe(0);

    Queue.publishRunner(dir, {
      global: { ...DEFAULT_PROJECT_CONFIG, runnerEnabled: true },
      machine: DEFAULT_MACHINE_CONFIG,
      projects: [],
      publisher: { pid: process.pid, home: dir, primary: true },
    });
    const tracked = heavy(dir, [process.execPath, "-e", holdProgram(marker, "t")]);
    await tracked.until("out", "started t");
    expect(Queue.read(dir)).toEqual([
      expect.objectContaining({ ungated: true, startedAt: expect.any(String) }),
    ]);
    tracked.child.stdin.end();
    expect(await tracked.exited).toBe(0);
    expect(Queue.read(dir)).toEqual([]);
  });

  describe("with the Runner sending work to Linux (fake remoto and ssh)", () => {
    const M = "\\036remoto";
    const script = (dir: string, name: string, body: string) => {
      const path = NodePath.join(dir, name);
      NodeFS.writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return path;
    };
    /** Heartbeats read as online; a stop check answers `gone`. */
    const setup = (
      remotoBody: string,
      config: Partial<typeof DEFAULT_PROJECT_CONFIG> = {},
      machine: Partial<typeof DEFAULT_MACHINE_CONFIG> = {},
    ) => {
      const dir = tempDir();
      // A checkout, so work started in it may go to Linux.
      NodeFS.mkdirSync(NodePath.join(dir, ".git"));
      NodeFS.mkdirSync(NodePath.join(dir, "bin"));
      script(NodePath.join(dir, "bin"), "vp", 'echo "vp on mac: $*"');
      Queue.publishRunner(dir, {
        global: { ...DEFAULT_PROJECT_CONFIG, runnerEnabled: true, runnerWhere: "linux", ...config },
        machine: { ...DEFAULT_MACHINE_CONFIG, ...machine },
        projects: [],
        publisher: { pid: process.pid, home: dir, primary: true },
      });
      const env = {
        PATH: `${NodePath.join(dir, "bin")}:${process.env.PATH}`,
        // Past the PATH wrapper (runnerExec's tests cover it), to the command it runs.
        T3CODE_REMOTO: script(dir, "remoto", `[ "$4" = t3 ] && shift 4\n${remotoBody}`),
        T3CODE_RUNNER_SSH: script(
          dir,
          "ssh",
          `case "$*" in *loadavg*) printf '0.5 0.4 0.3 1/2 3\\n6\\nMem: 100 10 20 0 0 80\\n';; *) echo gone;; esac`,
        ),
      };
      return { dir, env };
    };
    // From inside the fake checkout: run from a copy without .git, the work stays on the Mac.
    const heavyHere = (
      dir: string,
      program: ReadonlyArray<string>,
      env: NodeJS.ProcessEnv = {},
      options: ReadonlyArray<string> = ["--"],
      cwd = dir,
    ) => heavy(dir, program, env, options, cwd);
    const onMac = [process.execPath, "-e", "console.log('ran on mac')"];

    it("passes the command's output and exit code through, without the markers", async () => {
      const { dir, env } = setup(
        [
          `printf '${M} phase=syncing id=app-1\\n${M} phase=running pgid=4\\n' >&2`,
          "echo remote-out",
          `printf '${M} exit=3\\n' >&2`,
          "exit 3",
        ].join("\n"),
      );
      const run = heavyHere(dir, ["vp", "test", "run"], env, ["--runner", "linux", "--"]);
      expect(await run.exited).toBe(3);
      expect(run.stdout()).toBe("remote-out\n");
      expect(run.stderr()).not.toContain("remoto phase");
      expect(Queue.read(dir)).toEqual([]);
    });

    // A heartbeat's own failure is only logged: it never takes the agent's command down with it.
    it("a stop of a lost run that throws leaves the waiting command running", async () => {
      const { dir, env } = setup(
        [
          `printf '${M} phase=running pgid=4\\n' >&2`,
          "echo remote-out",
          `printf '${M} exit=0\\n' >&2`,
        ].join("\n"),
      );
      const path = NodePath.join(dir, "queue.json");
      const doc = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;
      // An id the stop script refuses, from another folder so it holds nothing back here.
      const lost = { key: "k", entryId: "gone", cwd: tempDir(), remote: { id: "bad id", pgid: 7 } };
      NodeFS.writeFileSync(path, JSON.stringify({ ...doc, lostRuns: [lost] }));
      const run = heavyHere(dir, ["vp", "test", "run"], env, ["--runner", "linux", "--"]);
      expect(await run.exited).toBe(0);
      expect(run.stdout()).toBe("remote-out\n");
      expect(run.stderr()).toContain("[t3 heavy] Linux check failed: Error: Unsafe run id: bad id");
    });

    it("an agent's own remoto call runs once on Linux, from its cd folder", async () => {
      const { dir, env } = setup(
        [
          `printf '${M} phase=running pgid=4\\n' >&2`,
          `printf '%s|' "$@"; echo " in $(pwd -P)"`,
          `printf '${M} exit=0\\n' >&2`,
        ].join("\n"),
      );
      const sub = NodePath.join(dir, "sub");
      NodeFS.mkdirSync(sub);
      const wrapped = heavyHere(dir, ["/bin/sh", "-c", `cd ${sub} && remoto vp test run`], env);
      expect(await wrapped.exited).toBe(0);
      expect(wrapped.stdout()).toBe(`vp|test|run| in ${NodeFS.realpathSync(sub)}\n`);
      const bare = heavyHere(dir, ["remoto", "vp", "test", "run"], env);
      expect(await bare.exited).toBe(0);
      expect(bare.stdout()).toMatch(/^vp\|test\|run\| in /);
      // An absolute cd and a pipe: Linux gets the argv alone, the grep reads it here.
      const piped = heavyHere(
        dir,
        ["/bin/sh", "-c", `cd ${sub} && remoto vp test run a.test.ts 2>&1 | grep -E 'vp|zz'`],
        env,
      );
      expect(await piped.exited).toBe(0);
      expect(piped.stdout()).toBe(`vp|test|run|a.test.ts| in ${NodeFS.realpathSync(sub)}\n`);
    });

    const echoArgs = [
      `printf '${M} phase=running pgid=4\\n' >&2`,
      `printf '%s|' "$@"; echo " in $(pwd -P)"`,
      `printf '${M} exit=0\\n' >&2`,
    ].join("\n");

    it("a cd into another checkout runs on Linux from that folder, not the session's", async () => {
      const { dir, env } = setup(echoArgs);
      const session = NodePath.join(dir, "session-repo");
      const web = NodePath.join(dir, "t3-runner-ui", "apps", "web");
      NodeFS.mkdirSync(session);
      NodeFS.mkdirSync(web, { recursive: true });
      const line = `cd ${web} && vp test run src/x.browser.test.tsx`;
      const run = heavyHere(dir, ["/bin/sh", "-c", line], env, ["--"], session);
      expect(await run.exited).toBe(0);
      expect(run.stdout()).toBe(
        `vp|test|run|src/x.browser.test.tsx| in ${NodeFS.realpathSync(web)}\n`,
      );
    });

    it.each([
      // A cd in the line, before or after a chained step, even with a pipe after the work.
      [
        (o: string, t: string) => `cd ${o} && ${t} && cd apps/server && vp test run x.test.ts`,
        "vp|test|run|x.test.ts|",
        "apps/server",
      ],
      [
        (o: string, t: string) => `${t} && cd ${o}/apps/server && vp test run x.test.ts`,
        "vp|test|run|x.test.ts|",
        "apps/server",
      ],
      [
        (o: string, t: string) =>
          `cd ${o}/apps/server && ${t} && vp test run x.test.ts 2>&1 | grep -E 'vp|zz'`,
        "vp|test|run|x.test.ts|",
        "apps/server",
      ],
      // A folder flag, or a `sh -c` text's leading `cd`, in another checkout (a worktree here).
      [
        (o: string, t: string) => `${t} && pnpm -C ${o}/apps/server exec vp test run x.test.ts`,
        "pnpm|-C|.|exec|vp|test|run|x.test.ts|",
        "apps/server",
      ],
      [
        (o: string, t: string) => `${t} && pnpm --dir=${o} exec vp test run x.test.ts`,
        "pnpm|--dir=.|exec|vp|test|run|x.test.ts|",
        "",
      ],
      [
        (o: string, t: string) =>
          `${t} && O=${o}; sh -c "cd $O/apps/server && vp test run x.test.ts"`,
        "bash|-c|vp test run x.test.ts|",
        "apps/server",
      ],
      [
        (_: string, t: string) => `${t} && sh -c 'cd ~/other/apps/server && vp test run x.test.ts'`,
        "bash|-c|vp test run x.test.ts|",
        "apps/server",
      ],
    ])(
      "a part naming a folder in another checkout runs on Linux from there",
      async (line, argv, sub) => {
        const { dir, env } = setup(
          [
            `printf '${M} phase=running pgid=4\\n' >&2`,
            `printf '%s|' "$@"; [ -e made ] && echo " in $(pwd -P) after made" || echo " in $(pwd -P)"`,
            `printf '${M} exit=0\\n' >&2`,
          ].join("\n"),
        );
        const home = tempDir();
        const other = NodePath.join(home, "other");
        const folder = NodePath.join(other, sub);
        NodeFS.mkdirSync(NodePath.join(other, "apps", "server"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(other, ".git"),
          `gitdir: ${home}/main/.git/worktrees/other\n`,
        );
        // The step chained before it runs here first, in that folder.
        const full = line(other, `touch ${NodePath.join(folder, "made")}`);
        const run = heavyHere(dir, ["/bin/sh", "-c", full], { ...env, HOME: home });
        expect(await run.exited).toBe(0);
        expect(run.stdout()).toBe(`${argv} in ${NodeFS.realpathSync(folder)} after made\n`);
      },
    );

    it.each([
      // Two unrelated checkouts: neither copy has both, which the queue sees before Linux.
      [
        (o: string, x: string) => `pnpm -C ${o} exec vp test run ${x}/a.test.ts`,
        "pnpm on mac: -C",
        "",
      ],
      // Expanded, the text's folder is in no checkout: Linux would not have it.
      [
        (_: string, x: string) => `D=${x}; sh -c "cd $D && vp test run"`,
        "vp on mac: test run",
        "Runs outside a git checkout",
      ],
    ])("keeps %# on this Mac when Linux can't have all its folders", async (line, ran, why) => {
      const { dir, env } = setup(echoArgs);
      script(NodePath.join(dir, "bin"), "pnpm", 'echo "pnpm on mac: $*"');
      const other = tempDir();
      NodeFS.mkdirSync(NodePath.join(other, ".git"));
      const run = heavyHere(dir, ["/bin/sh", "-c", line(other, tempDir())], env);
      expect(await run.exited).toBe(0);
      expect(run.stdout()).toContain(ran);
      expect(run.stderr()).toContain(why);
    });

    it("finds the copy from the folder as remoto sees it, past a link inside the checkout", async () => {
      const { dir, env } = setup("");
      const other = tempDir();
      NodeFS.mkdirSync(NodePath.join(other, ".git"));
      NodeFS.mkdirSync(NodePath.join(other, "apps", "server"), { recursive: true });
      NodeFS.symlinkSync(NodePath.join(other, "apps", "server"), NodePath.join(other, "link"));
      // Stands in for `remoto-rodar`, which runs the wrapper in the folder `pwd -P` names.
      const remoto = script(
        dir,
        "remoto-rodar",
        [
          `printf '${M} phase=running pgid=4\\n' >&2`,
          'cd "$(pwd -P)" && "$@" | sed "s/^/linux: /"; code=$?',
          `printf '${M} exit=%s\\n' "$code" >&2`,
          'exit "$code"',
        ].join("\n"),
      );
      const line = `O=${other}; sh -c "cd $O/link && vp test run $O/x.test.ts"`;
      const run = heavyHere(dir, ["/bin/sh", "-c", line], { ...env, T3CODE_REMOTO: remoto });
      expect(await run.exited).toBe(0);
      expect(run.stdout()).toBe(
        `linux: vp on mac: test run ${NodeFS.realpathSync(other)}/x.test.ts\n`,
      );
    });

    it("sends only the work to Linux: its log stays here, free of markers", async () => {
      const { dir, env } = setup(echoArgs);
      const log = NodePath.join(dir, "out.log");
      const line = `L=${log}; vp test run src/a.test.ts > $L 2>&1; echo "log: $(cat $L)"`;
      const run = heavyHere(dir, ["/bin/sh", "-c", line], env, ["--"], dir);
      expect(await run.exited).toBe(0);
      expect(run.stdout()).toBe(`log: vp|test|run|src/a.test.ts| in ${NodeFS.realpathSync(dir)}\n`);
      expect(run.stderr()).toContain("Linux: running");
    });

    it("runs the line here when its expanded command turns out to need this Mac", async () => {
      const { dir, env } = setup(echoArgs);
      const line = "F=$(echo /etc/hosts); vp test run $F";
      const run = heavyHere(dir, ["/bin/sh", "-c", line], env, ["--"], dir);
      expect(await run.exited).toBe(0);
      expect(run.stdout()).toBe("vp on mac: test run /etc/hosts\n");
      expect(run.stderr()).toContain(
        "Uses a file outside the project: /etc/hosts; running the line on this Mac",
      );
    });

    it.each([
      ["F=--changed; vp test run $F", "test run --changed"],
      // A check:changed that doesn't read the inputs this Mac would hand it.
      ["vp run check:changed", "run check:changed"],
    ])("runs %j here when its expanded command turns out to need git", async (line, ran) => {
      const { dir, env } = setup(echoArgs);
      const run = heavyHere(dir, ["/bin/sh", "-c", line], env, ["--"], dir);
      expect(await run.exited).toBe(0);
      expect(run.stdout()).toBe(`vp on mac: ${ran}\n`);
      expect(run.stderr()).toContain(`${NEEDS_GIT}; running the line on this Mac`);
    });

    /** The faults the job logged for the problem detector, without the per-run fields. */
    const faults = (dir: string) =>
      Queue.readDoc(dir).events.flatMap((event) =>
        event.kind === "t3-fault"
          ? [{ reason: event.reason, cause: event.cause, command: event.command }]
          : [],
      );

    it("keeps a job on the Mac when Linux's pre-flight finds its tool missing", async () => {
      const { dir, env } = setup(
        `printf '${M} phase=running pgid=4\\n${M} missing=vp\\n${M} exit=127\\n' >&2; exit 127`,
        { runnerDropped: "mac" },
      );
      const run = heavyHere(dir, ["/bin/sh", "-c", "vp test run"], env, ["--"], dir);
      expect(await run.exited).toBe(0);
      expect(run.stdout()).toBe("vp on mac: test run\n");
      expect(run.stderr()).toContain("Not installed on Linux: vp; running the line on this Mac");
      expect(faults(dir)).toEqual([
        { reason: "command-not-found", cause: "command-not-found:vp", command: "vp test run" },
      ]);
    });

    it.each([1, 2, 3])(
      "returns a plain failure's exit %i unchanged, never rerunning it",
      async (code) => {
        const { dir, env } = setup(
          `printf '${M} phase=running pgid=4\\n${M} exit=${code}\\n' >&2; exit ${code}`,
          { runnerDropped: "mac", runnerUnavailable: "mac" },
        );
        const run = heavyHere(dir, ["/bin/sh", "-c", "vp test run"], env, ["--"], dir);
        expect(await run.exited).toBe(code);
        expect(run.stdout()).not.toContain("vp on mac");
      },
    );

    // A tool or file Linux lacks (126, 127) is its environment's: "If a Linux run fails" decides,
    // and Tell the agent hands back Linux's code and error without rerunning anywhere.
    // Silent too: a 127 with no error line still names the cause and follows the policy.
    it.each([
      [127, "agent", 127, "", "sh: 1: tsgo: not found"],
      [126, "agent", 126, "", "sh: 1: tsgo: not found"],
      // The whole line runs again here; under Tell the agent nothing after the failure runs.
      [127, "mac", 0, "vp on mac: test run\nafter\n", "sh: 1: tsgo: not found"],
      [127, "agent", 127, "", ""],
      [126, "mac", 0, "vp on mac: test run\nafter\n", ""],
    ] as const)("exit %i, %s: ends %i (%j)", async (code, policy, exit, stdout, error) => {
      const { dir, env } = setup(
        `printf '${M} phase=running pgid=4\\n' >&2; ${error === "" ? "" : `echo '${error}' >&2; `}printf '${M} exit=${code}\\n' >&2; exit ${code}`,
        { runnerDropped: policy },
      );
      const run = heavyHere(dir, ["/bin/sh", "-c", "vp test run; echo after"], env, ["--"], dir);
      expect(await run.exited).toBe(exit);
      expect(run.stdout()).toBe(stdout);
      const why =
        error !== ""
          ? error
          : `A command ${code === 127 ? "Linux doesn't have" : "Linux can't run"} (exit ${code})`;
      expect(run.stderr()).toContain(`[t3 heavy] Linux couldn't run this: ${why}\n`);
      expect(Queue.read(dir)).toEqual([]);
    });

    // A lazy install that raced in a fresh copy is Linux's failure: once more there, never the Mac.
    it.each([
      ["output", 1, "mac", 0, 2, "linux-ok\n"],
      ["output", 2, "mac", 0, 2, "vp on mac: test run\n"],
      ["marker", 1, "mac", 0, 2, "linux-ok\n"],
      ["marker", 2, "mac", 0, 2, "vp on mac: test run\n"],
      ["output", 2, "agent", 75, 2, ""],
    ] as const)(
      "an install failure seen in the %s %i time(s), %s, ends %i after %i Linux runs",
      async (seen, fails, policy, code, runs, output) => {
        const failure =
          seen === "output"
            ? "echo 'Error: Electron failed to install correctly.' >&2"
            : `printf '${M} install=electron\\n' >&2`;
        const { dir, env } = setup(
          [
            `n=$(($(cat "$0.count" 2>/dev/null || echo 0) + 1)); echo $n > "$0.count"`,
            `printf '${M} phase=running pgid=4\\n' >&2`,
            `if [ $n -le ${fails} ]; then ${failure}; printf '${M} exit=1\\n' >&2; exit 1; fi`,
            "echo linux-ok",
            `printf '${M} exit=0\\n' >&2`,
          ].join("\n"),
          { runnerDropped: policy },
        );
        const run = heavyHere(dir, ["/bin/sh", "-c", "vp test run"], env, ["--"], dir);
        expect(await run.exited).toBe(code);
        expect(run.stdout()).toBe(output);
        expect(NodeFS.readFileSync(NodePath.join(dir, "remoto.count"), "utf8").trim()).toBe(
          `${runs}`,
        );
        expect(run.stderr()).toContain("Dependency install on Linux failed");
        expect(
          run.stderr().includes("Linux couldn't run this: Dependency install on Linux failed"),
        ).toBe(fails === 2);
        expect(faults(dir).map((fault) => fault.cause)).toEqual(
          fails === 2 ? ["linux-install:electron"] : [],
        );
      },
    );

    // Linux has no Mac home: `~`, `$HOME` and absolute paths into the checkout point at its copy.
    it.each([
      ["cd ~/W/sub && remoto sh -c 'vp test run'", "vp test run", "sub"],
      ["cd D/sub && remoto sh -c 'vp test run'", "vp test run", "sub"],
      ["remoto sh -c 'cd ~/W/sub && vp test run'", `cd "$T3_COPY"'/sub' && vp test run`, ""],
      ["remoto sh -c 'cd $HOME/W/sub && vp test run'", `cd "$T3_COPY"'/sub' && vp test run`, ""],
      ["remoto sh -c 'cd \"D/sub\" && vp test run'", `cd "$T3_COPY"'/sub' && vp test run`, ""],
      [
        "remoto sh -c 'cd D && vp test run --root=D/sub'",
        `cd "$T3_COPY" && vp test run '--root='"$T3_COPY"'/sub'`,
        "",
      ],
      [
        "sh -c 'cd ~/W/sub && vp test run > ~/W/out.txt'",
        `cd "$T3_COPY"'/sub' && vp test run > "$T3_COPY"'/out.txt'`,
        "",
      ],
      // Quoted, `~` is no home.
      ["remoto sh -c 'vp test run \"~/W\"'", `vp test run "~/W"`, ""],
    ])("%s runs on Linux in its copy", async (line, body, folder) => {
      const { dir: made, env } = setup(echoArgs);
      // ponytail: paths compare as written; one through a symlink into the checkout stays here.
      const dir = NodeFS.realpathSync(made);
      NodeFS.mkdirSync(NodePath.join(dir, "sub"));
      const real = (text: string) =>
        text
          .replaceAll(
            /(~|\$HOME)\/W(?=\/|"|'| |$)/g,
            (_, start: string) => `${start}/${NodePath.basename(dir)}`,
          )
          .replaceAll(/(?<=[ ="]|^)D(?=\/| |"|$)/g, dir);
      const run = heavyHere(
        dir,
        ["/bin/sh", "-c", real(line)],
        { ...env, HOME: NodePath.dirname(dir) },
        ["--runner", "linux", "--"],
        dir,
      );
      expect(await run.exited, run.stderr()).toBe(0);
      expect(run.stdout()).toBe(`bash|-c|${real(body)}| in ${NodePath.join(dir, folder)}\n`);
    });

    // Named literally or through a variable, the text goes: the file is not on Linux.
    it.each([
      (path: string) => `bash ${path} --fast`,
      (path: string) => `${path} --fast`,
      (path: string) => `S=${NodePath.dirname(path)}; $S/verify.sh --fast`,
    ])("sends a script outside the checkout to Linux as its text (%#)", async (line) => {
      const { dir, env } = setup(echoArgs);
      const path = NodePath.join(tempDir(), "verify.sh");
      NodeFS.writeFileSync(path, "#!/bin/sh\nvp test run\n", { mode: 0o755 });
      const run = heavyHere(dir, ["/bin/sh", "-c", line(path)], env, ["--"], dir);
      expect(await run.exited, run.stderr()).toBe(0);
      expect(run.stdout()).toBe(
        `bash|-c|#!/bin/sh\nvp test run\n|${path}|--fast| in ${NodeFS.realpathSync(dir)}\n`,
      );
    });

    // What only the shell knew is judged before it leaves: each of these would fail there.
    it.each([
      [
        "a script reading its own folder",
        '#!/bin/sh\ncd "$(dirname "$0")" && vp test run\n',
        (path: string) => `S=${NodePath.dirname(path)}; $S/verify.sh`,
        (path: string) =>
          `Reads its own folder, which Linux doesn't have: ${NodePath.dirname(path)}`,
      ],
      [
        "a program outside the checkout",
        "#!/usr/bin/env node\n",
        // Only the shell knows it: judged as it leaves.
        (path: string) => `S=$(echo ${NodePath.dirname(path)}); $S/vitest run`,
        (path: string) => `Uses a program outside the project: ${NodePath.dirname(path)}/vitest`,
      ],
    ])("keeps %s on this Mac", async (_, body, line, why) => {
      const { dir, env } = setup(echoArgs);
      const scratch = NodeFS.realpathSync(tempDir());
      const path = NodePath.join(scratch, "verify.sh");
      NodeFS.writeFileSync(NodePath.join(scratch, "vitest"), body, { mode: 0o755 });
      NodeFS.writeFileSync(path, body, { mode: 0o755 });
      const run = heavyHere(dir, ["/bin/sh", "-c", line(path)], env, ["--"], dir);
      await run.exited;
      expect(run.stdout()).not.toContain(" in ");
      expect(run.stderr()).toContain(`${why(path)}; running the line on this Mac`);
    });

    it("judges the whole line, not the label cut short for the row", async () => {
      const { dir, env } = setup(echoArgs);
      const line = `vp test run ${"a".repeat(200)} /etc/hosts`;
      const run = heavyHere(dir, ["/bin/sh", "-c", line], env, ["--runner", "linux", "--"], dir);
      expect(await run.exited).toBe(0);
      expect(run.stdout()).toMatch(/^vp on mac: test run a+ \/etc\/hosts\n$/);
    });

    /** Fails its first run with `first`, then runs as Linux would; `$0.count` counts the runs. */
    const failingOnce = (first: string) =>
      [
        `n=$(($(cat "$0.count" 2>/dev/null || echo 0) + 1)); echo $n > "$0.count"`,
        `if [ $n -eq 1 ]; then ${first}; fi`,
        `printf '${M} phase=running pgid=4\\n' >&2`,
        "echo on-linux",
        `printf '${M} exit=0\\n' >&2`,
      ].join("\n");
    const runs = (dir: string) =>
      NodeFS.readFileSync(NodePath.join(dir, "remoto.count"), "utf8").trim();

    // One lost link is Linux's to recover: the heartbeat it triggers gets through, so the job goes
    // back there by itself, never to the Mac, whatever the policy says.
    it.each([
      ["vp test run; echo after"],
      // `timeout` runs its command in a process group of its own.
      ["timeout 30 vp test run; echo after"],
    ])(
      "stops %j where Linux was unreachable and runs it there once the link is back",
      async (line) => {
        const { dir, env } = setup(failingOnce("exit 75"), { runnerUnavailable: "mac" });
        const run = heavyHere(dir, ["/bin/sh", "-c", line], env, ["--"], dir);
        expect(await run.exited).toBe(0);
        expect(run.stdout()).toBe("on-linux\nafter\n");
        expect(run.stderr()).toContain("Linux is unavailable");
        expect(runs(dir)).toBe("2");
      },
    );

    // 39: the project's own failure there is no lost link: the policy decides once, no retry loop.
    it("runs a job whose install fails on Linux here once, naming Linux's last line", async () => {
      const { dir, env } = setup(
        failingOnce(
          `printf '${M} phase=syncing id=app-1\\n${M} phase=installing\\n' >&2; echo 'help: Update your lockfile using "pnpm install --no-frozen-lockfile"' >&2; exit 1`,
        ),
        { runnerDropped: "mac" },
      );
      const run = heavyHere(dir, onMac, env, ["--runner", "linux", "--"]);
      expect(await run.exited).toBe(0);
      expect(run.stdout()).toBe("ran on mac\n");
      expect(run.stderr()).toContain(
        'Linux couldn\'t run this: Dependency install on Linux failed: help: Update your lockfile using "pnpm install --no-frozen-lockfile"',
      );
      expect(runs(dir)).toBe("1");
    });

    // 41: failing before it starts every time while heartbeats get through is the environment's.
    it("stops retrying a link that keeps failing while Linux answers, and follows the policy", async () => {
      const { dir, env } = setup(
        `n=$(($(cat "$0.count" 2>/dev/null || echo 0) + 1)); echo $n > "$0.count"\nprintf '${M} phase=syncing id=app-1\\n' >&2; echo 'rsync: connection unexpectedly closed' >&2; exit 255`,
        { runnerDropped: "mac" },
        { runnerSshTimeoutSeconds: 1 },
      );
      const run = heavyHere(dir, onMac, env, ["--runner", "linux", "--"]);
      expect(await run.exited).toBe(0);
      expect(run.stdout()).toBe("ran on mac\n");
      expect(run.stderr()).toContain(
        "Linux couldn't run this: Sync on Linux failed: rsync: connection unexpectedly closed",
      );
      expect(runs(dir)).toBe("3");
    });

    it("reruns a dropped job on Linux once it confirms it stopped and the link is back", async () => {
      const { dir, env } = setup(
        failingOnce(
          `printf '${M} phase=syncing id=app-1\\n${M} phase=running pgid=4\\n' >&2; exit 255`,
        ),
        { runnerDropped: "mac" },
      );
      const run = heavyHere(dir, onMac, env, ["--runner", "linux", "--"]);
      expect(await run.exited).toBe(0);
      expect(run.stdout()).toBe("on-linux\n");
      expect(runs(dir)).toBe("2");
    });

    it.each([true, false])("Bring results back %s copies what the job wrote there", async (on) => {
      const { dir, env } = setup(
        `printf '${M} phase=syncing id=app-1\\n${M} phase=running pgid=4\\n${M} exit=0\\n' >&2`,
        { runnerBringBack: on },
      );
      // Changed here after the run's sync began.
      const mine = NodePath.join(dir, "mine.txt");
      NodeFS.writeFileSync(mine, "mine");
      NodeFS.utimesSync(mine, 4e9, 4e9);
      const ssh = script(
        dir,
        "ssh-list",
        `case "$*" in *t3-start*) printf './out.txt\\n./mine.txt\\n';; *loadavg*) printf '0.5 0.4 0.3 1/2 3\\n6\\nMem: 100 10 20 0 0 80\\n';; *) echo gone;; esac`,
      );
      const rsync = script(
        dir,
        "rsync-fake",
        `for a; do case "$a" in --files-from=*) l="\${a#--files-from=}";; esac; done; eval "d=\\\${$#}"; while read -r f; do echo from-linux > "$d$f"; done < "$l"`,
      );
      const run = heavyHere(
        dir,
        ["/bin/sh", "-c", "vp test run"],
        { ...env, T3CODE_RUNNER_SSH: ssh, T3CODE_RUNNER_RSYNC: rsync },
        ["--"],
        dir,
      );
      expect(await run.exited).toBe(0);
      const out = NodePath.join(dir, "out.txt");
      expect(NodeFS.existsSync(out) ? NodeFS.readFileSync(out, "utf8") : null).toBe(
        on ? "from-linux\n" : null,
      );
      expect(NodeFS.readFileSync(mine, "utf8")).toBe("mine");
      expect(run.stderr().includes("Not copied back (changed on this Mac): mine.txt\n")).toBe(on);
    });

    // A PC that went away answers neither check: the agent hears before Linux can confirm.
    it.each([
      ["answers the stop check", "echo gone", ""],
      [
        "is gone",
        '[ -e "$DOWN" ] && exit 255; echo gone',
        ", and hasn't confirmed it stopped there",
      ],
    ] as const)(
      "Tell the agent hands back a run Linux dropped once Linux is offline and the PC %s, never running it here",
      async (_, stop, unconfirmed) => {
        const { dir, env } = setup(
          [
            `printf '${M} phase=syncing id=app-1\\n${M} phase=running pgid=4\\n' >&2`,
            `while [ ! -e "$0.drop" ]; do sleep 0.05; done; exit 255`,
          ].join("\n"),
          { runnerDropped: "agent", runnerUnavailable: "mac" },
        );
        // Heartbeats fail once the test takes Linux down.
        const down = NodePath.join(dir, "down");
        const ssh = script(
          dir,
          "ssh-down",
          `DOWN=${down}; case "$*" in *loadavg*) [ -e ${down} ] && exit 255; printf '0.5 0.4 0.3 1/2 3\\n6\\nMem: 100 10 20 0 0 80\\n';; *) ${stop};; esac`,
        );
        // A calm reading no real one replaces: a strained Mac would hold the job for Linux instead.
        Queue.recordSample(
          dir,
          { at: 4e12, busyCores: 0, cpuCount: 10, availableMemoryBytes: 30, totalMemoryBytes: 32 },
          null,
        );
        const run = heavyHere(
          dir,
          ["/bin/sh", "-c", "vp test run; echo after"],
          { ...env, T3CODE_RUNNER_SSH: ssh },
          ["--"],
          dir,
        );
        await run.until("err", "Linux: running");
        NodeFS.writeFileSync(down, "");
        const fail = { ok: false as const, error: "ssh: connect to host pc: Connection refused" };
        Queue.recordHealth(dir, fail, 1);
        Queue.recordHealth(dir, fail, 1_000_000);
        expect(Queue.readDoc(dir).linux.online).toBe(false);
        NodeFS.writeFileSync(`${env.T3CODE_REMOTO}.drop`, "");
        expect(await run.exited).toBe(75);
        expect(run.stdout()).toBe("");
        expect(run.stderr()).toContain(
          `[t3 heavy] Linux couldn't run this: Linux dropped it mid-run${unconfirmed}.\n`,
        );
        expect(Queue.read(dir)).toEqual([]);
      },
    );

    const longRun = `printf '${M} phase=syncing id=app-1\\n${M} phase=running pgid=4\\n' >&2; exec sleep 30`;

    it("Stop during a Linux run ends remoto, confirms Linux stopped, and leaves the queue", async () => {
      const { dir, env } = setup(longRun);
      const run = heavyHere(dir, onMac, env, ["--runner", "linux", "--"]);
      await run.until("err", "Linux: running");
      run.child.kill("SIGTERM");
      expect(await run.exited).toBe(143);
      expect(run.stderr()).not.toContain("may still be running");
      expect(Queue.read(dir)).toEqual([]);
    });

    it("a running Linux job the user moves stops there and runs again on the Mac", async () => {
      const { dir, env } = setup(longRun);
      const run = heavyHere(dir, onMac, env, ["--runner", "linux", "--"]);
      await run.until("err", "Linux: running");
      expect(Queue.route(dir, Queue.read(dir)[0]!.id, "mac")).toBe("ok");
      expect(await run.exited).toBe(0);
      expect(run.stderr()).toContain("moved by the user");
      expect(run.stdout()).toBe("ran on mac\n");
    });

    it("without remoto installed, Linux counts as unavailable", async () => {
      const { dir, env } = setup("exit 0", { runnerUnavailable: "mac" });
      const run = heavyHere(
        dir,
        onMac,
        { ...env, T3CODE_REMOTO: undefined, HOME: dir, PATH: "/usr/bin:/bin" },
        ["--runner", "linux", "--"],
      );
      expect(await run.exited).toBe(0);
      expect(run.stderr()).toContain("remoto is not installed");
      expect(run.stdout()).toBe("ran on mac\n");
    });
  });

  it.each([
    ["bare", ["remoto", "npm", "test"]],
    ["shell-wrapped", ["/bin/sh", "-c", "remoto npm test"]],
  ])(
    "with the Runner off, a %s remoto call runs as written and holds no slot",
    async (_, command) => {
      const dir = tempDir();
      const bin = NodePath.join(dir, "bin");
      NodeFS.mkdirSync(bin);
      NodeFS.writeFileSync(
        NodePath.join(bin, "remoto"),
        '#!/bin/sh\necho "remoto: $*"\ncat >/dev/null\n',
        {
          mode: 0o755,
        },
      );
      const run = heavy(dir, command, { PATH: `${bin}:${process.env.PATH}` });
      await run.until("out", "remoto: npm test");
      expect(Queue.read(dir)).toEqual([]);
      run.child.stdin.end();
      expect(await run.exited).toBe(0);
    },
  );

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
    // Linux runs a program by its name, so a Mac path to it never keeps the job here.
    expect(labelOf("/Users/me/.nvm/bin/node", ["--test"])).toBe("node --test");
    expect(selfPrefix("/q dir", { ELECTRON_RUN_AS_NODE: "1" })).toMatch(
      /^ELECTRON_RUN_AS_NODE=1 '.+' heavy --queue-dir '\/q dir'$/,
    );
    expect(selfPrefix("/q", {})).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  describe("an agent's own remoto call and a leading cd", () => {
    const SH = "/bin/zsh";
    const shapes = [
      ["bare remoto", ["remoto", "npm", "run", "test"], "/w", "npm", ["run", "test"], true],
      ["wrapped remoto", [SH, "-c", "remoto npm run test"], "/w", SH, ["-c", "npm run test"], true],
      [
        "remoto after cd",
        [SH, "-c", "cd apps/server && remoto vp test run"],
        "/w/apps/server",
        SH,
        ["-c", "vp test run"],
        true,
      ],
      [
        "remoto after cd ~",
        [SH, "-c", "cd ~/x && remoto vp test"],
        "/home/me/x",
        SH,
        ["-c", "vp test"],
        true,
      ],
      [
        "cd alone",
        [SH, "-c", "cd /abs/app && vp test run"],
        "/abs/app",
        SH,
        ["-c", "vp test run"],
        false,
      ],
      ["plain", ["vp", "test", "run"], "/w", "vp", ["test", "run"], false],
      ["bare remoto, no command", ["remoto"], "/w", "remoto", [], false],
    ] as const;
    const modes = [
      ["queue on, Runner on", true, true],
      ["queue on, Runner off", true, false],
      ["queue off, Runner on", false, true],
      ["queue off, Runner off", false, false],
    ] as const;

    it.each(
      shapes.flatMap((shape) => modes.map((mode) => [shape[0], mode[0], shape, mode] as const)),
    )("%s, %s", (_shape, _mode, [, command, cwd, program, args, remoto], [, enabled, runner]) => {
      const launch = heavyLaunch(
        { program: command[0], args: command.slice(1), where: undefined },
        "/w",
        "/home/me",
        () => ({ enabled, runner }),
        false,
      );
      // `remoto` never holds a Mac slot: Linux with the Runner on, run as written with it off.
      const direct = (!enabled && !runner) || (remoto && !runner);
      expect(launch).toEqual(
        direct
          ? { kind: "direct" }
          : { kind: "queue", cwd, program, args, where: remoto ? "linux" : undefined },
      );
    });

    it.each([
      ["vp", ["run", "dev"]],
      [SH, ["-c", "cd apps/web && vp run dev:desktop"]],
      ["npx", ["expo", "start"]],
      ["vp", ["test", "--watch"]],
    ])("row 14: %s %j keeps running, so it runs outside the queue", (program, args) => {
      const modeAt = () => ({ enabled: true, runner: true });
      expect(heavyLaunch({ program, args, where: undefined }, "/w", "/h", modeAt, false)).toEqual({
        kind: "direct",
        service: true,
      });
    });

    it("reads the Runner switch where the job runs, and runs direct inside a queue job", () => {
      const seen: string[] = [];
      const modeAt = (cwd: string) => (seen.push(cwd), { enabled: true, runner: true });
      const remoto = { program: SH, args: ["-c", "cd /p && remoto vp test"], where: undefined };
      heavyLaunch(remoto, "/w", "/h", modeAt, false);
      expect(seen).toEqual(["/p"]);
      expect(heavyLaunch(remoto, "/w", "/h", modeAt, true)).toEqual({ kind: "direct" });
      expect(heavyLaunch({ ...remoto, where: "mac" }, "/w", "/h", modeAt, false)).toMatchObject({
        where: "mac",
      });
    });

    it("runs a commit with no hook as written, and queues a hooked one first", () => {
      const parent = tempDir();
      const root = NodePath.join(parent, "repo");
      NodeFS.mkdirSync(root);
      NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: root });
      const modeAt = () => ({ enabled: true, runner: false });
      const line = { program: SH, args: ["-c", "cd repo && git commit -m x"], where: undefined };
      const direct = { program: "git", args: ["commit", "-m", "x"], where: undefined };
      expect(heavyLaunch(line, parent, "/h", modeAt, false)).toEqual({ kind: "direct" });
      expect(heavyLaunch(direct, root, "/h", modeAt, false)).toEqual({ kind: "direct" });
      NodeFS.writeFileSync(NodePath.join(root, ".git/hooks/pre-commit"), "exit 0", { mode: 0o755 });
      expect(heavyLaunch(line, parent, "/h", modeAt, false)).toMatchObject({
        kind: "queue",
        cwd: root,
        priority: "high",
      });
    });

    const config = {
      ...DEFAULT_PROJECT_CONFIG,
      runnerEnabled: true,
      // The list as 0.1.9-fork.1 saved it: no tsgo or effect-tsgo, only `typecheck` and `tsc`.
      runnerLinuxCommands: [
        "test",
        "vitest",
        "jest",
        "e2e",
        "playwright",
        "coverage",
        "lint",
        "oxlint",
        "eslint",
        "check",
        "typecheck",
        "tsc",
        "knip",
      ],
    };
    const CHECKOUTS = ["/w/repo", "/w/other", "/abs", "/a b", "/home/me/code"];
    const rootOf = (cwd: string) =>
      CHECKOUTS.find((root) => cwd === root || cwd.startsWith(`${root}/`)) ?? null;
    const COMMITS = "Commits run here: the pre-commit edits this Mac's repository";
    const OUTSIDE = "Uses a file outside the project: ";
    /** What the hook, the queue and a Linux attempt each make of an agent's Bash line. */
    const placed = (line: string) => {
      const hooked = queueBashCall(
        { tool_name: "Bash", tool_input: { command: line } },
        "Q",
        {},
        { runner: true },
      );
      if (hooked === null) return [isQueued(line) ? "queued" : "light"];
      const job = jobOf(SH, ["-c", line], "/w/repo", "/home/me");
      const { reason } = eligibilityOf(
        {
          label: labelOf(job.program, job.args),
          line: job.args[1]!,
          cwd: job.cwd,
          ...(job.remoto ? { where: "linux" as const } : {}),
        },
        { config, home: "/home/me", rootOf },
      );
      if (reason !== null) return [reason];
      const run = linuxLine(job.program, job.args, "X").args[1];
      return job.cwd === "/w/repo" ? ["linux", run] : ["linux", run, job.cwd];
    };
    const PINNED =
      "A='/Applications/T3 Code (Beta).app/Contents'; ELECTRON_RUN_AS_NODE=1 \"$A/MacOS/T3 Code (Beta)\" " +
      '"$A/Resources/app.asar/apps/server/dist/bin.mjs" heavy --queue-dir /q --runner mac --name x ' +
      "-- sh -c 'cd /w/repo && vp test run > /private/tmp/x.log'";

    it.each([
      // Folders: a leading `cd` is where the job starts; any other is followed to its part.
      ["vp test run", "linux", "X vp test run"],
      ["cd /abs/app && vp test run", "linux", "X vp test run", "/abs/app"],
      ["cd apps/web && vp test run", "linux", "X vp test run", "/w/repo/apps/web"],
      ["cd ../other && vp test run", "linux", "X vp test run", "/w/other"],
      ['cd "/a b/c" && vp test run', "linux", "X vp test run", "/a b/c"],
      ["cd ~/code&&vp test run", "linux", "X vp test run", "/home/me/code"],
      ["cd /abs && cd apps/web && vp test run", "linux", "X vp test run", "/abs/apps/web"],
      ["  cd . && vp test run -t 'a b'", "linux", "X vp test run -t 'a b'"],
      ["cd /abs; vp test run", "linux", "cd /abs; X vp test run"],
      [
        "(cd apps/web && vp test run) | tail -5",
        "linux",
        "(cd apps/web && X vp test run) | tail -5",
      ],
      // What only the shell knows passes here; `linux-part` checks it expanded.
      ["cd $DIR && vp test run", "linux", "cd $DIR && X vp test run"],
      [
        "FILES=$(git diff --name-only); vp test run $FILES",
        "linux",
        "FILES=$(git diff --name-only); X vp test run $FILES",
      ],
      ["for f in a b; do vp test run $f; done", "linux", "for f in a b; do X vp test run $f; done"],
      // Plumbing stays here: redirects, pipes, `;`, assignments, light commands.
      [
        "L=/private/tmp/x.log; effect-tsgo tsrs --noEmit > $L 2>&1; tail -5 $L",
        "linux",
        "L=/private/tmp/x.log; X effect-tsgo tsrs --noEmit > $L 2>&1; tail -5 $L",
      ],
      [
        "cd /w/repo/apps/server && L=/private/tmp/x.log; effect-tsgo tsrs --noEmit > $L 2>&1; tail -5 $L",
        "linux",
        "L=/private/tmp/x.log; X effect-tsgo tsrs --noEmit > $L 2>&1; tail -5 $L",
        "/w/repo/apps/server",
      ],
      [
        "vp test run a.test.ts > /private/tmp/out.log",
        "linux",
        "X vp test run a.test.ts > /private/tmp/out.log",
      ],
      ["vp test run 2>&1 | tail -20", "linux", "X vp test run 2>&1 | tail -20"],
      ["vp run lint; vp test run", "linux", "X vp run lint; X vp test run"],
      ["vp test run && git push", "linux", "X vp test run && git push"],
      [
        'grep -v "t3 heavy" log.txt && vp test run',
        "linux",
        'grep -v "t3 heavy" log.txt && X vp test run',
      ],
      [
        "python3 - <<'EOF'\nprint('vp test run')\nEOF\nvp test run",
        "linux",
        "python3 - <<'EOF'\nprint('vp test run')\nEOF\nX vp test run",
      ],
      ["t3 heavy -- vp lint && vp test run", "linux", "t3 heavy -- vp lint && X vp test run"],
      // Assignments travel as `env`; local prefixes wrap the executor.
      ["VITEST_MAX_WORKERS=2 vp test run", "linux", "X env VITEST_MAX_WORKERS=2 vp test run"],
      [
        'NODE_OPTIONS="--max-old-space-size=4096" vp run typecheck',
        "linux",
        'X env NODE_OPTIONS="--max-old-space-size=4096" vp run typecheck',
      ],
      ["time vp test run", "linux", "time X vp test run"],
      ["vp test run < /dev/null", "linux", "X vp test run < /dev/null"],
      ["timeout 110 vp test run", "linux", "X timeout 110 vp test run"],
      // Wrappers run there as written.
      ["npx vitest run", "linux", "X npx vitest run"],
      ["pnpm exec playwright test", "linux", "X pnpm exec playwright test"],
      ["pnpm dlx vitest run", "linux", "X pnpm dlx vitest run"],
      ["npm exec vitest", "linux", "X npm exec vitest"],
      ["yarn test", "linux", "X yarn test"],
      ["bunx tsc --noEmit", "linux", "X bunx tsc --noEmit"],
      ["vp run typecheck", "linux", "X vp run typecheck"],
      // A list naming `typecheck` or `tsc` covers every type checker.
      ["pnpm exec effect-tsgo tsrs --noEmit", "linux", "X pnpm exec effect-tsgo tsrs --noEmit"],
      [
        "cd apps/server && pnpm exec effect-tsgo tsrs --noEmit",
        "linux",
        "X pnpm exec effect-tsgo tsrs --noEmit",
        "/w/repo/apps/server",
      ],
      ["npx vue-tsc --noEmit", "linux", "X npx vue-tsc --noEmit"],
      // An agent's own `remoto` asks for Linux; T3 takes its word out and decides.
      ["remoto vp test run", "linux", "X vp test run"],
      ["cd apps/server && remoto vp test run", "linux", "X vp test run", "/w/repo/apps/server"],
      // Only the work goes there: the cd, pipe and redirect stay on this Mac.
      [
        "cd /w/repo/apps/web && remoto pnpm exec vp test run a.test.ts 2>&1 | grep -E 'x|y'",
        "linux",
        "X pnpm exec vp test run a.test.ts 2>&1 | grep -E 'x|y'",
        "/w/repo/apps/web",
      ],
      ["cd apps/server && remoto vp run build", "linux", "X vp run build", "/w/repo/apps/server"],
      ["ls && remoto vp test run", "linux", "ls && X vp test run"],
      // Paths inside a checkout translate there; outside it, the part stays.
      ["vp test run /w/repo/src/a.test.ts", "linux", "X vp test run /w/repo/src/a.test.ts"],
      ["vp test run /Users/me/x/a.test.ts", `${OUTSIDE}/Users/me/x/a.test.ts`],
      ["vp test run --config ~/vitest.config.ts", `${OUTSIDE}/home/me/vitest.config.ts`],
      ["vp test run --outputFile=/private/tmp/r.json", `${OUTSIDE}/private/tmp/r.json`],
      // A `sh -c` text runs there whole, in the copy of the checkout it starts in.
      ["sh -c 'vp test run'", "linux", "X sh -c 'vp test run'"],
      [
        "remoto sh -c 'cd /w/repo/apps/server && vp test run'",
        "linux",
        "X sh -c 'cd /w/repo/apps/server && vp test run'",
      ],
      ["remoto sh -c 'cd ~/code && vp test run'", "linux", "X sh -c 'cd ~/code && vp test run'"],
      ["sh -c 'vp test run /w/other/a.test.ts'", `${OUTSIDE}/w/other/a.test.ts`],
      ["sh -c 'echo a | vp test run'", "Reads its input from this Mac: vp test run"],
      ["L=/private/tmp/r.json; vp test run --outputFile=$L", `${OUTSIDE}/private/tmp/r.json`],
      ["vp test run ../../elsewhere/a.test.ts", `${OUTSIDE}/elsewhere/a.test.ts`],
      ["cd /nowhere && vp test run", "Runs outside a git checkout: /nowhere"],
      // A part naming a folder in another checkout runs from that one; `linux-part` moves it.
      [
        "cd /w/other && git checkout --ours a && cd apps/server && pnpm exec vp test run a.test.ts",
        "linux",
        "git checkout --ours a && cd apps/server && X pnpm exec vp test run a.test.ts",
        "/w/other",
      ],
      [
        "git -C /w/other checkout --ours a && cd /w/other/apps/server && vp test run",
        "linux",
        "git -C /w/other checkout --ours a && cd /w/other/apps/server && X vp test run",
      ],
      [
        "pnpm -C /w/other/apps/server exec vp test run",
        "linux",
        "X pnpm -C /w/other/apps/server exec vp test run",
      ],
      ["pnpm --dir=/w/other exec vp test run", "linux", "X pnpm --dir=/w/other exec vp test run"],
      ["pnpm -C ~/code exec vp test run", "linux", "X pnpm -C ~/code exec vp test run"],
      [
        "pnpm -C /w/repo/apps/web exec vp test run",
        "linux",
        "X pnpm -C /w/repo/apps/web exec vp test run",
      ],
      ["pnpm -C /w/other exec vp test run /abs/a.test.ts", `${OUTSIDE}/abs/a.test.ts`],
      ["sh -c 'cd /w/other && vp test run'", "linux", "X sh -c 'cd /w/other && vp test run'"],
      ["sh -c 'cd /w/other && vp test run /abs/a.test.ts'", `${OUTSIDE}/abs/a.test.ts`],
      ["sh -c 'cd /nowhere && vp test run'", "Runs outside a git checkout: /nowhere"],
      // Linux has no git: a git step inside a text it runs whole keeps the text here.
      ["sh -c 'cd /w/other && git checkout --ours a && vp test run'", NEEDS_GIT],
      ["sh -c 'git stash && vp test run'", NEEDS_GIT],
      // The rest of what keeps work here, each with its reason.
      ["git commit -m 'fix: t3 heavy'", COMMITS],
      ['git add a && git commit -m "x" && vp test run', COMMITS],
      ["vp run build", "Not on the Can run on Linux list: vp run build"],
      ["xcodebuild -scheme App test", "Always on this Mac: xcodebuild"],
      // It keeps running: load on this Mac, never a queue job.
      ["vp run dev:desktop", "light"],
      ["vp test run <<EOF\nx\nEOF", "Reads its input from this Mac: vp test run"],
      ["vp test run <<< x", "Reads its input from this Mac: vp test run"],
      // The redirect stays here and Linux gets no input; inside a text it runs there, read as a path.
      ["vp test run < a.ts", "Reads its input from this Mac: vp test run"],
      ["vp test run < /dev/null", "linux", "X vp test run < /dev/null"],
      ["sh -c 'vp test run < a.ts'", "linux", "X sh -c 'vp test run < a.ts'"],
      ["sh -c 'vp test run < /private/tmp/a.ts'", `${OUTSIDE}/private/tmp/a.ts`],
      // The incident: the `diff` the text pipes into runs there with it.
      [
        `remoto bash -c 'files=(a.ts); for f in "\${files[@]}"; do vp fmt --stdin-filepath="$f" < "$f" | diff -q - "$f"; done'`,
        "linux",
        `X bash -c 'files=(a.ts); for f in "\${files[@]}"; do vp fmt --stdin-filepath="$f" < "$f" | diff -q - "$f"; done'`,
      ],
      ["echo a | vp test run", "Reads its input from this Mac: vp test run"],
      ["vp test run a & vp test run b & wait", "Runs in the background: vp test run"],
      ["eval vp test run", "Couldn't read this command safely (eval)"],
      ["vp test run 'unbalanced", "Couldn't read this command safely (unbalanced quotes)"],
      ["vp test run <<EOF\nnever ends", "Couldn't read this command safely (unterminated heredoc)"],
      ["nohup sh -c 'vp test run > /tmp/x.log 2>&1' &", "Runs in the background: sh vp test"],
      // Not heavy, or already queued: the hook leaves these alone.
      ['grep "a\\|vitest" src/x.ts', "light"],
      ["rg 'vp test run' docs", "light"],
      ["git commit -n -m wip", "light"],
      ["echo remoto && ls", "light"],
      ["t3 heavy -- vp test run", "queued"],
      ["ELECTRON_RUN_AS_NODE=1 '/app/t3' heavy --queue-dir '/q' -- vp test run", "queued"],
      [PINNED, "queued"],
    ])("%j: %s", (line, ...expected) => {
      expect(placed(line)).toEqual(expected);
    });

    it("runs the plumbing here and only the work through the executor", () => {
      const dir = tempDir();
      NodeFS.writeFileSync(
        NodePath.join(dir, "t3-remote"),
        '#!/bin/sh\necho "remote: $*"\necho remote-err >&2\n',
        { mode: 0o755 },
      );
      const log = NodePath.join(dir, "x.log");
      const line = `L=${log}; effect-tsgo tsrs --noEmit > $L 2>&1; echo "lines: $(wc -l < $L | tr -d ' ')"; tail -5 $L`;
      const { shell, args } = linuxLine("/bin/sh", ["-c", line], "t3-remote");
      const out = NodeChildProcess.execFileSync(shell, args, {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        encoding: "utf8",
      });
      expect(out).toBe("lines: 2\nremote: effect-tsgo tsrs --noEmit\nremote-err\n");
      // A program run without a shell becomes a line of its quoted words.
      expect(linuxLine("vp", ["test", "it's"], "X")).toEqual({
        shell: "/bin/sh",
        args: ["-c", `X 'vp' 'test' 'it'\\''s'`],
      });
    });

    it("leaves a program that is not a shell line as it is", () => {
      expect(jobOf("zsh", ["script.sh"], "/w", "/h")).toEqual({
        cwd: "/w",
        program: "zsh",
        args: ["script.sh"],
        remoto: false,
      });
    });
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
      expected: ["--test-concurrency=4", "--test", "a.js"],
    },
    {
      program: "node",
      args: ["--test", "--test-concurrency=1"],
      expected: ["--test", "--test-concurrency=1"],
    },
    { program: "node", args: ["a.js"], expected: ["a.js"] },
    { program: "playwright", args: ["test"], expected: ["test", "--workers=4"] },
    { program: "playwright", args: ["test", "--workers=1"], expected: ["test", "--workers=1"] },
    { program: "playwright", args: ["test", "-j2"], expected: ["test", "-j2"] },
    { program: "playwright", args: ["install"], expected: ["install"] },
    {
      program: "./gradlew",
      args: ["assembleRelease"],
      expected: ["--max-workers=4", "assembleRelease"],
    },
    {
      program: "gradle",
      args: ["build", "--max-workers", "2"],
      expected: ["build", "--max-workers", "2"],
    },
    {
      program: "gradlew",
      args: ["build", "-Dorg.gradle.workers.max=2"],
      expected: ["build", "-Dorg.gradle.workers.max=2"],
    },
    { program: "xcodebuild", args: ["-scheme", "App"], expected: ["-jobs", "4", "-scheme", "App"] },
    { program: "xcodebuild", args: ["-jobs", "2"], expected: ["-jobs", "2"] },
    { program: "swift", args: ["build"], expected: ["build", "-j", "4"] },
    {
      program: "swift",
      args: ["run", "app", "--", "-x"],
      expected: ["run", "-j", "4", "app", "--", "-x"],
    },
    { program: "swift", args: ["test", "--jobs=2"], expected: ["test", "--jobs=2"] },
    { program: "swift", args: ["package", "resolve"], expected: ["package", "resolve"] },
    { program: "cargo", args: ["test", "--", "-j", "9"], expected: ["test", "--", "-j", "9"] },
    { program: "make", args: ["all"], expected: ["all"] },
    // Shell lines: each tool in the line gets its flag; one that already sets a count keeps it.
    {
      program: "/bin/zsh",
      args: ["-c", "cd android && ./gradlew assembleRelease | tail -5"],
      expected: ["-c", "cd android && ./gradlew --max-workers=4 assembleRelease | tail -5"],
    },
    {
      program: "bash",
      args: ["-c", "swift build -c release && xcodebuild -jobs 2 test"],
      expected: ["-c", "swift build -j 4 -c release && xcodebuild -jobs 2 test"],
    },
    {
      program: "zsh",
      args: ["-c", "FOO=1 node --test a.js; playwright test --workers=1"],
      expected: ["-c", "FOO=1 node --test-concurrency=4 --test a.js; playwright test --workers=1"],
    },
    { program: "zsh", args: ["-c", "vp test run"], expected: ["-c", "vp test run"] },
    // The cap is a ceiling: a lower count the project or user config sets wins, a higher one is capped.
    {
      program: "./gradlew",
      args: ["assembleRelease"],
      files: {
        "/repo/app/gradle.properties": "org.gradle.jvmargs=-Xmx2g\norg.gradle.workers.max=2\n",
      },
      expected: ["assembleRelease"],
    },
    {
      program: "gradle",
      args: ["build"],
      files: {
        "/repo/settings.gradle.kts": "",
        "/repo/gradle.properties": "org.gradle.workers.max = 3",
      },
      expected: ["build"],
    },
    {
      program: "gradle",
      args: ["build"],
      environment: { HOME: "/home/me" },
      files: { "/home/me/.gradle/gradle.properties": "org.gradle.workers.max:2" },
      expected: ["build"],
    },
    {
      program: "zsh",
      args: ["-c", "cd android && ./gradlew assembleRelease"],
      environment: { JAVA_OPTS: "-Xmx1g -Dorg.gradle.workers.max=2" },
      expected: ["-c", "cd android && ./gradlew assembleRelease"],
    },
    {
      // Above the root project, and unparsable, values don't count; the user home's higher one is capped.
      program: "./gradlew",
      args: ["assembleRelease"],
      environment: { GRADLE_USER_HOME: "/gh", GRADLE_OPTS: "-Dorg.gradle.workers.max=8" },
      files: {
        "/repo/settings.gradle": "",
        "/gradle.properties": "org.gradle.workers.max=1",
        "/repo/app/gradle.properties": "org.gradle.workers.max=lots",
        "/gh/gradle.properties": "org.gradle.workers.max=16",
      },
      expected: ["--max-workers=4", "assembleRelease"],
    },
    {
      program: "cargo",
      args: ["build"],
      files: { "/repo/.cargo/config.toml": "[build]\njobs = 2 # laptop\n" },
      expected: ["build"],
      env: { CARGO_BUILD_JOBS: undefined },
    },
    {
      // Negative: all cores but that many.
      program: "cargo",
      args: ["build"],
      environment: { CARGO_HOME: "/ch" },
      files: { "/ch/config.toml": "build.jobs = -100000" },
      expected: ["build"],
      env: { CARGO_BUILD_JOBS: undefined },
    },
    {
      program: "cargo",
      args: ["build"],
      files: { "/repo/app/.cargo/config": '[term]\njobs = 1\n[build]\njobs = 32\ntarget = "x"' },
      expected: ["build"],
    },
    // CMake's level only reaches a generator that already runs in parallel.
    {
      program: "cmake",
      args: ["--build", "build"],
      files: { "/repo/app/build/CMakeCache.txt": "CMAKE_GENERATOR:INTERNAL=Unix Makefiles\n" },
      expected: ["--build", "build"],
    },
    { program: "cmake", args: ["--build", "out"], expected: ["--build", "out"] },
    {
      program: "zsh",
      args: ["-c", "cmake --build build -t app"],
      files: {
        "/repo/app/build/CMakeCache.txt":
          "CMAKE_CACHEFILE_DIR:INTERNAL=/x\nCMAKE_GENERATOR:INTERNAL=Ninja\n",
      },
      expected: ["-c", "cmake --build build -t app"],
      env: { CMAKE_BUILD_PARALLEL_LEVEL: "4" },
    },
  ])(
    "hands $program $args the admitted workers",
    ({ program, args, expected, files = {}, environment = {}, env = {} }) => {
      const read = (path: string) => (files as Record<string, string>)[path] ?? null;
      const run = withWorkers(
        program,
        args,
        4,
        { PATH: "/bin", ...environment },
        { cwd: "/repo/app", read },
      );
      expect(run.args).toEqual(expected);
      expect(run.env).toEqual({
        PATH: "/bin",
        ...environment,
        T3CODE_HEAVY_JOB: "1",
        T3_HEAVY_WORKERS: "4",
        VITEST_MAX_WORKERS: "4",
        CARGO_BUILD_JOBS: "4",
        ...env,
      });
    },
  );

  it("keeps worker counts the environment already sets", () => {
    const env = { VITEST_MAX_WORKERS: "1", CARGO_BUILD_JOBS: "2", CMAKE_BUILD_PARALLEL_LEVEL: "" };
    expect(
      withWorkers("cargo", ["build"], 4, env, { cwd: "/repo", read: () => null }).env,
    ).toMatchObject(env);
  });

  it("parses the queue dir and the separator", () => {
    expect(parseHeavyArgs(["--queue-dir", "/q", "--", "vp", "test"])).toEqual({
      dir: "/q",
      name: undefined,
      priority: undefined,
      now: false,
      program: "vp",
      args: ["test"],
    });
    expect(parseHeavyArgs(["--now", "--name", "Tests", "--now", "--", "vp"])).toMatchObject({
      now: true,
      name: "Tests",
      program: "vp",
    });
    expect(parseHeavyArgs(["--priority", "high", "--", "vp"]).priority).toBe("high");
    expect(parseHeavyArgs(["--priority", "urgent", "--", "vp"]).priority).toBeUndefined();
    expect(parseHeavyArgs(["--request-id", "toolu_1", "--", "vp"])).toMatchObject({
      requestId: "toolu_1",
      program: "vp",
    });
    expect(parseHeavyArgs(["--request-id", " ", "--", "vp"])).not.toHaveProperty("requestId");
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

  it("skips options another T3 version added instead of running one as the program", () => {
    // A hook from one T3 build hands its line to another build's CLI (`--request-id` once ran as a program).
    const rows: ReadonlyArray<ReadonlyArray<string>> = [
      ["--queue-dir", "/q", "--trace-id", "toolu_1", "--name", "Tests", "--", "vp", "test"],
      ["--queue-dir", "/q", "--trace", "--name", "Tests", "--", "vp", "test"],
      ["--queue-dir", "/q", "--name", "Tests", "--trace", "--", "vp", "test"],
      ["--trace-id", "toolu_1", "--queue-dir", "/q", "--name", "Tests", "--", "vp", "test"],
    ];
    for (const row of rows) {
      expect(parseHeavyArgs(row), row.join(" ")).toMatchObject({
        dir: "/q",
        name: "Tests",
        program: "vp",
        args: ["test"],
      });
    }
  });

  it("defaults a checkout's own T3 to that checkout's queue and an installed T3 to the machine's", () => {
    const root = tempDir();
    const worktree = NodePath.join(root, "worktree");
    const main = NodePath.join(root, "main");
    NodeFS.mkdirSync(worktree);
    NodeFS.writeFileSync(NodePath.join(worktree, ".git"), "gitdir: /repo/.git/worktrees/w\n");
    NodeFS.mkdirSync(NodePath.join(main, ".git"), { recursive: true });
    const live = NodePath.join(NodeOS.homedir(), ".t3", "heavy-queue");
    const worktreeSource = NodePath.join(worktree, "apps", "server", "src", "bin.ts");
    const rows: ReadonlyArray<[NodeJS.ProcessEnv, string | undefined, string]> = [
      [{}, worktreeSource, NodePath.join(worktree, ".t3", "heavy-queue-dev")],
      [{}, `${main}/apps/server/dist/bin.mjs`, NodePath.join(main, ".t3", "heavy-queue-dev")],
      [{ T3CODE_HEAVY_QUEUE_DIR: "/q" }, worktreeSource, "/q"],
      [{ T3CODE_HEAVY_QUEUE_DIR: " " }, worktreeSource, `${worktree}/.t3/heavy-queue-dev`],
      [{ T3CODE_HEAVY_QUEUE_DIR: "/q" }, undefined, "/q"],
      [{}, "/Applications/T3 Code.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs", live],
      [{}, `${main}/node_modules/t3/dist/bin.mjs`, live],
      [{}, `${main}/node_modules/vitest/vitest.mjs`, live],
      [{}, `${root}/unpacked/apps/server/dist/bin.mjs`, live],
      [{}, "/usr/local/bin/t3", live],
      [{}, undefined, live],
    ];
    for (const [environment, entry, dir] of rows) {
      expect(Queue.defaultQueueDir(environment, entry), entry).toBe(dir);
    }
  });
});
