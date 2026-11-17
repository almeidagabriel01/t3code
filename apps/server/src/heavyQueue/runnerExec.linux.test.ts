// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Against a real, disposable Linux over ssh: start one with `scripts/runner-linux-it.sh up`,
 * export what it prints, then run this file. Skipped without RUNNER_IT.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_MACHINE_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  nextHealth,
  UNKNOWN_HEALTH,
} from "./runner.ts";
import { checkLinux, startLinuxRun, stopRemote } from "./runnerExec.ts";

const enabled = process.env.RUNNER_IT === "1";
const container = process.env.RUNNER_IT_CONTAINER ?? "";
const host = process.env.RUNNER_IT_HOST ?? "";
const sshOpts = process.env.RUNNER_IT_SSH_OPTS ?? "";
const remoto =
  process.env.RUNNER_IT_REMOTO ?? NodePath.join(NodeOS.homedir(), "DEV/Pessoal/remoto/remoto");
const machine = { ...DEFAULT_MACHINE_CONFIG, runnerHost: host };
const environment = { ...process.env, REMOTO_SSH_OPTS: sshOpts };
/** The same host on a closed port: every connection is refused at once. */
const downEnvironment = { ...process.env, REMOTO_SSH_OPTS: `-p 1 ${sshOpts}` };

const docker = (...args: string[]) =>
  NodeChildProcess.execFileSync("docker", args, { encoding: "utf8" }).trim();
const onLinux = (command: string) =>
  docker("exec", "-u", "dev", container, "sh", "-c", `cd ~ && ${command}`);

/** A tiny git project, so `remoto` syncs a handful of files. */
const project = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runner-it-"));
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
  NodeFS.writeFileSync(NodePath.join(dir, "a.txt"), "hello\n");
  return dir;
};

const run = (cwd: string, script: string, env = environment, root = cwd) => {
  const out: Buffer[] = [];
  let err = "";
  let resolveRunning!: () => void;
  const running = new Promise<void>((resolve) => (resolveRunning = resolve));
  const handle = startLinuxRun({
    remoto,
    program: "/bin/zsh",
    args: ["-c", script],
    cwd,
    root,
    environment: env,
    machine,
    macOnly: ["src/device/CaptureDevices.test.ts"],
    onProgress: (progress) => {
      if (progress.running) resolveRunning();
    },
    stdout: (chunk) => out.push(chunk),
    stderr: (text) => (err += text),
  });
  return {
    ...handle,
    running,
    output: () => ({ stdout: Buffer.concat(out).toString("utf8"), stderr: err }),
  };
};

