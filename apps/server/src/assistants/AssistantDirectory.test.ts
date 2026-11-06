import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { assistantNote } from "./assistantNote.ts";
import * as Directory from "./AssistantDirectory.ts";
import { assistantMayMessage } from "./AssistantDirectory.ts";

// ceo -> lead -> eng, plus a second top-level pair with no relation to it, and a loner.
const edges = [
  { id: "ceo", reportsTo: null },
  { id: "lead", reportsTo: "ceo" },
  { id: "eng", reportsTo: "lead" },
  { id: "loner", reportsTo: null },
  { id: "loner2", reportsTo: null },
];

it.each([
  ["a leader asks its report", "ceo", "lead", true],
  ["a leader asks a report of a report", "ceo", "eng", true],
  ["a report answers upward by message", "eng", "lead", false],
  ["a report messages the top", "lead", "ceo", false],
  ["siblings in different branches", "eng", "loner", false],
  ["an outsider messages a leader", "loner", "ceo", false],
  ["a leader messages an outsider", "ceo", "loner", false],
  ["two assistants with no org relation", "loner", "loner2", true],
  ["an assistant messaging itself", "eng", "eng", true],
] as const)("assistantMayMessage: %s", (_name, sender, target, allowed) => {
  assert.strictEqual(assistantMayMessage(edges, sender, target), allowed);
});

const seed = (id: string, extra: { reportsTo?: string; role?: string; archived?: boolean } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO assistants
        (assistant_id, handle, name, project_id, tool_access, thread_id, role, reports_to, archived_at, created_at, updated_at)
      VALUES (${id}, ${id}, ${id.toUpperCase()}, 'p1', 'full', ${`assistant:${id}:1`},
        ${extra.role ?? ""}, ${extra.reportsTo ?? null}, ${extra.archived ? "now" : null}, '2026-01-01', '2026-01-01')`;
  });
const directoryLayer = Directory.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const thread = (id: string) => ThreadId.make(`assistant:${id}:1`);

it.effect("the directory answers who may message whom, and who is on whose team", () =>
  Effect.gen(function* () {
    const directory = yield* Directory.AssistantDirectory;
    yield* seed("ceo", { role: "CEO" });
    yield* seed("eng", { reportsTo: "ceo", role: "Engineer" });
    yield* seed("gone", { reportsTo: "ceo", archived: true });
    yield* seed("solo");
    yield* seed("solo2");
    const may = (from: string, to: ReturnType<typeof ThreadId.make>) =>
      directory.mayMessage(thread(from), to);
    assert.isTrue(yield* may("ceo", thread("eng")));
    assert.isFalse(yield* may("eng", thread("ceo")));
    assert.isFalse(yield* may("solo", thread("ceo")));
    assert.isTrue(yield* may("solo", thread("solo2")));
    // Anything that is not an assistant thread on either side is not the guard's business.
    assert.isTrue(yield* may("eng", ThreadId.make("thread:plain")));
    assert.isTrue(yield* directory.mayMessage(ThreadId.make("thread:plain"), thread("ceo")));

    const found = Option.getOrThrow(yield* directory.forThread(thread("ceo")));
    const team = yield* directory.teamOf(found.assistant);
    assert.deepEqual(
      team.reports.map((entry) => entry.handle),
      ["eng"],
    );
    assert.isNull(team.leader);
    const eng = Option.getOrThrow(yield* directory.forThread(thread("eng")));
    assert.strictEqual((yield* directory.teamOf(eng.assistant)).leader?.handle, "ceo");

    // The turn's note carries the team, except in front of a slash command.
    const note = yield* assistantNote(Option.some(directory), thread("ceo"), "hello");
    assert.include(note, 'role="CEO"');
    assert.include(note, "Your direct reports: ENG (@eng, threadId assistant:eng:1).");
    assert.notInclude(note, "GONE");
    assert.strictEqual(yield* assistantNote(Option.some(directory), thread("ceo"), "/compact"), "");
    assert.strictEqual(
      yield* assistantNote(Option.some(directory), ThreadId.make("thread:plain"), "hi"),
      "",
    );
    assert.strictEqual(yield* assistantNote(Option.none(), thread("ceo"), "hi"), "");
  }).pipe(Effect.provide(directoryLayer)),
);

it("a damaged connector list loses only the bad entries", () => {
  const good = { name: "docs", transport: "http", url: "https://x.test", future: true };
  assert.deepEqual(Directory.decodeMcpServers(null), []);
  assert.deepEqual(Directory.decodeMcpServers("not json"), []);
  assert.deepEqual(Directory.decodeMcpServers('{"a":1}'), []);
  assert.deepEqual(
    Directory.decodeMcpServers(JSON.stringify([good, { name: "Bad Name", transport: "http" }, 7])),
    [
      {
        name: "docs",
        transport: "http",
        url: "https://x.test",
        args: [],
        headers: [],
        env: [],
        enabled: true,
      },
    ],
  );
});

const teamRow = (id: string, members: ReadonlyArray<string>, leader: string | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO assistant_teams (team_id, name, member_ids_json, leader_id, leader_title, created_at, updated_at)
      VALUES (${id}, ${`Team ${id}`}, ${JSON.stringify(members)}, ${leader}, ${leader === null ? null : "CFO"}, '2026-01-01', '2026-01-01')`;
  });

