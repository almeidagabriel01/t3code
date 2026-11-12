// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
/**
 * Runs a heavy job on Linux through `remoto`, and the ssh calls around it: the heartbeat and the
 * check that a stopped or dropped run left nothing behind. Plain Node, like the `t3 heavy` CLI
 * that calls it; the server's heartbeat reuses `checkLinux`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { RunnerMachineConfig } from "@t3tools/contracts";

import {
  foldMarker,
  HEARTBEAT_COMMAND,
  MARKER,
  NO_PROGRESS,
  parseHeartbeat,
  platformFailures,
  remoteOutcome,
  remoteStopScript,
  sshArgs,
  type HealthCheck,
  type RemoteOutcome,
  type RemoteProgress,
} from "./runner.ts";

type Env = Readonly<Record<string, string | undefined>>;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);

/** The Mac's `$SHELL -c` becomes `bash -c` there, and a Mac path to a program becomes its name. */
export const remoteCommand = (program: string, args: ReadonlyArray<string>) => {
  const name = NodePath.basename(program);
  if (SHELLS.has(name)) return ["bash", ...args];
  return [program.includes("/") ? name : program, ...args];
};

const executable = (path: string) => {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** `remoto` from PATH, else where its installer links it; `T3CODE_REMOTO` overrides both. */
export const resolveRemoto = (environment: Env): string | null => {
  if (environment.T3CODE_REMOTO !== undefined) return environment.T3CODE_REMOTO;
  const dirs = (environment.PATH ?? "").split(NodePath.delimiter).filter((dir) => dir !== "");
  const home = environment.HOME ?? NodeOS.homedir();
  for (const dir of [...dirs, NodePath.join(home, ".local", "bin")]) {
    const candidate = NodePath.join(dir, "remoto");
    if (executable(candidate)) return candidate;
  }
  return null;
};

const sshProgram = (environment: Env) => environment.T3CODE_RUNNER_SSH ?? "ssh";

const ssh = (
  machine: RunnerMachineConfig,
  environment: Env,
  command: string,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      sshProgram(environment),
      sshArgs(machine, environment, command),
      { timeout: timeoutMs, env: { ...process.env, ...environment } },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** One heartbeat: load, cores and memory, or why ssh could not get them. */
export const checkLinux = async (
  machine: RunnerMachineConfig,
  environment: Env,
): Promise<HealthCheck> => {
  // ssh enforces ConnectTimeout; the outer limit only covers a host that accepts and then hangs.
  const result = await ssh(
    machine,
    environment,
    HEARTBEAT_COMMAND,
    (machine.runnerSshTimeoutSeconds + machine.runnerHeartbeatSeconds) * 1000,
  );
  if (result.code === 0) return { ok: true, reading: parseHeartbeat(result.stdout) };
  const why = result.stderr.trim().split("\n").pop() ?? "";
  return { ok: false, error: why === "" ? `ssh exited ${result.code ?? "on timeout"}` : why };
};

export type StopResult = "gone" | "stopped" | "killed" | "alive" | "unreachable";

/** Ends whatever is left of run `id` there; only "alive" and "unreachable" leave it unconfirmed. */
export const stopRemote = async (
  machine: RunnerMachineConfig,
  environment: Env,
  id: string,
  pgid: number | null,
): Promise<StopResult> => {
  const script = remoteStopScript(id, pgid, machine.runnerStopWaitSeconds);
  const result = await ssh(
    machine,
    environment,
    script,
    // The script waits up to the stop wait, plus its KILL pass, after ssh connects.
    (machine.runnerSshTimeoutSeconds + 2 * machine.runnerStopWaitSeconds) * 1000,
  );
  const said = result.stdout.trim().split("\n").pop();
  if (said === "gone" || said === "stopped" || said === "killed" || said === "alive") return said;
  return "unreachable";
};

export const confirmed = (result: StopResult) => result !== "alive" && result !== "unreachable";

export interface LinuxRunOptions {
  readonly remoto: string;
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Env;
  readonly machine: RunnerMachineConfig;
  readonly macOnly: ReadonlyArray<string>;
  readonly onProgress: (progress: RemoteProgress) => void;
  readonly stdout: (chunk: Buffer) => void;
  readonly stderr: (text: string) => void;
}

export interface LinuxRun {
  readonly done: Promise<{
    readonly outcome: RemoteOutcome;
    readonly progress: RemoteProgress;
    /** Output lines naming Mac-only files, for a failed run. */
    readonly platform: ReadonlyArray<string>;
  }>;
  /** Ends the local `remoto`; the caller then confirms the remote side with `stopRemote`. */
  readonly kill: (signal: NodeJS.Signals) => void;
}

const lineSplitter = (onLine: (line: string, newline: boolean) => void) => {
  let pending = "";
  return {
    push: (text: string) => {
      pending += text;
      let at = pending.indexOf("\n");
      while (at >= 0) {
        onLine(pending.slice(0, at), true);
        pending = pending.slice(at + 1);
        at = pending.indexOf("\n");
      }
    },
    end: () => {
      if (pending !== "") onLine(pending, false);
      pending = "";
    },
  };
};

/**
 * `REMOTO_FALLBACK=nao`, so an unreachable host exits 75 instead of running here. Output passes
 * through unchanged except the marker lines, which become progress.
 */
export const startLinuxRun = (options: LinuxRunOptions): LinuxRun => {
  const { machine } = options;
  const child = NodeChildProcess.spawn(
    options.remoto,
    remoteCommand(options.program, options.args),
    {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...options.environment,
        REMOTO_FALLBACK: "nao",
        REMOTO_HOST: machine.runnerHost,
        REMOTO_MARKERS: "1",
        REMOTO_TIMEOUT: String(machine.runnerSshTimeoutSeconds),
      },
    },
  );
  let progress: RemoteProgress = NO_PROGRESS;
  const platform = new Set<string>();
  const scan = (line: string) => {
    for (const hit of platformFailures(line, options.macOnly)) platform.add(hit);
  };
  const out = lineSplitter(scan);
  const err = lineSplitter((line, newline) => {
    // A command whose last line has no newline puts the exit marker right after its text.
    const at = line.indexOf(MARKER);
    if (at >= 0) {
      if (at > 0) options.stderr(line.slice(0, at));
      progress = foldMarker(progress, line.slice(at));
      options.onProgress(progress);
      return;
    }
    scan(line);
    options.stderr(newline ? `${line}\n` : line);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    options.stdout(chunk);
    out.push(chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk.toString("utf8")));
  const done = new Promise<{
    outcome: RemoteOutcome;
    progress: RemoteProgress;
    platform: ReadonlyArray<string>;
  }>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      out.end();
      err.end();
      resolve({ outcome: remoteOutcome(progress), progress, platform: [...platform] });
    };
    child.on("error", (error) => {
      options.stderr(`[t3 heavy] cannot run remoto: ${error.message}\n`);
      finish();
    });
    child.on("close", finish);
  });
  return {
    done,
    kill: (signal) => {
      child.kill(signal);
    },
  };
};