describe.runIf(enabled)("Runner against a disposable Linux", () => {
  it("passes output and the exit code through, and maps a Mac shell to bash", async () => {
    const cwd = project();
    const job = run(cwd, "cat a.txt; echo to-stderr >&2; uname; exit 7");
    const { outcome, progress, platform } = await job.done;
    expect(outcome).toEqual({ kind: "finished", code: 7 });
    expect(progress.id).toMatch(/^t3-runner-it-/);
    expect(job.output().stdout).toBe("hello\nLinux\n");
    expect(job.output().stderr).toBe("to-stderr\n");
    expect(platform).toEqual([]);
  });

  it("finds the project's own tools from the job's folder up to the checkout", async () => {
    const root = project();
    const web = NodePath.join(root, "apps", "web");
    NodeFS.mkdirSync(web, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(web, "b.txt"), "web\n");
    const { progress } = await run(root, "true").done;
    // `remoto` never syncs node_modules, and leaves what is there in place.
    onLinux(
      `d=runs/${progress.id}/node_modules/.bin && mkdir -p $d && printf '#!/bin/sh\\necho root-tool\\n' > $d/tool && chmod +x $d/tool`,
    );
    const job = run(web, "tool; cat b.txt", environment, root);
    expect((await job.done).outcome).toEqual({ kind: "finished", code: 0 });
    expect(job.output().stdout).toBe("root-tool\nweb\n");
  });

  it("names Mac-only files in a failed run's output", async () => {
    const job = run(project(), "echo 'FAIL src/device/CaptureDevices.test.ts > lists'; exit 1");
    expect((await job.done).platform).toEqual(["FAIL src/device/CaptureDevices.test.ts > lists"]);
  });

  it("reports unavailable, without running anything, when the host is down", async () => {
    const marker = `never-${NodeCrypto.randomUUID()}`;
    const job = run(project(), `touch ~/${marker}`, downEnvironment);
    expect((await job.done).outcome).toEqual({ kind: "unavailable", touched: false });
    expect(onLinux(`ls ~/${marker} 2>/dev/null || echo absent`)).toBe("absent");
  });

  it("a connection dropped mid-run is confirmed stopped there, so it never runs twice", async () => {
    const marker = `dropped-${NodeCrypto.randomUUID()}`;
    const job = run(project(), `sleep 30; touch ~/${marker}`);
    await job.running;
    // Ends the ssh session on the Linux side while the host stays reachable.
    docker("exec", container, "pkill", "-f", "sshd: dev");
    const { outcome, progress } = await job.done;
    expect(outcome).toEqual({ kind: "dropped" });
    expect(await stopRemote(machine, environment, progress.id!, progress.pgid)).toMatch(
      /^(gone|stopped|killed)$/,
    );
    expect(onLinux(`pgrep -f '[r]uns/${progress.id}' || echo none`)).toBe("none");
    expect(onLinux(`ls ~/${marker} 2>/dev/null || echo absent`)).toBe("absent");
  });

  it("Stop kills the local remoto and leaves no process there", async () => {
    const job = run(project(), "sleep 60");
    await job.running;
    job.kill("SIGTERM");
    const { progress } = await job.done;
    expect(await stopRemote(machine, environment, progress.id!, progress.pgid)).toMatch(
      /^(gone|stopped|killed)$/,
    );
    expect(onLinux(`pgrep -f '[r]uns/${progress.id}' || echo none`)).toBe("none");
  });

  it("cannot confirm while the host is unreachable", async () => {
    expect(await stopRemote(machine, downEnvironment, "t3-runner-it-x-00000000", null)).toBe(
      "unreachable",
    );
  });

  it("heartbeat goes offline after the configured failures and back online after one success", async () => {
    const config = { ...machine, runnerOfflineAfterFailures: 2 };
    // Failures closer than half a heartbeat apart count once: these are a heartbeat apart.
    const beat = (n: number) => n * config.runnerHeartbeatSeconds * 1000;
    let health = nextHealth(
      UNKNOWN_HEALTH,
      await checkLinux(machine, environment),
      config,
      20_000,
      beat(1),
    );
    expect(health).toMatchObject({ online: true, failures: 0 });
    expect(health.cpuCount).toBeGreaterThan(0);
    expect(health.totalMemoryBytes).toBeGreaterThan(0);
    health = nextHealth(
      health,
      await checkLinux(machine, downEnvironment),
      config,
      20_000,
      beat(2),
    );
    expect(health).toMatchObject({ online: true, failures: 1 });
    health = nextHealth(
      health,
      await checkLinux(machine, downEnvironment),
      config,
      20_000,
      beat(3),
    );
    expect(health).toMatchObject({ online: false, failures: 2 });
    health = nextHealth(health, await checkLinux(machine, environment), config, 20_000, beat(4));
    expect(health).toMatchObject({ online: true, failures: 0 });
  });

  const bin = NodePath.resolve(import.meta.dirname, "../bin.ts");
  /** A queue whose published Runner block says `config` for every folder. */
  const queueWith = (config: Partial<typeof DEFAULT_PROJECT_CONFIG>, machineConfig = machine) => {
    const queueDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runner-it-queue-"));
    NodeFS.writeFileSync(
      NodePath.join(queueDir, "queue.json"),
      JSON.stringify({
        entries: [],
        enabled: true,
        runner: {
          global: { ...DEFAULT_PROJECT_CONFIG, runnerEnabled: true, ...config },
          machine: machineConfig,
          projects: [],
          publisher: { pid: 1, home: "/nowhere", primary: false },
        },
      }),
    );
    return queueDir;
  };
  const heavy = (cwd: string, queueDir: string, script: string, env = environment) =>
    NodeChildProcess.spawn(
      process.execPath,
      [bin, "heavy", "--queue-dir", queueDir, "--runner", "linux", "--", "sh", "-c", script],
      { cwd, env: { ...env, T3CODE_REMOTO: remoto } },
    );
  const finished = (child: NodeChildProcess.ChildProcess) => {
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
      child.on("close", (code) => resolve({ code, stdout, stderr })),
    );
  };

  it("`t3 heavy` runs a Linux job end to end and returns its code", async () => {
    const result = await finished(heavy(project(), queueWith({}), "echo from-$(uname); exit 3"));
    expect(result.stdout).toBe("from-Linux\n");
    expect(result.stderr).toContain("[t3 heavy] Linux: running");
    expect(result.code).toBe(3);
  });

  // Linux has no such file: the script's text goes with the job, named literally or by a variable.
  it.each([
    (dir: string) => `${dir}/show.sh --fast`,
    (dir: string) => `S=${dir}; $S/show.sh --fast`,
    (dir: string) => `bash ${dir}/show.sh --fast`,
  ])("`t3 heavy` runs a script outside the checkout on Linux from its text (%#)", async (line) => {
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runner-it-script-"));
    NodeFS.writeFileSync(
      NodePath.join(scratch, "show.sh"),
      // `a.txt` is only in the checkout's copy there, and the script's own path is on no Linux.
      '#!/bin/sh\necho "from-$(uname) $*"; cat a.txt\n',
      { mode: 0o755 },
    );
    const result = await finished(heavy(project(), queueWith({}), line(scratch)));
    expect(result.stdout, result.stderr).toBe("from-Linux --fast\nhello\n");
    expect(result.code).toBe(0);
  });

  // Each of these would fail there (its folder, a program by that name): it runs here instead.
  it.each([
    // Seen only once the shell expanded it: the job says why as it leaves the line.
    [
      "show.sh",
      '#!/bin/sh\ncd "$(dirname "$0")" && echo "from-$(uname)"\n',
      "running the line on this Mac",
    ],
    // Not a shell script, so no text to send: Linux would run its own `vitest`, or none. Judged as
    // it is queued; the hook tells the agent why (`REMOTO_HERE`).
    ["vitest", "#!/usr/bin/env -S sh\necho from-$(uname)\n", ""],
  ])("`t3 heavy` keeps %s from outside the checkout on this Mac", async (name, body, says) => {
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runner-it-script-"));
    NodeFS.writeFileSync(NodePath.join(scratch, name), body, { mode: 0o755 });
    const result = await finished(
      heavy(project(), queueWith({ runnerDropped: "agent" }), `S=${scratch}; $S/${name} run`),
    );
    expect(result.stdout, result.stderr).toBe("from-Darwin\n");
    expect(result.stderr).toContain(says);
    expect(result.code).toBe(0);
  });

  // A lost link is Linux's to recover: whatever "If a Linux run fails" says, the job goes back there.
  it("`t3 heavy` reruns a dropped job on Linux once it confirms it stopped and the link is back", async () => {
    const cwd = project();
    // Only work goes to Linux; a bare `sleep` would run here.
    NodeFS.writeFileSync(NodePath.join(cwd, "job.sh"), "sleep 20; uname >> ran.txt\n");
    const child = heavy(cwd, queueWith({ runnerDropped: "mac" }), "sh job.sh");
    const result = finished(child);
    await new Promise<void>((resolve) =>
      child.stderr!.on("data", (chunk) => {
        if (String(chunk).includes("Linux: running")) resolve();
      }),
    );
    docker("exec", container, "pkill", "-f", "sshd: dev");
    const { code, stderr } = await result;
    expect(stderr).toContain("dropped the connection mid-run");
    expect(code).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(cwd, "ran.txt"))).toBe(false);
    expect(onLinux(`cat ~/runs/${NodePath.basename(cwd)}-*/ran.txt`)).toBe("Linux");
  });

  it("`t3 heavy` under Tell the agent returns Linux's 127 and never reruns the job here", async () => {
    const cwd = project();
    NodeFS.writeFileSync(NodePath.join(cwd, "job.sh"), "uname >> ran.txt; t3-not-on-linux\n");
    const result = await finished(heavy(cwd, queueWith({ runnerDropped: "agent" }), "sh job.sh"));
    expect(result.code).toBe(127);
    expect(result.stderr).toMatch(/Linux couldn't run this: .*t3-not-on-linux.*not found/);
    expect(NodeFS.existsSync(NodePath.join(cwd, "ran.txt"))).toBe(false);
    expect(onLinux(`cat ~/runs/${NodePath.basename(cwd)}-*/ran.txt`)).toBe("Linux");
  });

  it("`t3 heavy` brings back what the job wrote there, except a file changed here meanwhile", async () => {
    const cwd = project();
    NodeFS.writeFileSync(
      NodePath.join(cwd, "job.sh"),
      "echo quick > quick.txt; sleep 2; echo linux > a.txt; mkdir -p out node_modules; echo made > out/made.txt; echo dep > node_modules/dep.txt; echo linux > mine.txt\n",
    );
    const child = heavy(cwd, queueWith({ runnerBringBack: true }), "sh job.sh");
    const result = finished(child);
    await new Promise<void>((resolve) =>
      child.stderr!.on("data", (chunk) => {
        if (String(chunk).includes("Linux: running")) resolve();
      }),
    );
    NodeFS.writeFileSync(NodePath.join(cwd, "mine.txt"), "mac\n");
    const { code, stderr } = await result;
    expect(code).toBe(0);
    const read = (path: string) => NodeFS.readFileSync(NodePath.join(cwd, path), "utf8");
    expect(read("a.txt")).toBe("linux\n");
    expect(read("out/made.txt")).toBe("made\n");
    // Written in the same instant the wrapper marked the start.
    expect(read("quick.txt")).toBe("quick\n");
    expect(read("mine.txt")).toBe("mac\n");
    expect(NodeFS.existsSync(NodePath.join(cwd, "node_modules"))).toBe(false);
    expect(stderr).toContain("Not copied back (changed on this Mac): mine.txt\n");
  });

  it('`t3 heavy` follows "Linux unavailable: Run on this Mac" when the host is down', async () => {
    // Offline takes two failed heartbeats at least: these come a few seconds apart.
    const queueDir = queueWith(
      { runnerUnavailable: "mac" },
      { ...machine, runnerHeartbeatSeconds: 5, runnerSshTimeoutSeconds: 1 },
    );
    const result = await finished(
      heavy(project(), queueDir, "echo from-$(uname)", downEnvironment),
    );
    expect(result.stdout, result.stderr).toBe("from-Darwin\n");
    expect(result.code).toBe(0);
  });
});
