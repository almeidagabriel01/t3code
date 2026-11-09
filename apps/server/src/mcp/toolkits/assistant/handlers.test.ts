import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type Assistant,
  type AssistantTeam,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationV2ThreadShell,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AssistantGroups from "../../../assistants/AssistantGroups.ts";
import * as AssistantService from "../../../assistants/AssistantService.ts";
import * as DecisionService from "../../../decisions/DecisionService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as AssistantHandlers from "./handlers.ts";
import { AssistantToolkit, type AssistantParameters } from "./tools.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const home = ProjectId.make("home");

const assistant = (id: string, extra: Partial<Assistant>) =>
  ({
    id,
    handle: id,
    name: id.toUpperCase(),
    projectId: "p1",
    threadId: `assistant:${id}:1`,
    toolAccess: "full",
    role: "",
    mcpServers: [],
    avatar: null,
    scope: "all",
    archivedAt: null,
    ...extra,
  }) as unknown as Assistant;

/** An in-memory AssistantService that records every write the tool makes. */
const assistantsMock = () => {
  const rows: Array<Assistant> = [
    assistant("ceo", {
      role: "CEO",
      askBeforeActing: true,
      workspace: "sandbox",
      icon: "scout",
      mcpServers: [
        {
          name: "docs",
          transport: "http",
          enabled: true,
          args: [],
          env: [],
          headers: [{ key: "A", hasValue: true }],
        },
      ],
    }),
    assistant("eng", { role: "Engineer", toolAccess: "read-only" }),
    assistant("gone", { archivedAt: "2026-01-01T00:00:00.000Z" }),
  ];
  const teams: Array<AssistantTeam> = [
    {
      id: "t1",
      name: "Core",
      memberIds: ["ceo", "eng"],
      leadId: "ceo",
    } as never,
  ];
  const writes: Array<unknown> = [];
  const layer = Layer.mock(AssistantService.AssistantService)({
    list: Effect.sync(() => [...rows]),
    teams: Effect.sync(() => [...teams]),
    create: (input, options) =>
      Effect.sync(() => {
        const id = options?.id ?? "random";
        let made = rows.find((row) => row.id === id);
        if (made === undefined) {
          writes.push({ create: input });
          made = assistant(id, { ...input, handle: input.name.toLowerCase() } as never);
          rows.push(made);
        }
        return made;
      }),
    update: (input) =>
      Effect.sync(() => {
        writes.push({ update: input });
        const index = rows.findIndex((row) => row.id === input.assistantId);
        const next = {
          ...rows[index]!,
          ...input,
          archivedAt: input.archived ? "now" : null,
        } as unknown as Assistant;
        rows[index] = next;
        return next;
      }),
    createTeam: (input, options) =>
      Effect.sync(() => {
        const existing = teams.find((team) => team.id === options?.id);
        if (existing !== undefined) return existing;
        const team = {
          ...input,
          id: options?.id ?? "t",
          leadId: input.leadId ?? null,
        } as never;
        writes.push({ createTeam: input });
        teams.push(team);
        return team;
      }),
    updateTeam: (input) =>
      Effect.sync(() => {
        writes.push({ updateTeam: input });
        const index = teams.findIndex((team) => team.id === input.teamId);
        teams[index] = { ...teams[index]!, ...input } as never;
        return teams[index]!;
      }),
  });
  return { layer, writes };
};

