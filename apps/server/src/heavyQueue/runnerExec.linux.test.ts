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
import { describe, expect, it } from "vitest";

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

const run = (cwd: string, script: string, env = environment) => {
  const out: Buffer[] = [];
  let err = "";
  let resolveRunning!: () => void;
  const running = new Promise<void>((resolve) => (resolveRunning = resolve));
  const handle = startLinuxRun({
    remoto,
    program: "/bin/zsh",
    args: ["-c", script],
    cwd,
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
    const limit = 2;
    let health = nextHealth(UNKNOWN_HEALTH, await checkLinux(machine, environment), limit, 1);
    expect(health).toMatchObject({ online: true, failures: 0 });
    expect(health.cpuCount).toBeGreaterThan(0);
    expect(health.totalMemoryBytes).toBeGreaterThan(0);
    health = nextHealth(health, await checkLinux(machine, downEnvironment), limit, 2);
    expect(health).toMatchObject({ online: true, failures: 1 });
    health = nextHealth(health, await checkLinux(machine, downEnvironment), limit, 3);
    expect(health).toMatchObject({ online: false, failures: 2 });
    health = nextHealth(health, await checkLinux(machine, environment), limit, 4);
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

  it("`t3 heavy` reruns a dropped job on this Mac only after Linux confirms it stopped", async () => {
    const cwd = project();
    const child = heavy(cwd, queueWith({ runnerDropped: "mac" }), "sleep 20; uname >> ran.txt");
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
    expect(NodeFS.readFileSync(NodePath.join(cwd, "ran.txt"), "utf8")).toBe("Darwin\n");
    expect(onLinux(`cat ~/runs/*/ran.txt 2>/dev/null || echo absent`)).toBe("absent");
  });

  it('`t3 heavy` follows "Linux unavailable: Run on this Mac" when the host is down', async () => {
    const queueDir = queueWith(
      { runnerUnavailable: "mac" },
      { ...machine, runnerOfflineAfterFailures: 1 },
    );
    const result = await finished(
      heavy(project(), queueDir, "echo from-$(uname)", downEnvironment),
    );
    expect(result.stdout).toBe("from-Darwin\n");
    expect(result.code).toBe(0);
  });
});
