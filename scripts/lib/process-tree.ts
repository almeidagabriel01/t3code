// @effect-diagnostics nodeBuiltinImport:off - signals real descendant processes.
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

export function descendantPids(rootPid: number, psOutput: string): number[] {
  const children = new Map<number, number[]>();
  for (const line of psOutput.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    children.set(ppid!, [...(children.get(ppid!) ?? []), pid!]);
  }
  const found: number[] = [];
  const queue = [rootPid];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    for (const child of children.get(pid) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

// The vp launcher dies on a signal without forwarding it, so the runner ends its whole tree itself.
export const terminateDescendants = Effect.fn("DevRunner.terminateDescendants")(function* (
  rootPid: number,
) {
  if (yield* HostProcess.isWindows) return;
  const signal = yield* HostProcess.SignalProcess;
  const pids = yield* Effect.sync(() => {
    try {
      const ps = NodeChildProcess.execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
        encoding: "utf8",
      });
      return descendantPids(rootPid, ps);
    } catch {
      return [];
    }
  });
  for (const pid of pids) signal(pid, "SIGTERM");
  // ponytail: a pid reused within these 3 s gets SIGKILL too; compare start times if it ever bites.
  const alive = () => pids.filter((pid) => signal(pid, 0));
  for (let waited = 0; waited < 3000 && alive().length > 0; waited += 50) {
    yield* Effect.sleep("50 millis");
  }
  for (const pid of alive()) signal(pid, "SIGKILL");
});