const harness = (
  callerMode: RuntimeMode,
  startedBy: Record<string, unknown> = { id: "m-user", createdBy: "user" },
) =>
  Effect.gen(function* () {
    const { layer, writes } = assistantsMock();
    const threadId = ThreadId.make("thread-1");
    const announced: Array<{ text: string; clientRequestId: string }> = [];
    const posts: Array<Parameters<AssistantGroups.AssistantGroups["Service"]["agentPost"]>[0]> = [];
    const deps = Layer.succeedContext(
      yield* Layer.build(
        Layer.mergeAll(
          NodeCrypto.layer,
          layer,
          Layer.succeed(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("environment"),
            requestNamespace: "thread:test",
            thread: { threadId, providerSessionId: "session", providerInstanceId },
            client: undefined,
            issuedAt: 0,
            capabilities: new Set(["orchestration" as const]),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed({
                id,
                projectId: home,
                title: "Planner",
                deletedAt: null,
                archivedAt: null,
                activeRunId: "run-1",
                providerInstanceId,
                runtimeMode: callerMode,
                interactionMode: "default",
              } as unknown as OrchestrationV2ThreadShell),
            sendToThread: () => Effect.succeed({} as never),
            getThreadRecords: () =>
              Effect.succeed({
                runs: [{ id: "run-1", userMessageId: startedBy.id }],
                messages: [startedBy],
              } as never),
          }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            ensureAssistantProject: Effect.succeed({ projectId: home }),
            namedProjectsRoot: "",
          }),
          Layer.mock(AssistantGroups.AssistantGroups)({
            member: {} as AssistantGroups.AssistantGroups["Service"]["member"],
            announce: (input) =>
              Effect.sync(() => {
                announced.push({ text: input.text, clientRequestId: input.clientRequestId });
              }),
            agentPost: (input) => {
              posts.push(input);
              return Effect.succeed({
                message: { id: "m-1" },
                tasks: [{ id: "t-1", ownerId: "eng", status: "queued" }],
              } as never);
            },
          }),
        ).pipe(
          Layer.provideMerge(
            DecisionService.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  SqlitePersistence.layerMemory,
                  NodeCrypto.layer,
                  Layer.mock(ThreadManagement.ThreadManagementService)({
                    sendToThread: () => Effect.succeed({} as never),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    const toolkit = yield* AssistantToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(AssistantHandlers.layer).pipe(Layer.provide(deps)),
      ),
    );
    const call = (input: AssistantParameters) =>
      toolkit.handle("t3_assistant", input).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1)?.result as Record<string, any>),
        Effect.provide(deps),
      );
    const decisions = yield* DecisionService.DecisionService.pipe(Effect.provide(deps));
    return { call, writes, decisions, posts, announced };
  });

it.effect("list and read give each assistant its role and its groups' lead by handle", () =>
  Effect.gen(function* () {
    const { call } = yield* harness("full-access");
    const listed = yield* call({ action: "list" });
    expect(listed.assistants[0]).toMatchObject({
      handle: "ceo",
      role: "CEO",
      askBeforeActing: true,
      workspace: "sandbox",
      icon: "scout",
      avatar: null,
      scope: "all",
      connectors: [{ name: "docs", transport: "http", enabled: true }],
      teams: [{ name: "Core", members: ["ceo", "eng"], lead: "ceo" }],
    });
    expect(JSON.stringify(listed)).not.toContain("hasValue");
    expect(yield* call({ action: "read", handle: "@ENG" })).toMatchObject({
      role: "Engineer",
    });
    expect(yield* call({ action: "read" })).toMatchObject({ code: "invalid_request" });
    expect(yield* call({ action: "read", handle: "nobody" })).toMatchObject({
      code: "invalid_request",
    });
  }),
);

it.effect(
  "create at or below the caller's level is made at once, once, however often it repeats",
  () =>
    Effect.gen(function* () {
      const { call, writes } = yield* harness("auto-accept-edits");
      const input = {
        action: "create",
        name: "Scribe",
        instructions: "Write.",
        toolAccess: "workspace-write",
        avatarHue: 120,
        clientRequestId: "c1",
      } as const;
      const first = yield* call(input);
      expect(first).toMatchObject({ status: "created", assistant: { handle: "scribe" } });
      expect(yield* call(input)).toEqual(first);
      expect(writes).toEqual([
        {
          create: expect.objectContaining({
            projectId: home,
            toolAccess: "workspace-write",
            avatar: { kind: "robot", hue: 120 },
          }),
        },
      ]);
      // A lower level than the caller's is as good.
      expect(
        yield* call({ ...input, name: "Reader", toolAccess: "read-only", clientRequestId: "c2" }),
      ).toMatchObject({
        status: "created",
      });
    }),
);

it.effect("create without a toolAccess is refused so the agent asks the user", () =>
  Effect.gen(function* () {
    const { call, writes } = yield* harness("full-access");
    const refused = yield* call({ action: "create", name: "X", instructions: "" });
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect(refused.message).toContain("Ask the user");
    expect(writes).toEqual([]);
  }),
);

