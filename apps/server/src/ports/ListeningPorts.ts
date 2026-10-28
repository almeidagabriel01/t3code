import {
  KillListeningPortError,
  type KillListeningPortInput,
  type KillListeningPortResult,
  type ListeningPort,
  type ProjectId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";

export class ListeningPorts extends Context.Service<
  ListeningPorts,
  {
    /** Every TCP listener on the host. Probes that fail or are unavailable yield fewer rows, never an error. */
    readonly list: () => Effect.Effect<ReadonlyArray<ListeningPort>>;
    /** Signals the process that holds `port` now, never T3 Code itself or the app hosting it. */
    readonly kill: (
      input: KillListeningPortInput,
    ) => Effect.Effect<KillListeningPortResult, KillListeningPortError>;
  }
>()("t3/ports/ListeningPorts") {}

interface RawListener {
  readonly port: number;
  readonly host: string;
  readonly pid: number | null;
  readonly processName: string | null;
}

const PROBE_TIMEOUT = Duration.seconds(5);
const PROBE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PROC_FD_WALK_LIMIT = 50_000;
const PROC_TCP_LISTEN = "0A";
const KILL_GRACE_POLL = Duration.millis(250);
const KILL_GRACE_POLLS = 12;
const DESKTOP_PROCESS_NAME = /electron|t3 ?code/i;

const validPort = (port: number): boolean => Number.isInteger(port) && port > 0 && port < 65536;
const validPid = (pid: number): boolean => Number.isInteger(pid) && pid > 0;

const dedupe = (listeners: ReadonlyArray<RawListener>): ReadonlyArray<RawListener> => [
  ...new Map(listeners.map((l) => [`${l.pid ?? ""}|${l.host}|${l.port}`, l])).values(),
];

const splitEndpoint = (endpoint: string): { host: string; port: number } | null => {
  const colon = endpoint.lastIndexOf(":");
  if (colon <= 0) return null;
  const port = Number(endpoint.slice(colon + 1));
  if (!validPort(port)) return null;
  return { host: endpoint.slice(0, colon).replace(/^\[|\]$/g, ""), port };
};

/** Reads `lsof -F pcn` output: `p` starts a process, `c` names it, each `n` is `host:port`. */
export const parseLsofListeners = (raw: string): ReadonlyArray<RawListener> => {
  const listeners: Array<RawListener> = [];
  let pid: number | null = null;
  let processName: string | null = null;
  for (const line of raw.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p")) {
      const parsed = Number(value);
      pid = validPid(parsed) ? parsed : null;
      processName = null;
    } else if (line.startsWith("c")) {
      processName = value.trim() || null;
    } else if (line.startsWith("n")) {
      const endpoint = splitEndpoint(value.split(" ", 1)[0] ?? "");
      if (endpoint) listeners.push({ ...endpoint, pid, processName });
    }
  }
  return dedupe(listeners);
};

/** Reads `lsof -a -p <pids> -d cwd -Fn`. */
export const parseLsofCwds = (raw: string): ReadonlyMap<number, string> => {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      pid = validPid(parsed) ? parsed : null;
    } else if (line.startsWith("n") && pid !== null && line.length > 1) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
};

/** `/proc/net/tcp` prints each 32-bit word of the address little-endian. */
const decodeProcAddress = (hex: string): string | null => {
  const words = hex.toLowerCase().match(/.{8}/g);
  if (!words || (words.length !== 1 && words.length !== 4)) return null;
  const bytes = words.flatMap((word) => (word.match(/../g) ?? []).toReversed());
  if (bytes.length === 4) return bytes.map((b) => Number.parseInt(b, 16)).join(".");
  if (bytes.every((b) => b === "00")) return "::";
  if (bytes.slice(0, 15).every((b) => b === "00") && bytes[15] === "01") return "::1";
  if (bytes.slice(0, 10).every((b) => b === "00") && bytes[10] === "ff" && bytes[11] === "ff") {
    return bytes
      .slice(12)
      .map((b) => Number.parseInt(b, 16))
      .join(".");
  }
  return (bytes.join("").match(/.{4}/g) ?? []).map((g) => g.replace(/^0+(?=.)/, "")).join(":");
};

export const parseProcNetTcp = (
  raw: string,
): ReadonlyArray<{ readonly host: string; readonly port: number; readonly inode: string }> =>
  raw
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const fields = line.trim().split(/\s+/);
      const [address, portHex] = fields[1]?.split(":") ?? [];
      const inode = fields[9];
      if (fields[3] !== PROC_TCP_LISTEN || !address || !portHex || !inode || inode === "0")
        return [];
      const host = decodeProcAddress(address);
      const port = Number.parseInt(portHex, 16);
      return host !== null && validPort(port) ? [{ host, port, inode }] : [];
    });

