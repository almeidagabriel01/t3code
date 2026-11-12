// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_MACHINE_CONFIG } from "./runner.ts";
import {
  checkLinux,
  confirmed,
  remoteCommand,
  resolveRemoto,
  startLinuxRun,
  stopRemote,
} from "./runnerExec.ts";

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runner-exec-"));
let scripts = 0;
/** An executable sh script standing in for `remoto` or `ssh`. */
const fake = (body: string) => {
  scripts += 1;
  const path = NodePath.join(dir, `fake-${scripts}`);
  NodeFS.writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
};
const M = "\\036remoto";

const runWith = (remoto: string) => {
  const stdout: Buffer[] = [];
  let stderr = "";
  const phases: string[] = [];
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const run = startLinuxRun({
    remoto,
    program: "/bin/zsh",
    args: ["-c", "vp test run"],
    cwd: dir,
    environment: process.env,
    machine: DEFAULT_MACHINE_CONFIG,
    macOnly: ["CaptureDevices.test.ts"],
    onProgress: (progress) => {
      phases.push(progress.phase ?? "");
      if (progress.running) started();
    },
    stdout: (chunk) => stdout.push(chunk),
    stderr: (text) => (stderr += text),
  });
  return {
    run,
    running,
    phases,
    out: () => Buffer.concat(stdout).toString("utf8"),
    err: () => stderr,
  };
};

describe("running on Linux through remoto", () => {
  it.each([
    ["/bin/zsh", ["-c", "vp test"], ["bash", "-c", "vp test"]],
    ["/opt/homebrew/bin/node", ["--test"], ["node", "--test"]],
    ["vp", ["test"], ["vp", "test"]],
  ] as const)("%s %j runs there as %j", (program, args, expected) => {
    expect(remoteCommand(program, args)).toEqual(expected);
  });

  it("passes output through, strips markers into progress and keeps the command's code", async () => {
    const remoto = fake(
      [
        `printf '${M} phase=syncing id=app-1a2b3c4d\\n' >&2`,
        `printf '${M} phase=installing\\n' >&2`,
        `printf '${M} phase=running pgid=42\\n' >&2`,
        `echo "args:$*"`,
        "echo FAIL src/device/CaptureDevices.test.ts",
        "printf 'to-stderr\\npartial' >&2",
        `printf '${M} exit=3\\n' >&2`,
        "exit 3",
      ].join("\n"),
    );
    const { run, phases, out, err } = runWith(remoto);
    const result = await run.done;
    expect(result.outcome).toEqual({ kind: "finished", code: 3 });
    expect(result.progress).toMatchObject({ id: "app-1a2b3c4d", pgid: 42 });
    expect(result.platform).toEqual(["FAIL src/device/CaptureDevices.test.ts"]);
    expect(phases).toEqual(["syncing", "installing", "running", "running"]);
    expect(out()).toBe("args:bash -c vp test run\nFAIL src/device/CaptureDevices.test.ts\n");
    expect(err()).toBe("to-stderr\npartial");
  });

  it("reads a lost connection after the start as dropped, and exit 75 as unavailable", async () => {
    const dropped = runWith(fake(`printf '${M} phase=running pgid=9\\n' >&2; exit 255`));
    expect((await dropped.run.done).outcome).toEqual({ kind: "dropped" });
    const down = runWith(fake("echo '[remoto] PC indisponível.' >&2; exit 75"));
    expect((await down.run.done).outcome).toEqual({ kind: "unavailable", touched: false });
    expect(down.err()).toBe("[remoto] PC indisponível.\n");
  });

  it("reports a missing remoto as never started", async () => {
    const missing = runWith(NodePath.join(dir, "does-not-exist"));
    expect((await missing.run.done).outcome).toEqual({ kind: "unavailable", touched: false });
    expect(missing.err()).toContain("cannot run remoto");
  });

  it("kill ends the local remoto", async () => {
    const long = runWith(fake(`printf '${M} phase=running pgid=9\\n' >&2; exec sleep 30`));
    await long.running;
    long.run.kill("SIGTERM");
    expect((await long.run.done).outcome).toEqual({ kind: "dropped" });
  });

  it("finds remoto on PATH, in ~/.local/bin, or where T3CODE_REMOTO says", () => {
    const bin = NodePath.join(dir, "bin");
    const home = NodePath.join(dir, "home");
    NodeFS.mkdirSync(bin, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(home, ".local", "bin"), { recursive: true });
    expect(resolveRemoto({ PATH: bin, HOME: home })).toBeNull();
    NodeFS.writeFileSync(NodePath.join(home, ".local", "bin", "remoto"), "", { mode: 0o755 });
    expect(resolveRemoto({ PATH: bin, HOME: home })).toBe(
      NodePath.join(home, ".local", "bin", "remoto"),
    );
    NodeFS.writeFileSync(NodePath.join(bin, "remoto"), "", { mode: 0o755 });
    expect(resolveRemoto({ PATH: bin, HOME: home })).toBe(NodePath.join(bin, "remoto"));
    expect(resolveRemoto({ T3CODE_REMOTO: "/x/remoto" })).toBe("/x/remoto");
  });
});

describe("ssh calls around a Linux run", () => {
  const env = (ssh: string) => ({ ...process.env, T3CODE_RUNNER_SSH: ssh });

  it("a heartbeat reads load, cores and memory, or says why it failed", async () => {
    const ok = fake("printf '0.50 0.4 0.3 1/2 3\\n4\\nMem: 100 10 20 0 0 80\\n'");
    expect(await checkLinux(DEFAULT_MACHINE_CONFIG, env(ok))).toEqual({
      ok: true,
      reading: { load1: 0.5, cpuCount: 4, totalMemoryBytes: 100, availableMemoryBytes: 80 },
    });
    const refused = fake(
      "echo 'ssh: connect to host pc port 22: Connection refused' >&2; exit 255",
    );
    expect(await checkLinux(DEFAULT_MACHINE_CONFIG, env(refused))).toEqual({
      ok: false,
      error: "ssh: connect to host pc port 22: Connection refused",
    });
    expect(await checkLinux(DEFAULT_MACHINE_CONFIG, env(fake("exit 255")))).toEqual({
      ok: false,
      error: "ssh exited 255",
    });
  });

  it.each([
    ["echo gone", "gone", true],
    ["echo stopped", "stopped", true],
    ["echo killed", "killed", true],
    ["echo alive; exit 1", "alive", false],
    ["exit 255", "unreachable", false],
  ] as const)("a stop check printing %j is %s", async (body, result, clean) => {
    const answer = await stopRemote(DEFAULT_MACHINE_CONFIG, env(fake(body)), "app-1", 5);
    expect(answer).toBe(result);
    expect(confirmed(answer)).toBe(clean);
  });
});
