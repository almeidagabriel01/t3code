// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type HeavyNoticesMode,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerSettingsService } from "../serverSettings.ts";
import { HeavyQueueNotices, layer, queueFileError } from "./HeavyQueueNotices.ts";
import * as QueueFile from "./queueFile.ts";

const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-notices-"));

const job = (id: string) => ({
  id,
  pid: process.pid,
  threadId: "thread-1",
  label: "pnpm test",
  cwd: "/w/app",
  createdAt: "2026-11-12T12:00:00.000Z",
  startedAt: null,
});

const withNotices = <A, E>(
  mode: HeavyNoticesMode,
  before: (dir: string) => void,
  run: (dir: string, notices: HeavyQueueNotices["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const dir = tempDir();
    before(dir);
    const settings: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, heavyNotices: mode };
    const services = Layer.succeed(ServerSettingsService, {
      getSettings: Effect.succeed(settings),
      streamChanges: Stream.empty,
    } as unknown as ServerSettingsService["Service"]);
    return yield* Effect.gen(function* () {
      const notices = yield* HeavyQueueNotices;
      return yield* run(dir, notices);
    }).pipe(Effect.provide(layer(dir).pipe(Layer.provide(services))));
  });

describe("HeavyQueueNotices", () => {
  it.effect("publishes a failure the queue file logged after the baseline", () =>
    withNotices(
      "unexpected",
      (dir) => {
        // Logged before the server started: never replayed.
        QueueFile.enqueue(dir, job("old"));
        QueueFile.finish(dir, "old", 1);
      },
      (dir, notices) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            notices.stream.pipe(Stream.take(1), Stream.runCollect),
          );
          yield* Effect.yieldNow;
          QueueFile.enqueue(dir, job("new"));
          QueueFile.tryStart(dir, "new");
          QueueFile.finish(dir, "new", 2);
          yield* TestClock.adjust("2 seconds");
          const [batch] = yield* Fiber.join(fiber);
          expect(batch).toEqual([
            {
              id: QueueFile.readDoc(dir).events.at(-1)!.id,
              tone: "error",
              title: "pnpm test failed on this Mac",
              description: "Exit code 2",
              machine: "mac",
              threadId: "thread-1",
            },
          ]);
          expect(QueueFile.readDoc(dir).entries).toEqual([]);
        }),
    ),
  );
});

describe("the queue file check", () => {
  it("accepts a missing file and folder, and reports a corrupt or read-only one", () => {
    const dir = tempDir();
    expect(queueFileError(NodePath.join(dir, "missing"))).toBeNull();
    expect(queueFileError(dir)).toBeNull();
    NodeFS.writeFileSync(NodePath.join(dir, "queue.json"), "{");
    expect(queueFileError(dir)).toMatch(/^Cannot read .*queue\.json/);
    NodeFS.writeFileSync(NodePath.join(dir, "queue.json"), "{}");
    NodeFS.chmodSync(NodePath.join(dir, "queue.json"), 0o444);
    expect(queueFileError(dir)).toMatch(/^Cannot write .*queue\.json/);
    NodeFS.chmodSync(NodePath.join(dir, "queue.json"), 0o644);
  });
});