/** Reads `netstat -ano -p tcp`; a foreign port of `:0` marks a listener in any locale. */
export const parseNetstatListeners = (raw: string): ReadonlyArray<RawListener> =>
  dedupe(
    raw.split(/\r?\n/).flatMap((line) => {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4 || fields[0]?.toUpperCase() !== "TCP") return [];
      if (!(fields[2] ?? "").endsWith(":0")) return [];
      const endpoint = splitEndpoint(fields[1] ?? "");
      const pid = Number(fields.at(-1));
      if (!endpoint) return [];
      return [{ ...endpoint, pid: validPid(pid) ? pid : null, processName: null }];
    }),
  );

const trimSeparators = (path: string): string =>
  path.length > 1 ? path.replace(/[\\/]+$/, "") : path;

/** The project whose workspace root equals or contains `cwd`; the deepest root wins. */
export const attributeToProject = (
  cwd: string | null,
  roots: ReadonlyArray<{ readonly projectId: ProjectId; readonly workspaceRoot: string }>,
): ProjectId | null => {
  if (cwd === null) return null;
  const target = trimSeparators(cwd);
  let best: { projectId: ProjectId; length: number } | null = null;
  for (const { projectId, workspaceRoot } of roots) {
    const root = trimSeparators(workspaceRoot);
    const contains =
      target === root ||
      target.startsWith(root.endsWith("/") ? root : `${root}/`) ||
      target.startsWith(root.endsWith("\\") ? root : `${root}\\`);
    if (contains && (best === null || root.length > best.length)) {
      best = { projectId, length: root.length };
    }
  }
  return best?.projectId ?? null;
};

/** Reads `ps -A -o pid=,ppid=` into a child to parent map. */
export const parseParentTable = (raw: string): ReadonlyMap<number, number> => {
  const parents = new Map<number, number>();
  for (const line of raw.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (validPid(pid ?? 0) && Number.isInteger(ppid)) parents.set(pid!, ppid!);
  }
  return parents;
};

/** This server's pid and every ancestor: the desktop app and shells that launched it. */
export const protectedPids = (
  parents: ReadonlyMap<number, number>,
  serverPid: number,
): ReadonlySet<number> => {
  const guarded = new Set([serverPid, process.ppid]);
  for (
    let parent = parents.get(serverPid);
    parent !== undefined && parent > 1 && !guarded.has(parent);
    parent = parents.get(parent)
  ) {
    guarded.add(parent);
  }
  return guarded;
};

/** Only a pid that holds this port in a fresh scan may be signaled, and never a protected one. */
export const decideKill = (input: {
  readonly listeners: ReadonlyArray<RawListener>;
  readonly pid: number;
  readonly port: number;
  readonly protectedPids: ReadonlySet<number>;
}): "allowed" | "not-found" | "protected" => {
  const owner = input.listeners.find((l) => l.pid === input.pid && l.port === input.port);
  if (owner === undefined) return "not-found";
  if (input.protectedPids.has(input.pid)) return "protected";
  return DESKTOP_PROCESS_NAME.test(owner.processName ?? "") ? "protected" : "allowed";
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ESRCH"
    );
  }
};

