// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { parseHeavyArgs } from "./heavyCli.ts";
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

const heavy = (dir: string, program: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [BIN, "heavy", "--queue-dir", dir, "--", ...program],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
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
  return { child, until, exited, stderr: () => err };
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

  it("parses the queue dir and the separator", () => {
    expect(parseHeavyArgs(["--queue-dir", "/q", "--", "vp", "test"])).toEqual({
      dir: "/q",
      program: "vp",
      args: ["test"],
    });
    expect(parseHeavyArgs(["vp"]).dir).toBe(Queue.defaultQueueDir());
  });
});
