// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { HeavyQueueEntry, ResourceTelemetryProcess } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { attributeDaemons, NO_CLUES, parseCwds, parseLinks, readClues } from "./daemons.ts";

const START = Date.parse("2026-01-01T00:00:10.000Z");

const proc = (pid: number, ppid: number, startTimeMs = START + 1) =>
  ({
    identity: { pid, startTimeMs },
    ppid,
    cpuPercent: 0,
    residentBytes: 0,
  }) as ResourceTelemetryProcess;

const job = (
  id: string,
  pid: number,
  cwd: string,
  startedMs = START,
  more = {},
): HeavyQueueEntry => ({
  id,
  pid,
  threadId: "t",
  label: "./gradlew assembleRelease",
  cwd,
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: DateTime.formatIso(DateTime.makeUnsafe(startedMs)),
  ...more,
});

// Job 10 (`t3 heavy`) runs gradlew's client 11. Gradle's daemon 50 predates the job and runs a
// worker 51; the Kotlin daemon 60 talks only to Gradle's. 70 is an unrelated app.
const base = [
  proc(10, 5),
  proc(11, 10),
  proc(50, 1, START - 60_000),
  proc(51, 50),
  proc(60, 1),
  proc(70, 1, START - 60_000),
];
const sockets = [
  [11, 50],
  [50, 60],
] as const;

describe("attributeDaemons", () => {
  it.each([
    {
      name: "a warm daemon the job's client talks to, its child and the daemon behind it",
      entries: [job("a", 10, "/repo")],
      links: sockets,
      cwds: {},
      expected: { a: [50, 51, 60] },
    },
    {
      name: "nothing without a socket or a folder",
      entries: [job("a", 10, "/repo")],
      links: [],
      cwds: { 50: "/Users/me/.gradle/daemon/9.3.1", 60: "/elsewhere" },
      expected: {},
    },
    {
      name: "a daemon started during the job in its folder, then what it talks to",
      entries: [job("a", 10, "/repo")],
      links: [[60, 50]],
      cwds: { 60: "/repo/android" },
      expected: { a: [60, 50, 51] },
    },
    {
      name: "the folder rule skips a daemon older than the job",
      entries: [job("a", 10, "/repo")],
      links: [],
      cwds: { 50: "/repo", 70: "/repo" },
      expected: {},
    },
    {
      name: "a sibling folder with the same prefix is not inside",
      entries: [job("a", 10, "/repo")],
      links: [],
      cwds: { 60: "/repo-other" },
      expected: {},
    },
    {
      name: "the deepest job folder takes a daemon both contain",
      entries: [job("a", 10, "/repo"), job("b", 20, "/repo/android", START + 1)],
      extra: [proc(20, 5)],
      links: [],
      cwds: { 60: "/repo/android/app" },
      expected: { b: [60] },
    },
    {
      name: "a daemon two jobs reach counts once, for the first to start",
      entries: [job("late", 20, "/repo", START + 5), job("early", 10, "/repo")],
      extra: [proc(20, 5)],
      links: [...sockets, [20, 50]],
      cwds: {},
      expected: { early: [50, 51, 60] },
    },
    {
      name: "Linux, server-held and waiting entries own no daemons",
      entries: [
        job("l", 10, "/repo", START, { runner: "linux" }),
        job("s", 11, "/repo", START, { server: true }),
        { ...job("w", 10, "/repo"), startedAt: null },
      ],
      links: sockets,
      cwds: { 60: "/repo" },
      expected: {},
    },
  ])("$name", ({ entries, extra = [], links, cwds, expected }) => {
    const clues = {
      links: links as ReadonlyArray<readonly [number, number]>,
      cwds: new Map(Object.entries(cwds).map(([pid, cwd]) => [Number(pid), cwd])),
    };
    expect(attributeDaemons(entries, [...base, ...extra], clues)).toEqual(expected);
  });

  it("never attributes T3's own launchers", () => {
    expect(
      attributeDaemons(
        [job("a", 10, "/repo")],
        base,
        { links: sockets, cwds: new Map() },
        new Set([50]),
      ),
    ).toEqual({});
  });
});

describe("lsof parsing", () => {
  it("pairs both ends of local connections and drops remote ones", () => {
    const text = [
      "p11",
      "f9",
      "n127.0.0.1:5000->127.0.0.1:6000",
      "n10.0.0.2:5001->1.1.1.1:443",
      "p50",
      "f3",
      "n127.0.0.1:6000->127.0.0.1:5000",
      "n[::1]:7000->[::1]:7001",
      "p60",
      "n[::1]:7001->[::1]:7000",
      "",
    ].join("\n");
    expect(parseLinks(text)).toEqual([
      [11, 50],
      [50, 60],
    ]);
  });

  it("reads each pid's working folder", () => {
    expect([...parseCwds("p385\nfcwd\nn/\np433\nfcwd\nn/repo/android\n")]).toEqual([
      [385, "/"],
      [433, "/repo/android"],
    ]);
  });
});

describe("readClues", () => {
  it.effect("reads folders once per process on macOS, and nothing elsewhere", () =>
    Effect.gen(function* () {
      const self = proc(process.pid, 1);
      // oxlint-disable-next-line t3code/no-global-process-runtime -- lsof's macOS flags only run on the real host.
      if (NodeOS.platform() === "darwin") {
        const first = yield* readClues([self]);
        expect(first.cwds.get(process.pid)).toBe(process.cwd());
        expect((yield* readClues([self])).cwds).toEqual(first.cwds);
      }
      const elsewhere = yield* readClues([self]).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      expect(elsewhere).toBe(NO_CLUES);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