it.effect("create above the caller's level waits for approval, then is made once", () =>
  Effect.gen(function* () {
    const { call, writes, decisions } = yield* harness("auto-accept-edits");
    const input = {
      action: "create",
      name: "Boss",
      instructions: "Run things.",
      toolAccess: "full",
      clientRequestId: "up",
    } as const;
    const pending = yield* call(input);
    expect(pending).toMatchObject({ status: "pending_approval" });
    expect(yield* call(input)).toEqual(pending);
    expect(writes).toEqual([]);

    yield* decisions.answer({ decisionId: pending.decisionId, optionId: "accept" });
    const made = yield* call(input);
    expect(made).toMatchObject({ status: "created", assistant: { toolAccess: "full" } });
    expect(yield* call(input)).toEqual(made);
    expect(writes).toHaveLength(1);

    // A decline is final for that call.
    const other = { ...input, name: "Nope", clientRequestId: "no" };
    const declined = yield* call(other);
    yield* decisions.answer({ decisionId: declined.decisionId, optionId: "deny" });
    expect(yield* call(other)).toMatchObject({ code: "invalid_request" });
    expect(writes).toHaveLength(1);
  }),
);

it.effect("update and archive: steering an assistant above the caller needs approval", () =>
  Effect.gen(function* () {
    const { call, writes, decisions } = yield* harness("auto-accept-edits");
    // "ceo" is full-access, above the caller: not editable without the user.
    const steer = {
      action: "update",
      handle: "ceo",
      instructions: "New orders",
      clientRequestId: "u1",
    } as const;
    const pending = yield* call(steer);
    expect(pending).toMatchObject({ status: "pending_approval" });
    expect(writes).toEqual([]);
    yield* decisions.answer({ decisionId: pending.decisionId, optionId: "accept" });
    expect(yield* call(steer)).toMatchObject({ status: "updated" });
    // "eng" is read-only: the caller may edit it, but not raise it past its own level.
    expect(yield* call({ action: "update", handle: "eng", role: "QA" })).toMatchObject({
      status: "updated",
    });
    expect(
      yield* call({ action: "update", handle: "eng", toolAccess: "full", clientRequestId: "u2" }),
    ).toMatchObject({ status: "pending_approval" });
    expect(yield* call({ action: "archive", handle: "eng" })).toMatchObject({ status: "archived" });
    expect(writes.at(-1)).toEqual({ update: expect.objectContaining({ archived: true }) });
  }),
);

it.effect("groups: created empty, members added and removed, only active assistants join", () =>
  Effect.gen(function* () {
    const { call, writes } = yield* harness("approval-required");
    const empty = yield* call({ action: "group_create", name: "Ops", clientRequestId: "g1" });
    expect(empty).toMatchObject({ status: "created", group: { name: "Ops", members: [] } });
    expect(yield* call({ action: "group_create", name: "Ops", clientRequestId: "g1" })).toEqual(
      empty,
    );
    expect(writes).toHaveLength(1);

    const grown = yield* call({
      action: "group_update",
      group: "ops",
      addMembers: ["ceo", "@eng"],
      lead: "ceo",
    });
    expect(grown.group).toMatchObject({ members: ["ceo", "eng"], lead: "ceo" });
    const shrunk = yield* call({ action: "group_update", group: "Ops", removeMembers: ["eng"] });
    expect(shrunk.group.members).toEqual(["ceo"]);
    expect(
      (yield* call({ action: "group_update", group: "Ops", members: ["eng"], name: "Ops 2" }))
        .group,
    ).toMatchObject({ name: "Ops 2", members: ["eng"] });

    expect(
      yield* call({ action: "group_update", group: "Ops 2", addMembers: ["gone"] }),
    ).toMatchObject({
      code: "invalid_request",
      message: "@gone is archived.",
    });
    expect(yield* call({ action: "group_create", name: "Bad", members: ["nobody"] })).toMatchObject(
      {
        code: "invalid_request",
      },
    );
    expect(yield* call({ action: "group_update", group: "ghost" })).toMatchObject({
      code: "invalid_request",
    });
  }),
);

