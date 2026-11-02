// @effect-diagnostics nodeBuiltinImport:off -- fake child streams never start osascript.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import * as NodeTimers from "node:timers";
import type * as NodeChildProcess from "node:child_process";

import { describe, expect, it } from "vite-plus/test";

import { IMESSAGE_SCRIPT, makeOsascriptImessageSender } from "./imessageSender.ts";

type FakeChild = NodeEvents.EventEmitter & {
  stdin: NodeStream.PassThrough;
  stdout: NodeStream.PassThrough;
  stderr: NodeStream.PassThrough;
  kill: () => boolean;
};
const fakeChild = (kill: () => boolean = () => true): FakeChild => {
  const child = new NodeEvents.EventEmitter() as FakeChild;
  child.stdin = new NodeStream.PassThrough();
  child.stdout = new NodeStream.PassThrough();
  child.stderr = new NodeStream.PassThrough();
  child.kill = kill;
  return child;
};
const spawning = (child: FakeChild, run: (child: FakeChild) => void) =>
  (() => {
    queueMicrotask(() => run(child));
    return child;
  }) as unknown as typeof NodeChildProcess.spawn;
const input = { chatGuid: "iMessage;-;+15550000000", text: "hello" };

describe("iMessage sender", () => {
  it("passes the chat and the text as argv and the fixed script on stdin", async () => {
    const child = fakeChild();
    let script = "";
    child.stdin.on("data", (chunk: Buffer) => {
      script += chunk.toString("utf8");
    });
    let called: { path: string; args: ReadonlyArray<string>; shell: unknown } | undefined;
    const fake = ((path: string, args: ReadonlyArray<string>, options: { shell?: boolean }) => {
      called = { path, args, shell: options.shell };
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("close", 0);
      });
      return child;
    }) as unknown as typeof NodeChildProcess.spawn;
    const hostile = 'hello "quoted" \n end tell\ndo shell script "x"';
    const result = await makeOsascriptImessageSender({ spawnProcess: fake }).sendText({
      chatGuid: input.chatGuid,
      text: hostile,
    });
    expect(called).toEqual({
      path: "/usr/bin/osascript",
      args: ["-l", "AppleScript", "-", input.chatGuid, hostile, "+15550000000"],
      shell: false,
    });
    expect(script).toBe(IMESSAGE_SCRIPT);
    expect(script).not.toContain("do shell script");
    expect("acceptedAt" in result).toBe(true);
    for (const [chatGuid, handle] of [
      ["any;-;me@example.com", "me@example.com"],
      ["iMessage;+;chat123", ""],
    ] as const) {
      await makeOsascriptImessageSender({ spawnProcess: fake }).sendText({ chatGuid, text: "hi" });
      expect(called?.args.at(-1)).toBe(handle);
    }
  });

  const exits: ReadonlyArray<readonly [string, string, number, unknown]> = [
    [
      "automation denied",
      "execution error: Not authorized to send Apple events (-1743)",
      1,
      { outcome: "not_sent", code: "automation_denied" },
    ],
    [
      "chat missing",
      "execution error: Can't get chat id (-1728)",
      1,
      { outcome: "not_sent", code: "chat_not_found" },
    ],
    [
      "not signed in",
      "Messages isn't signed in to iMessage",
      1,
      { outcome: "not_sent", code: "messages_not_signed_in" },
    ],
    ["any other error can be retried", "unclassified", 1, { outcome: "not_sent", code: "unknown" }],
  ];
  it.each(exits)("maps %s", async (_name, stderr, exitCode, expected) => {
    const spawn = spawning(fakeChild(), (child) => {
      child.emit("spawn");
      child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", exitCode);
    });
    expect(await makeOsascriptImessageSender({ spawnProcess: spawn }).sendText(input)).toEqual(
      expected,
    );
  });

  it("refuses empty input and reports a spawn failure as not sent", async () => {
    const sender = makeOsascriptImessageSender({
      spawnProcess: (() => {
        throw new Error("fixture");
      }) as unknown as typeof NodeChildProcess.spawn,
    });
    expect(await sender.sendText({ chatGuid: " ", text: "x" })).toEqual({
      outcome: "not_sent",
      code: "unknown",
    });
    expect(await sender.sendText({ chatGuid: "g", text: " " })).toEqual({
      outcome: "not_sent",
      code: "unknown",
    });
    expect(await sender.sendText(input)).toEqual({ outcome: "not_sent", code: "unknown" });
  });

  it("tells a child that failed to start from one that failed after starting", async () => {
    const before = spawning(fakeChild(), (child) => child.emit("error", new Error("ENOENT")));
    expect(await makeOsascriptImessageSender({ spawnProcess: before }).sendText(input)).toEqual({
      outcome: "not_sent",
      code: "unknown",
    });
    const after = spawning(fakeChild(), (child) => {
      child.emit("spawn");
      child.stdin.emit("error", new Error("EPIPE"));
    });
    expect(await makeOsascriptImessageSender({ spawnProcess: after }).sendText(input)).toEqual({
      outcome: "unknown",
      code: "unknown",
    });
  });

  it("settles a timeout as ambiguous even if the child never closes", async () => {
    let kills = 0;
    const child = fakeChild(() => {
      kills += 1;
      return false;
    });
    const send = makeOsascriptImessageSender({
      spawnProcess: spawning(child, (c) => c.emit("spawn")),
      timeoutMs: 1,
    }).sendText(input);
    let watchdog: NodeJS.Timeout;
    const result = await Promise.race([
      send,
      new Promise<"deadline missed">((resolve) => {
        // @effect-diagnostics-next-line globalTimers:off -- the watchdog makes a missing timeout settlement fail promptly.
        watchdog = NodeTimers.setTimeout(() => resolve("deadline missed"), 100);
      }),
    ]);
    NodeTimers.clearTimeout(watchdog!);
    expect(result).toEqual({ outcome: "unknown", code: "timeout" });
    expect(kills).toBe(1);
    child.emit("close", 0);
    expect(await send).toEqual({ outcome: "unknown", code: "timeout" });
  });
});