/** @public */
export const make = Effect.gen(function* ListeningPortsMake() {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const platform = yield* HostProcess.Platform;

  const run = (command: string, args: ReadonlyArray<string>) =>
    processRunner
      .run({
        command,
        args,
        timeout: PROBE_TIMEOUT,
        maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.map((result) =>
          result.code === 0 || result.stdout.length > 0 ? result.stdout : null,
        ),
        Effect.orElseSucceed(() => null),
      );

  const procOwners = Effect.fn("ListeningPorts.procOwners")(function* (
    inodes: ReadonlySet<string>,
  ) {
    const owners = new Map<string, { pid: number; processName: string | null }>();
    const pids = (yield* fileSystem
      .readDirectory("/proc")
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))).filter((entry) =>
      /^\d+$/.test(entry),
    );
    let budget = PROC_FD_WALK_LIMIT;
    for (const pid of pids) {
      if (owners.size === inodes.size || budget <= 0) break;
      const fds = (yield* fileSystem
        .readDirectory(`/proc/${pid}/fd`)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))).slice(0, budget);
      budget -= fds.length;
      const links = yield* Effect.forEach(
        fds,
        (fd) => fileSystem.readLink(`/proc/${pid}/fd/${fd}`).pipe(Effect.orElseSucceed(() => "")),
        { concurrency: 16 },
      );
      const matched = links
        .flatMap((link) => /^socket:\[(\d+)\]$/.exec(link)?.[1] ?? [])
        .filter((inode) => inodes.has(inode) && !owners.has(inode));
      if (matched.length === 0) continue;
      const processName = yield* fileSystem.readFileString(`/proc/${pid}/comm`).pipe(
        Effect.map((name) => name.trim() || null),
        Effect.orElseSucceed(() => null),
      );
      for (const inode of matched) owners.set(inode, { pid: Number(pid), processName });
    }
    return owners;
  });

  const linuxListeners = Effect.fn("ListeningPorts.linuxListeners")(function* () {
    const tables = yield* Effect.forEach(["/proc/net/tcp", "/proc/net/tcp6"], (path) =>
      fileSystem.readFileString(path).pipe(Effect.orElseSucceed(() => "")),
    );
    const sockets = tables.flatMap(parseProcNetTcp);
    const owners = yield* procOwners(new Set(sockets.map((socket) => socket.inode)));
    return dedupe(
      sockets.map(({ host, port, inode }) => ({
        host,
        port,
        pid: owners.get(inode)?.pid ?? null,
        processName: owners.get(inode)?.processName ?? null,
      })),
    );
  });

  const windowsListeners = Effect.fn("ListeningPorts.windowsListeners")(function* () {
    const outputs = yield* Effect.forEach(["tcp", "tcpv6"], (protocol) =>
      run("netstat.exe", ["-ano", "-p", protocol]),
    );
    return dedupe(outputs.flatMap((out) => (out === null ? [] : parseNetstatListeners(out))));
  });

  const lsofListeners = Effect.fn("ListeningPorts.lsofListeners")(function* () {
    const out = yield* run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
    return out === null ? null : parseLsofListeners(out);
  });

  const cwdsFor = Effect.fn("ListeningPorts.cwdsFor")(function* (pids: ReadonlyArray<number>) {
    if (pids.length === 0 || platform === "win32") return new Map<number, string>();
    if (platform === "linux") {
      const entries = yield* Effect.forEach(
        pids,
        (pid) =>
          fileSystem.readLink(`/proc/${pid}/cwd`).pipe(
            Effect.map((cwd) => [pid, cwd] as const),
            Effect.option,
          ),
        { concurrency: 16 },
      );
      return new Map(entries.flatMap((entry) => (entry._tag === "Some" ? [entry.value] : [])));
    }
    const out = yield* run("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"]);
    return out === null ? new Map<number, string>() : parseLsofCwds(out);
  });

  const scan = Effect.fn("ListeningPorts.scan")(function* () {
    return platform === "win32"
      ? yield* windowsListeners()
      : ((platform === "linux" ? null : yield* lsofListeners()) ?? (yield* linuxListeners()));
  });

  const list = Effect.fn("ListeningPorts.list")(function* () {
    const listeners = yield* scan();
    const pids = [...new Set(listeners.flatMap((l) => (l.pid === null ? [] : [l.pid])))];
    const cwds = yield* cwdsFor(pids);
    const roots = yield* projects.list().pipe(
      Effect.map((rows) =>
        rows.map(({ projectId, workspaceRoot }) => ({ projectId, workspaceRoot })),
      ),
      Effect.orElseSucceed(() => []),
    );
    return listeners
      .map((listener): ListeningPort => {
        const cwd = listener.pid === null ? null : (cwds.get(listener.pid) ?? null);
        return { ...listener, cwd, projectId: attributeToProject(cwd, roots) };
      })
      .toSorted((a, b) => a.port - b.port || a.host.localeCompare(b.host));
  });

  const signal = (pid: number, signalName: "SIGTERM" | "SIGKILL") =>
    Effect.suspend(() => {
      try {
        process.kill(pid, signalName);
        return Effect.succeed(true);
      } catch (cause) {
        return typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ESRCH"
          ? Effect.succeed(false)
          : Effect.fail(new KillListeningPortError({ reason: "signal-failed", cause }));
      }
    });

  const kill = Effect.fn("ListeningPorts.kill")(function* (input: KillListeningPortInput) {
    if (platform === "win32") return yield* new KillListeningPortError({ reason: "unsupported" });
    const listeners = yield* scan();
    const table = yield* run("ps", ["-A", "-o", "pid=,ppid="]);
    const decision = decideKill({
      listeners,
      ...input,
      protectedPids: protectedPids(
        table === null ? new Map() : parseParentTable(table),
        process.pid,
      ),
    });
    if (decision !== "allowed") return yield* new KillListeningPortError({ reason: decision });
    if (!(yield* signal(input.pid, "SIGTERM"))) {
      return { outcome: "already-exited" } satisfies KillListeningPortResult;
    }
    for (let poll = 0; poll < KILL_GRACE_POLLS; poll += 1) {
      yield* Effect.sleep(KILL_GRACE_POLL);
      if (!isAlive(input.pid)) return { outcome: "terminated" } satisfies KillListeningPortResult;
    }
    yield* signal(input.pid, "SIGKILL");
    return { outcome: "killed" } satisfies KillListeningPortResult;
  });

  return ListeningPorts.of({ list, kill });
});

export const layer = Layer.effect(ListeningPorts, make);