it.effect("group_post posts from the calling conversation and needs a group and a text", () =>
  Effect.gen(function* () {
    const { call, posts } = yield* harness("approval-required");
    expect(
      yield* call({
        action: "group_post",
        group: " Ops ",
        text: " @eng ship it ",
        paths: ["/home/user/a.txt"],
      }),
    ).toEqual({
      status: "posted",
      messageId: "m-1",
      tasks: [{ taskId: "t-1", owner: "eng", status: "queued" }],
      next: expect.stringContaining("group chat"),
    });
    expect(posts).toEqual([
      expect.objectContaining({
        callerThreadId: "thread-1",
        group: "Ops",
        text: "@eng ship it",
        paths: ["/home/user/a.txt"],
      }),
    ]);
    // A repeat of the same call carries the same request id, so the service posts it once.
    yield* call({
      action: "group_post",
      group: " Ops ",
      text: " @eng ship it ",
      paths: ["/home/user/a.txt"],
    });
    expect(posts[1]!.clientRequestId).toBe(posts[0]!.clientRequestId);
    expect(yield* call({ action: "group_post", text: "hi" })).toMatchObject({
      code: "invalid_request",
      message: "group_post needs `group`: the group's name or id.",
    });
    expect(yield* call({ action: "group_post", group: "Ops" })).toMatchObject({
      code: "invalid_request",
      message: "group_post needs `text`: the complete request.",
    });
  }),
);

it.effect("a group change leaves one chat line per change, and a repeat leaves none", () =>
  Effect.gen(function* () {
    const { call, announced } = yield* harness("approval-required");
    yield* call({ action: "group_create", name: "Ops", members: ["ceo"], clientRequestId: "g1" });
    yield* call({
      action: "group_update",
      group: "Core",
      name: "Core 2",
      removeMembers: ["eng"],
      lead: null,
    });
    expect(announced.map((line) => line.text)).toEqual([
      'created the group "Ops" with CEO',
      'renamed the group to "Core 2"',
      "removed ENG",
      "removed the group's lead",
    ]);
    expect(new Set(announced.map((line) => line.clientRequestId)).size).toBe(4);
  }),
);

it.effect("a group change is refused unless the turn came from the user", () =>
  Effect.gen(function* () {
    const refusals = [
      [{ id: "m1", createdBy: "agent", senderThreadId: "assistant:eng:1" }, "another assistant"],
      [{ id: "assistant-reply:r1", createdBy: "agent" }, "another assistant"],
      [{ id: "m2", createdBy: "user", scheduledTaskId: "task-1" }, "a scheduled task"],
      [{ id: "group-task:t:1", createdBy: "system" }, "a group task"],
      [{ id: "autonomy-wake:k", createdBy: "user" }, "an automatic message"],
      [{ id: "m3", createdBy: "user", notification: { summary: "x" } }, "an automatic message"],
    ] as const;
    for (const [startedBy, label] of refusals) {
      const { call, writes, announced } = yield* harness("approval-required", startedBy);
      for (const input of [
        { action: "group_create", name: "Ops" },
        { action: "group_update", group: "Core", name: "New" },
      ] as const) {
        expect(yield* call(input)).toMatchObject({
          code: "capability_denied",
          message: expect.stringContaining(`this turn came from ${label}`),
        });
      }
      // Reads, group_post and assistant changes are not group changes.
      expect(yield* call({ action: "list" })).toHaveProperty("assistants");
      expect(writes).toEqual([]);
      expect(announced).toEqual([]);
    }
  }),
);

it.effect("a user turn, including a channel or decision answer, may change a group", () =>
  Effect.gen(function* () {
    for (const startedBy of [
      { id: "m1", createdBy: "user", creationSource: "web" },
      { id: "decision-answer:d1", createdBy: "user", creationSource: "server" },
    ]) {
      const { call, announced } = yield* harness("approval-required", startedBy);
      expect(yield* call({ action: "group_create", name: "Ops" })).toMatchObject({
        status: "created",
      });
      expect(announced).toHaveLength(1);
    }
  }),
);