const sendEvent = (sequence: number, from: string, to: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${sequence}, ${`e${sequence}`}, 'thread', ${`assistant:${to}:1`}, ${sequence}, 'message.updated',
        '2026-11-06T10:00:00.000Z', 'agent',
        ${JSON.stringify({ id: `m${sequence}`, text: "hi", senderThreadId: `assistant:${from}:1` })}, '{}', 2)`;
  });

it.effect("teammates may message each other both ways, up to an hourly cap", () =>
  Effect.gen(function* () {
    const directory = yield* Directory.AssistantDirectory;
    // boss -> ann is an org edge; ann and bo share a team, so bo may still message up and sideways.
    yield* seed("boss");
    yield* seed("ann", { reportsTo: "boss" });
    yield* seed("bo", { reportsTo: "boss" });
    yield* seed("out");
    yield* teamRow("t1", ["ann", "bo"], "bo");
    assert.isFalse(yield* directory.mayMessage(thread("ann"), thread("boss")));
    assert.isTrue(yield* directory.mayMessage(thread("ann"), thread("bo")));
    assert.isTrue(yield* directory.mayMessage(thread("bo"), thread("ann")));
    assert.isFalse(yield* directory.mayMessage(thread("bo"), thread("out")));

    const ann = Option.getOrThrow(yield* directory.forThread(thread("ann"))).assistant;
    const [membership] = yield* directory.teamsOf(ann);
    assert.deepEqual(
      [
        membership?.team.name,
        membership?.leader?.handle,
        membership?.teammates.map((m) => m.handle),
      ],
      ["Team t1", "bo", ["bo"]],
    );
    const note = yield* assistantNote(Option.some(directory), thread("ann"), "hello");
    assert.include(note, 'Team "Team t1": BO (@bo, threadId assistant:bo:1).');
    assert.include(note, "BO is the team's CFO: report your results to them");
    const leaderNote = yield* assistantNote(Option.some(directory), thread("bo"), "hello");
    assert.include(leaderNote, "You are the team's CFO: coordinate the work");

    yield* TestClock.setTime(Date.parse("2026-11-06T10:30:00.000Z"));
    const limited = directory.teamSendLimited(thread("ann"), thread("bo"));
    for (let n = 1; n <= 19; n += 1) yield* sendEvent(n, "ann", "bo");
    assert.isFalse(yield* limited);
    yield* sendEvent(20, "ann", "bo");
    assert.isTrue(yield* limited);
    // The other direction has its own count, a non-teammate is never "limited", and the hour rolls.
    assert.isFalse(yield* directory.teamSendLimited(thread("bo"), thread("ann")));
    assert.isFalse(yield* directory.teamSendLimited(thread("ann"), thread("out")));
    assert.isFalse(yield* directory.teamSendLimited(thread("ann"), ThreadId.make("thread:plain")));
    yield* TestClock.setTime(Date.parse("2026-11-06T11:30:00.000Z"));
    assert.isFalse(yield* limited);
  }).pipe(Effect.provide(directoryLayer)),
);
