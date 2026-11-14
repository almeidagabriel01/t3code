import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { assistantNote } from "./assistantNote.ts";
import * as Directory from "./AssistantDirectory.ts";
import { effectiveProjectIdsOf, projectScopeRefusal } from "./AssistantSandboxPolicy.ts";

const seed = (id: string, extra: { role?: string; archived?: boolean } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO assistants
        (assistant_id, handle, name, project_id, tool_access, thread_id, role, archived_at, created_at, updated_at)
      VALUES (${id}, ${id}, ${id.toUpperCase()}, 'p1', 'full', ${`assistant:${id}:1`},
        ${extra.role ?? ""}, ${extra.archived ? "now" : null}, '2026-01-01', '2026-01-01')`;
  });
const directoryLayer = Directory.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const thread = (id: string) => ThreadId.make(`assistant:${id}:1`);

it.effect("the turn's note carries the groups, except in front of a slash command", () =>
  Effect.gen(function* () {
    const directory = yield* Directory.AssistantDirectory;
    yield* seed("ceo", { role: "CEO" });
    yield* seed("eng", { role: "Engineer" });
    yield* seed("gone", { archived: true });
    yield* teamRow("t1", ["ceo", "eng", "gone"]);
    const note = yield* assistantNote(Option.some(directory), thread("ceo"), "hello");
    assert.include(note, 'role="CEO"');
    assert.include(note, 'Group "Team t1": ENG (@eng, threadId assistant:eng:1), Engineer.');
    assert.notInclude(note, "GONE");
    assert.strictEqual(yield* assistantNote(Option.some(directory), thread("ceo"), "/compact"), "");
    assert.strictEqual(
      yield* assistantNote(Option.some(directory), ThreadId.make("thread:plain"), "hi"),
      "",
    );
    assert.strictEqual(yield* assistantNote(Option.none(), thread("ceo"), "hi"), "");
  }).pipe(Effect.provide(directoryLayer)),
);

it.effect("the note titles the projects that exist and keeps a gone one as its id", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed("pro");
    yield* sql`UPDATE assistants SET scope = 'project', project_ids_json = '["p1","gone"]' WHERE assistant_id = 'pro'`;
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('p1', 'harvey', '/w', '[]', '2026-01-01', '2026-01-01')`;
    const directory = yield* Directory.AssistantDirectory;
    const note = yield* assistantNote(Option.some(directory), thread("pro"), "hello");
    assert.include(
      note,
      "You work in: harvey (id: p1), gone. If the request does not make clear which one, ask before changing anything.",
    );
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

function teamRow(id: string, members: ReadonlyArray<string>, lead: string | null = null) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO assistant_teams (team_id, name, member_ids_json, lead_id, created_at, updated_at)
      VALUES (${id}, ${`Team ${id}`}, ${JSON.stringify(members)}, ${lead}, '2026-01-01', '2026-01-01')`;
  });
}

it.effect("a group's note names its lead only as the router of requests that mention no one", () =>
  Effect.gen(function* () {
    const directory = yield* Directory.AssistantDirectory;
    yield* seed("ann");
    yield* seed("bo");
    yield* teamRow("t1", ["ann", "bo"], "bo");
    const ann = Option.getOrThrow(yield* directory.forThread(thread("ann"))).assistant;
    const [membership] = yield* directory.teamsOf(ann);
    assert.deepEqual(
      [membership?.team.name, membership?.lead?.handle, membership?.teammates.map((m) => m.handle)],
      ["Team t1", "bo", ["bo"]],
    );
    const note = yield* assistantNote(Option.some(directory), thread("ann"), "hello");
    assert.include(note, "BO routes group requests that mention no one.");
    const leadNote = yield* assistantNote(Option.some(directory), thread("bo"), "hello");
    assert.include(leadNote, "You route group requests that mention no one.");
    assert.notInclude(note, "report");
  }).pipe(Effect.provide(directoryLayer)),
);

it.effect(
  "a member's hidden group thread resolves to the member, and archived groups drop out of its note",
  () =>
    Effect.gen(function* () {
      const directory = yield* Directory.AssistantDirectory;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("ann");
      yield* seed("bo");
      yield* teamRow("t1", ["ann", "bo"]);
      yield* teamRow("t2", ["ann", "bo"]);
      yield* sql`UPDATE assistant_teams SET archived_at = 'now' WHERE team_id = 't2'`;
      // Sandbox, runtime policy, note and connectors all start from this answer.
      const group = ThreadId.make("assistant:ann:g-0123456789abcdef");
      const found = Option.getOrThrow(yield* directory.forThread(group));
      assert.deepEqual([found.assistant.handle, found.current], ["ann", false]);
      const ann = found.assistant;
      assert.deepEqual(
        (yield* directory.teamsOf(ann)).map((membership) => membership.team.name),
        ["Team t1"],
      );
    }).pipe(Effect.provide(directoryLayer)),
);

it.effect("a project assistant works in its own projects plus its active groups' ones", () =>
  Effect.gen(function* () {
    const directory = yield* Directory.AssistantDirectory;
    const sql = yield* SqlClient.SqlClient;
    const scoped = (id: string, projects: ReadonlyArray<string>) =>
      sql`UPDATE assistants SET scope = 'project', project_ids_json = ${JSON.stringify(projects)}
        WHERE assistant_id = ${id}`;
    const groupProjects = (id: string, projects: ReadonlyArray<string>) =>
      sql`UPDATE assistant_teams SET project_ids_json = ${JSON.stringify(projects)} WHERE team_id = ${id}`;
    yield* seed("ann");
    yield* seed("bo");
    yield* seed("cy");
    yield* seed("jarvis");
    yield* scoped("ann", ["p1", "own"]);
    yield* scoped("bo", ["p1"]);
    yield* scoped("cy", ["p1"]);
    yield* teamRow("dev", ["ann", "bo", "jarvis"]);
    yield* teamRow("old", ["ann"]);
    yield* groupProjects("dev", ["new", "own"]);
    yield* groupProjects("old", ["archived-only"]);
    yield* sql`UPDATE assistant_teams SET archived_at = 'now' WHERE team_id = 'old'`;
    const effective = (handle: string) =>
      Effect.gen(function* () {
        const found = Option.getOrThrow(yield* directory.forThread(thread(handle)));
        const projectIds: ReadonlyArray<string> = yield* effectiveProjectIdsOf(
          directory,
          found.assistant,
        );
        return projectIds;
      });
    assert.deepEqual(yield* effective("ann"), ["p1", "own", "new"]);
    assert.deepEqual(yield* effective("bo"), ["p1", "new", "own"]);
    assert.deepEqual(yield* effective("cy"), ["p1"]);
    // Scope "all" reaches everything already.
    assert.deepEqual(yield* effective("jarvis"), []);
    // Taking a project from the group keeps a member's own access to it.
    yield* groupProjects("dev", ["new"]);
    assert.deepEqual(yield* effective("ann"), ["p1", "own", "new"]);
    assert.deepEqual(yield* effective("bo"), ["p1", "new"]);
    // A member who joins later gets the group's projects with no other write.
    yield* sql`UPDATE assistant_teams SET member_ids_json = '["ann","bo","jarvis","cy"]' WHERE team_id = 'dev'`;
    assert.deepEqual(yield* effective("cy"), ["p1", "new"]);

    const refusal = (
      handle: string,
      input: { projectId?: ProjectId; delegate?: boolean; elsewhere?: boolean },
    ) =>
      projectScopeRefusal(Option.some(directory), {
        threadId: thread(handle),
        ...input,
      }).pipe(Effect.map(Option.getOrNull));
    const P = ProjectId.make;
    // Allowed through the group, refused outside the effective list.
    assert.isNull(yield* refusal("cy", { projectId: P("new") }));
    assert.include(
      yield* refusal("cy", { projectId: P("archived-only") }),
      "projects on your list",
    );
    // One project: omitting it means home; several: it must be named.
    yield* scoped("cy", ["p1"]);
    yield* sql`UPDATE assistant_teams SET member_ids_json = '["ann"]' WHERE team_id = 'dev'`;
    assert.isNull(yield* refusal("cy", {}));
    assert.isNull(yield* refusal("cy", { delegate: true }));
    assert.include(yield* refusal("ann", {}), "You work in several projects: p1, own, new.");
    assert.include(yield* refusal("ann", { delegate: true }), "t3_thread_launch");
    assert.include(
      yield* refusal("ann", { projectId: P("p1"), delegate: true }),
      "t3_thread_launch",
    );
    assert.isNull(yield* refusal("ann", { projectId: P("new") }));
    assert.include(
      yield* refusal("ann", { projectId: P("new"), elsewhere: true }),
      "projects on your list",
    );
    // A member's hidden group thread is held the same way.
    const groupThread = ThreadId.make("assistant:ann:g-0123456789abcdef");
    assert.include(
      Option.getOrNull(
        yield* projectScopeRefusal(Option.some(directory), { threadId: groupThread }),
      ),
      "several projects",
    );

    const note = yield* assistantNote(Option.some(directory), thread("ann"), "hello");
    assert.include(note, "You work in: p1, own, new. If the request does not make clear which one");
    assert.include(note, "The group works in: new.");
  }).pipe(Effect.provide(directoryLayer)),
);
