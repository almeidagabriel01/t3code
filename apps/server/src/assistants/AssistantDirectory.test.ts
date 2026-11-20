import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { waitWakeId } from "../autonomy/needsYou.ts";
import { assistantNote, SETTLED_WAIT_RUN_WINDOW, settledWaitsForTurn } from "./assistantNote.ts";
import * as Directory from "./AssistantDirectory.ts";
import {
  effectiveProjectIdsOf,
  HOST_CONTAINER_NOTE_LINE,
  projectScopeRefusal,
} from "./AssistantSandboxPolicy.ts";

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

it.effect(
  "a wait settled after its notice was read rides once with the next turn, and no other wait does",
  () =>
    Effect.gen(function* () {
      const directory = Option.some(yield* Directory.AssistantDirectory);
      const sql = yield* SqlClient.SqlClient;
      const jarvis = ThreadId.make("assistant:jarvis:1");
      const at = (minute: number) => `2026-01-02T00:${String(minute).padStart(2, "0")}:00.000Z`;
      const request = (id: string, status: string, resolvedAt: string | null, kind = "command") =>
        sql`
          INSERT INTO orchestration_v2_projection_runtime_requests
            (runtime_request_id, thread_id, node_id, kind, status, created_at, resolved_at, payload_json)
          VALUES (${id}, 'thread-task', 'n1', ${kind}, ${status}, ${at(0)}, ${resolvedAt}, '{}')`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json)
        VALUES ('thread-task', 'p1', 'Queue limits', 'claudeAgent', 'full-access', 'default',
          ${at(0)}, ${at(0)}, '{}')`;
      // Read at 01 and settled at 06, after the turn that began at 05.
      yield* request("r-after", "resolved", at(6));
      // Settled at 03: the turn that began at 04 carried it, so the one at 05 does not.
      yield* request("r-earlier", "resolved", at(3), "user_input");
      yield* request("r-open", "pending", null);
      // Its notice was still queued when it settled, so it was taken back unread.
      yield* request("r-queued", "cancelled", at(4));
      yield* sql`
        INSERT INTO decisions
          (decision_id, from_thread_id, project_id, client_request_id, thread_title, title, context,
            options_json, status, answered_at, created_at)
        VALUES ('d-done', 'thread-task', 'p1', 'ask:1', 'Queue limits', 'Ship the toggle?', '',
          '[]', 'answered', ${at(7)}, ${at(0)})`;
      const wake = (ordinal: number, key: string, startedAt: string | null) => ({
        ordinal,
        userMessageId: waitWakeId(jarvis, key),
        startedAt: startedAt === null ? null : DateTime.makeUnsafe(startedAt),
      });
      const runs = [
        wake(1, "request:r-after", at(1)),
        wake(2, "request:r-earlier", at(2)),
        wake(3, "request:r-open", at(2)),
        wake(4, "request:r-queued", null),
        wake(5, "decision:d-done", at(4)),
        { ordinal: 6, userMessageId: "m-user", startedAt: DateTime.makeUnsafe(at(5)) },
      ] as never;
      const note = yield* settledWaitsForTurn(directory, runs, { ordinal: 7 }, "status?");
      assert.include(note, "<t3_settled_waits>");
      assert.include(note, "- the command approval in [Queue limits](");
      assert.include(note, '- the decision "Ship the toggle?" in [Queue limits](');
      assert.lengthOf(note.match(/^- /gm) ?? [], 2);
      assert.notInclude(note, "question");
      const earlier = yield* settledWaitsForTurn(directory, runs, { ordinal: 5 }, "hi");
      assert.include(earlier, "- the question in [Queue limits](");
      assert.strictEqual(
        yield* settledWaitsForTurn(directory, runs, { ordinal: 7 }, "/compact"),
        "",
      );
      // r-after settled after these turns began, but its wake is older than the window.
      const later = Array.from({ length: SETTLED_WAIT_RUN_WINDOW }, (_, index) => ({
        ordinal: index + 2,
        userMessageId: `m-${index}`,
        startedAt: DateTime.makeUnsafe(at(5)),
      }));
      assert.strictEqual(
        yield* settledWaitsForTurn(
          directory,
          [runs[0], ...later] as never,
          { ordinal: SETTLED_WAIT_RUN_WINDOW + 2 },
          "status?",
        ),
        "",
      );
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

it.effect("a member's group conversation reaches its own projects and that group's only", () =>
  Effect.gen(function* () {
    const directory = yield* Directory.AssistantDirectory;
    const sql = yield* SqlClient.SqlClient;
    yield* seed("ann");
    yield* sql`UPDATE assistants SET scope = 'project', project_ids_json = '["p1"]'
      WHERE assistant_id = 'ann'`;
    yield* teamRow("site", ["ann"]);
    yield* teamRow("app", ["ann"]);
    yield* sql`UPDATE assistant_teams SET project_ids_json = '["web"]' WHERE team_id = 'site'`;
    yield* sql`UPDATE assistant_teams SET project_ids_json = '["mobile"]' WHERE team_id = 'app'`;
    const siteRequest = ThreadId.make("assistant:ann:g-1111111111111111");
    const appChat = ThreadId.make("assistant:ann:g-2222222222222222");
    // A request conversation of one group, and an older group-wide one of the other.
    yield* sql`INSERT INTO assistant_group_request_threads
      (request_id, assistant_id, team_id, thread_id) VALUES ('r1', 'ann', 'site', ${siteRequest})`;
    yield* sql`INSERT INTO assistant_group_threads (team_id, assistant_id, thread_id)
      VALUES ('app', 'ann', ${appChat})`;
    const refused = (threadId: ThreadId, projectId: string) =>
      projectScopeRefusal(Option.some(directory), {
        threadId,
        projectId: ProjectId.make(projectId),
      }).pipe(Effect.map(Option.isSome));
    const reach = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const allowed: string[] = [];
        for (const id of ["p1", "web", "mobile"]) {
          if (!(yield* refused(threadId, id))) allowed.push(id);
        }
        return allowed;
      });
    assert.deepEqual(yield* reach(siteRequest), ["p1", "web"]);
    assert.deepEqual(yield* reach(appChat), ["p1", "mobile"]);
    // Outside a group nothing changes: the assistant's own thread reaches every group's projects.
    assert.deepEqual(yield* reach(thread("ann")), ["p1", "web", "mobile"]);
    // A group thread no group holds any more (cleared chat, deleted group) keeps its own projects.
    assert.deepEqual(yield* reach(ThreadId.make("assistant:ann:g-3333333333333333")), ["p1"]);
    yield* sql`UPDATE assistant_teams SET archived_at = 'now' WHERE team_id = 'site'`;
    assert.deepEqual(yield* reach(siteRequest), ["p1"]);
    yield* sql`UPDATE assistant_teams SET archived_at = NULL WHERE team_id = 'site'`;
    // A member taken out of the group loses its projects even while the thread row lingers.
    yield* sql`UPDATE assistant_teams SET member_ids_json = '[]' WHERE team_id = 'site'`;
    assert.deepEqual(yield* reach(siteRequest), ["p1"]);
    yield* sql`UPDATE assistant_teams SET member_ids_json = '["ann"]' WHERE team_id = 'site'`;
    // The note and memory read the same list the refusal checks.
    const note = yield* assistantNote(Option.some(directory), siteRequest, "hello");
    assert.include(note, "You work in: p1, web.");
  }).pipe(Effect.provide(directoryLayer)),
);

it.effect("the note says where launches run by default, by the rule launches follow", () => {
  const links = { enabled: true };
  const layer = Layer.mergeAll(
    directoryLayer,
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.sync(() => ({ linkedEnvironmentsEnabled: links.enabled }) as never),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-self")),
    }),
  );
  return Effect.gen(function* () {
    const directory = Option.some(yield* Directory.AssistantDirectory);
    const sql = yield* SqlClient.SqlClient;
    yield* seed("ann");
    yield* teamRow("t1", ["ann"]);
    const groupThread = ThreadId.make("assistant:ann:g-1111111111111111");
    yield* sql`INSERT INTO assistant_group_threads (team_id, assistant_id, thread_id)
      VALUES ('t1', 'ann', ${groupThread})`;
    yield* sql`INSERT INTO peer_environment_links
      (environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
      VALUES ('env-devbox', 's', 'devbox', '[]', 'full-access', 't', 't')`;
    const here = HOST_CONTAINER_NOTE_LINE;
    const on = (where: string) => `Work you launch runs on ${where} by default.`;
    const cases: ReadonlyArray<{
      readonly own: string | null;
      readonly group?: string;
      readonly scope?: string;
      readonly enabled?: boolean;
      readonly thread?: ThreadId;
      readonly line: string;
    }> = [
      { own: null, line: here },
      { own: "local", line: here },
      { own: "env-self", line: here },
      { own: "env-devbox", line: on("devbox") },
      { own: "auto", line: on("the least loaded environment") },
      { own: "env-gone", line: on("env-gone") },
      { own: "env-devbox", enabled: false, line: here },
      { own: "env-devbox", scope: "project", line: here },
      // A group's default wins in its own threads only.
      {
        own: "env-devbox",
        group: "auto",
        thread: groupThread,
        line: on("the least loaded environment"),
      },
      { own: "env-devbox", group: "auto", line: on("devbox") },
      { own: null, group: "local", thread: groupThread, line: here },
    ];
    for (const entry of cases) {
      links.enabled = entry.enabled ?? true;
      yield* sql`UPDATE assistants SET default_environment = ${entry.own},
        scope = ${entry.scope ?? null}, project_ids_json = '["p1"]' WHERE assistant_id = 'ann'`;
      yield* sql`UPDATE assistant_teams SET default_environment = ${entry.group ?? null}`;
      const note = yield* assistantNote(directory, entry.thread ?? thread("ann"), "hi");
      assert.include(note, entry.line, JSON.stringify(entry));
      if (entry.line !== here) assert.notInclude(note, "everything else runs here");
    }
  }).pipe(Effect.provide(layer));
});

it.effect("open tasks leave out dismissed ones and read the latest run's status", () =>
  Effect.gen(function* () {
    const directory = yield* Directory.AssistantDirectory;
    const sql = yield* SqlClient.SqlClient;
    yield* seed("jarvis");
    const task = (id: string, dismissed: string | null) => sql`
      INSERT INTO assistant_tasks (thread_id, assistant_id, project_id, title, created_at, dismissed_at)
      VALUES (${id}, 'jarvis', 'p1', ${`Title ${id}`}, '2026-01-01', ${dismissed})`;
    yield* task("t-open", null);
    yield* task("t-done", "2026-01-02");
    const run = (id: string, ordinal: number, status: string) => sql`
      INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${id}, 't-open', ${ordinal}, 'codex', ${status}, '2026-01-01', '{}')`;
    yield* run("r1", 1, "completed");
    yield* run("r2", 2, "running");
    assert.deepEqual(yield* directory.openTasks!(thread("jarvis")), [
      { threadId: "t-open", title: "Title t-open", status: "running" },
    ]);
  }).pipe(Effect.provide(directoryLayer)),
);
