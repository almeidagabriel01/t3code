import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type Assistant,
  AssistantError,
  AutonomyError,
  DEFAULT_ASSISTANT_AUTONOMY,
  type AssistantTeam,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AssistantGroups from "../../../assistants/AssistantGroups.ts";
import * as AssistantSandboxControl from "../../../assistants/AssistantSandboxControl.ts";
import * as AssistantService from "../../../assistants/AssistantService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as RemoteDelegation from "../../../peer/RemoteDelegation.ts";
import { PROVIDER_UNAUTHENTICATED } from "../../OrchestratorMcpService.ts";
import * as DecisionService from "../../../decisions/DecisionService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as AutonomyService from "../../../autonomy/AutonomyService.ts";
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
    projectIds: [],
    threadId: `assistant:${id}:1`,
    toolAccess: "full",
    role: "",
    mcpServers: [],
    avatar: null,
    scope: "all",
    archivedAt: null,
    autonomy: DEFAULT_ASSISTANT_AUTONOMY,
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
  const taskRows = new Map<string, { title: string; status: string; dismissedAt: string | null }>([
    ["task-done", { title: "Ship it", status: "done", dismissedAt: null }],
    ["task-run", { title: "Still going", status: "running", dismissedAt: null }],
  ]);
  const setTask = (threadId: string, dismissed: boolean) =>
    Effect.suspend(() => {
      const row = taskRows.get(threadId);
      if (row === undefined)
        return Effect.fail(new AssistantError({ reason: "not_found", message: "No such task." }));
      if (dismissed && row.status === "running") {
        return Effect.fail(
          new AssistantError({
            reason: "invalid",
            message: "A running task cannot be dismissed. Stop it first.",
          }),
        );
      }
      if ((row.dismissedAt !== null) !== dismissed) {
        row.dismissedAt = dismissed ? "now" : null;
        writes.push({ task: threadId, dismissed });
      }
      return Effect.succeed({ threadId, dismissedAt: row.dismissedAt } as never);
    });
  const layer = Layer.mock(AssistantService.AssistantService)({
    tasksOf: (assistantId) =>
      Effect.succeed({
        tasks:
          assistantId === "ceo"
            ? [...taskRows].map(([threadId, row]) => ({
                threadId,
                title: row.title,
                status: row.status,
                dismissed: row.dismissedAt !== null,
              }))
            : [],
        truncated: assistantId === "ceo" && taskRows.size > 2,
      }) as never,
    dismissTask: (threadId) => setTask(threadId, true),
    restoreTask: (threadId) => setTask(threadId, false),
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

const sandboxId = EnvironmentId.make("environment-sandbox");

/** The container and the delegation, as far as the tool can tell. */
const containerWorld = () => ({
  config: { cpus: null as number | null, chosen: false, whenDone: "discard", oneOff: false },
  status: { state: "running", environmentId: sandboxId as EnvironmentId | null, error: null } as {
    state: string;
    environmentId: EnvironmentId | null;
    error: string | null;
  },
  configured: [] as Array<unknown>,
  delegated: [] as Array<{ input: any; options: unknown }>,
  discardError: null as string | null,
  discards: 0,
  /** Why the delegation fails, as RemoteDelegation says it. */
  delegateError: null as string | null,
  github: "signed_out" as "signed_out" | "signed_in",
  /** What `orchestrator_capabilities` in the container lists. */
  providers: [] as Array<{
    providerInstanceId: string;
    displayName: string | null;
    canRunChildTask: boolean;
    constraints: Array<string>;
  }>,
});

const harness = (
  callerMode: RuntimeMode,
  startedBy: Record<string, unknown> = { id: "m-user", createdBy: "user" },
  callerThread = "thread-1",
) =>
  Effect.gen(function* () {
    const { layer, writes } = assistantsMock();
    const container = containerWorld();
    const threadId = ThreadId.make(callerThread);
    const announced: Array<{ text: string; clientRequestId: string }> = [];
    const posts: Array<Parameters<AssistantGroups.AssistantGroups["Service"]["agentPost"]>[0]> = [];
    const notified: Array<Parameters<AutonomyService.AutonomyService["Service"]["notifyUser"]>[0]> =
      [];
    const deps = Layer.succeedContext(
      yield* Layer.build(
        Layer.mergeAll(
          NodeCrypto.layer,
          layer,
          Layer.mock(AssistantSandboxControl.AssistantSandboxControl)({
            config: Effect.sync(() => container.config as never),
            configure: (input) =>
              Effect.sync(() => {
                container.configured.push(input);
                container.config = {
                  ...container.config,
                  cpus: input.cpus ?? container.config.cpus,
                  chosen: true,
                };
                return {} as never;
              }),
            startForTask: Effect.sync(() => container.status as never),
            status: Effect.sync(() => ({ github: { state: container.github } }) as never),
            holding: (effect) => effect,
            discard: Effect.suspend(() => {
              if (container.discardError !== null) {
                return Effect.fail(
                  new AssistantError({ reason: "invalid", message: container.discardError }),
                );
              }
              container.discards += 1;
              return Effect.succeed({ state: "not_created" } as never);
            }),
          }),
          Layer.mock(PeerForwarding.PeerForwarding)({
            call: (_scope, tool, environmentId) =>
              tool.name === "orchestrator_capabilities" && environmentId === sandboxId
                ? Effect.sync(() => ({ providers: container.providers }) as never)
                : Effect.die(`unexpected ${tool.name}`),
          }),
          Layer.mock(RemoteDelegation.RemoteDelegation)({
            delegate: (_scope, input, options) =>
              Effect.suspend(() => {
                if (container.delegateError !== null) {
                  return Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: container.delegateError,
                    }),
                  );
                }
                container.delegated.push({ input, options });
                return Effect.succeed({ taskId: "task-1" as never });
              }),
          }),
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
                modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
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
          Layer.mock(AutonomyService.AutonomyService)({
            notifyUser: (input) =>
              Effect.suspend(() => {
                if (input.text.includes("paused")) {
                  return Effect.fail(
                    new AutonomyError({ reason: "invalid", message: "notifications are paused" }),
                  );
                }
                const first = !notified.some((call) => call.key === input.key);
                notified.push(input);
                return Effect.succeed({
                  status: first ? ("sent" as const) : ("already_sent" as const),
                  channels: first ? ["activity", "telegram"] : [],
                  remainingToday: 19,
                });
              }),
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
    return { call, writes, decisions, posts, announced, container, notified };
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

it.effect("read lists the assistant's tasks; task_dismiss and task_restore are retry-safe", () =>
  Effect.gen(function* () {
    const { call, writes } = yield* harness("full-access");
    expect(yield* call({ action: "read", handle: "eng" })).toMatchObject({ tasks: [] });
    const read = yield* call({ action: "read", handle: "ceo" });
    expect(read.tasks).toEqual([
      { threadId: "task-done", title: "Ship it", status: "done", dismissed: false },
      { threadId: "task-run", title: "Still going", status: "running", dismissed: false },
    ]);
    expect(read.tasksTruncated).toBeUndefined();
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(yield* call({ action: "task_dismiss", threadId: "task-done" })).toEqual({
        threadId: "task-done",
        dismissed: true,
      });
    }
    expect(writes).toEqual([{ task: "task-done", dismissed: true }]);
    expect((yield* call({ action: "read", handle: "ceo" })).tasks[0].dismissed).toBe(true);
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(yield* call({ action: "task_restore", threadId: "task-done" })).toEqual({
        threadId: "task-done",
        dismissed: false,
      });
    }
    expect(writes).toHaveLength(2);
    expect(yield* call({ action: "task_dismiss", threadId: "task-run" })).toMatchObject({
      code: "invalid_request",
      message: "A running task cannot be dismissed. Stop it first.",
    });
    expect(yield* call({ action: "task_dismiss", threadId: "nope" })).toMatchObject({
      code: "invalid_request",
    });
    expect(yield* call({ action: "task_dismiss" })).toMatchObject({ code: "invalid_request" });
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

it.effect(
  "create and update pass the projects, the first being the home, and the default model",
  () =>
    Effect.gen(function* () {
      const { call, writes } = yield* harness("full-access");
      const defaultModel = { providerInstanceId, model: "gpt-5" };
      const selection = { instanceId: providerInstanceId, model: "gpt-5" };
      yield* call({
        action: "create",
        name: "Many",
        instructions: "",
        toolAccess: "read-only",
        projectIds: ["a", "b"],
        defaultModel,
        clientRequestId: "many",
      });
      yield* call({
        action: "update",
        handle: "eng",
        projectIds: ["b", "c"],
        defaultModel,
        clientRequestId: "upd",
      });
      const listed = yield* call({ action: "read", handle: "eng" });
      yield* call({
        action: "update",
        handle: "eng",
        defaultModel: null,
        clientRequestId: "clear",
      });
      expect(writes).toEqual([
        {
          create: expect.objectContaining({
            projectId: "a",
            projectIds: ["a", "b"],
            modelSelection: selection,
          }),
        },
        {
          update: expect.objectContaining({
            projectIds: ["b", "c"],
            defaultModelSelection: selection,
          }),
        },
        { update: expect.objectContaining({ defaultModelSelection: null }) },
      ]);
      expect(listed).toMatchObject({ projectIds: ["b", "c"], defaultModel });
      expect(yield* call({ action: "read", handle: "eng" })).toMatchObject({ defaultModel: null });
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

it.effect("only the user turns an assistant's notifications on, and only the mode changes", () =>
  Effect.gen(function* () {
    const fromRoutine = yield* harness("full-access", {
      id: "m2",
      createdBy: "user",
      scheduledTaskId: "task-1",
    });
    expect(
      yield* fromRoutine.call({
        action: "update",
        handle: "eng",
        notifications: "reply-and-notify",
      }),
    ).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("this turn came from a scheduled task"),
    });
    expect(fromRoutine.writes).toEqual([]);
    // Other changes from that turn need no user.
    expect(
      yield* fromRoutine.call({ action: "update", handle: "eng", role: "Lead" }),
    ).toMatchObject({
      status: "updated",
    });

    const { call, writes } = yield* harness("full-access");
    const updated = yield* call({
      action: "update",
      handle: "eng",
      notifications: "reply-and-notify",
    });
    expect(updated).toMatchObject({ status: "updated" });
    expect(writes).toEqual([
      {
        update: {
          assistantId: "eng",
          autonomy: { ...DEFAULT_ASSISTANT_AUTONOMY, mode: "reply-and-notify" },
        },
      },
    ]);
    expect((yield* call({ action: "read", handle: "ceo" })).notifications).toBe("reply-only");
  }),
);

it.effect("notify_user is for an assistant's own turn, and a retry in the turn sends once", () =>
  Effect.gen(function* () {
    const stranger = yield* harness("full-access");
    expect(yield* stranger.call({ action: "notify_user", text: "Done." })).toMatchObject({
      code: "capability_denied",
    });
    expect(stranger.notified).toEqual([]);

    // A scheduled reminder is exactly when it is used, so the turn's origin does not matter.
    const { call, notified } = yield* harness(
      "approval-required",
      { id: "m2", createdBy: "user", scheduledTaskId: "task-1" },
      "assistant:eng:1",
    );
    expect(yield* call({ action: "notify_user", text: " " })).toMatchObject({
      code: "invalid_request",
    });
    const sent = yield* call({ action: "notify_user", text: "Deploy done.", threadId: "t9" });
    expect(sent).toEqual({
      status: "sent",
      channels: ["activity", "telegram"],
      remainingToday: 19,
    });
    expect(
      yield* call({ action: "notify_user", text: "Deploy done.", threadId: "t9" }),
    ).toMatchObject({ status: "already_sent" });
    expect(notified.map((input) => [input.assistantId, input.text, input.threadId])).toEqual([
      ["eng", "Deploy done.", "t9"],
      ["eng", "Deploy done.", "t9"],
    ]);
    expect(notified[0]!.key).toBe(notified[1]!.key);
    yield* call({ action: "notify_user", text: "Deploy done.", clientRequestId: "again" });
    expect(notified[2]!.key).not.toBe(notified[0]!.key);
    expect(yield* call({ action: "notify_user", text: "paused" })).toMatchObject({
      code: "invalid_request",
      message: "notifications are paused",
    });
  }),
);

const containerTask = { action: "container_task", text: "Run the CI." } as const;

it.effect("container_task asks for the CPU limit once, then starts the task, keyed per call", () =>
  Effect.gen(function* () {
    const { call, container, decisions } = yield* harness("full-access");
    const pending = yield* call({ ...containerTask, clientRequestId: "ci" });
    expect(pending).toMatchObject({ status: "pending_decision" });
    // Asking again before the answer shows the same question and starts nothing.
    expect(yield* call({ ...containerTask, clientRequestId: "ci" })).toEqual(pending);
    expect(container.delegated).toEqual([]);

    yield* decisions.answer({ decisionId: pending.decisionId, optionId: "none" });
    const started = yield* call({ ...containerTask, clientRequestId: "ci" });
    expect(started).toMatchObject({
      status: "started",
      taskId: "task-1",
      environmentId: sandboxId,
    });
    expect(container.configured).toEqual([{ cpus: null }]);
    expect(container.delegated).toHaveLength(1);
    expect(container.delegated[0]!.input).toMatchObject({
      task: "Run the CI.",
      mode: "async",
      target: { environmentId: sandboxId },
    });
    // The project is cloned into the container when it is missing there.
    expect(container.delegated[0]!.options).toEqual({ cloneMissingProject: true });

    // Chosen once: no second question, and the same request id lands on the same key.
    const again = yield* call({ ...containerTask, clientRequestId: "ci" });
    expect(again).toMatchObject({ status: "started" });
    expect(container.delegated[1]!.input.clientRequestId).toBe(
      container.delegated[0]!.input.clientRequestId,
    );
    expect(yield* decisions.list({})).toHaveLength(1);
  }),
);

it.effect("container_task stores the number of cores the user picked", () =>
  Effect.gen(function* () {
    const { call, container, decisions } = yield* harness("full-access");
    const pending = yield* call(containerTask);
    yield* decisions.answer({ decisionId: pending.decisionId, optionId: "cpus-2" });
    yield* call(containerTask);
    expect(container.configured).toEqual([{ cpus: 2 }]);
  }),
);

it.effect("container_task without a request id derives one from the task", () =>
  Effect.gen(function* () {
    const { call, container } = yield* harness("full-access");
    container.config = { ...container.config, chosen: true };
    yield* call(containerTask);
    yield* call(containerTask);
    yield* call({ ...containerTask, text: "Run the linter." });
    const keys = container.delegated.map((entry) => entry.input.clientRequestId);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[0].length).toBeLessThan(64);
  }),
);

it.effect("container_task says when the container is still starting or cannot start", () =>
  Effect.gen(function* () {
    const { call, container } = yield* harness("full-access");
    container.config = { ...container.config, chosen: true };
    container.status = { state: "starting", environmentId: null, error: null };
    expect(yield* call(containerTask)).toMatchObject({ status: "starting" });
    container.status = { state: "docker_unavailable", environmentId: null, error: null };
    expect(yield* call(containerTask)).toMatchObject({ code: "invalid_request" });
    container.status = { state: "failed", environmentId: null, error: "Build failed." };
    expect(yield* call(containerTask)).toMatchObject({ message: "Build failed." });
    expect(container.delegated).toEqual([]);
  }),
);

it.effect(
  "container_task refuses an empty task and an assistant whose workspace is the container",
  () =>
    Effect.gen(function* () {
      const { call, container } = yield* harness("full-access");
      expect(yield* call({ action: "container_task" })).toMatchObject({ code: "invalid_request" });
      const sandboxed = yield* harness(
        "full-access",
        { id: "m-user", createdBy: "user" },
        "assistant:ceo:1",
      );
      const refused = yield* sandboxed.call(containerTask);
      expect(refused).toMatchObject({ code: "invalid_request" });
      expect(refused.message).toContain("already the container");
      expect(container.delegated).toEqual([]);
      expect(sandboxed.container.delegated).toEqual([]);
    }),
);

it.effect("container_task is refused for good when the user dismisses the CPU question", () =>
  Effect.gen(function* () {
    const { call, container, decisions } = yield* harness("full-access");
    const pending = yield* call(containerTask);
    yield* decisions.dismiss(pending.decisionId);
    const refused = yield* call(containerTask);
    expect(refused).toMatchObject({ code: "invalid_request" });
    // The way on is Settings, which the next call honours without asking again.
    expect(refused.message).toContain("Settings → Assistants → Sandbox → CPU limit");
    expect(container.delegated).toEqual([]);
  }),
);

it.effect("container_task names the sign-in when the provider cannot run in the container", () =>
  Effect.gen(function* () {
    const { call, container } = yield* harness("full-access");
    container.config = { ...container.config, chosen: true };
    container.providers = [
      {
        providerInstanceId,
        displayName: "Codex",
        canRunChildTask: false,
        constraints: [PROVIDER_UNAUTHENTICATED],
      },
    ];
    const unsigned = yield* call(containerTask);
    expect(unsigned).toMatchObject({ code: "invalid_request" });
    expect(unsigned.message).toContain("Codex cannot run in the container");
    expect(unsigned.message).toContain("Settings → Assistants → Sandbox → Sign in");
    // Another reason is passed on without pointing at a sign-in that would not help.
    container.providers[0] = {
      ...container.providers[0]!,
      constraints: ["Provider executable is not installed."],
    };
    const missing = yield* call(containerTask);
    expect(missing.message).toContain("Provider executable is not installed.");
    expect(missing.message).not.toContain("Sign in");
    expect(container.delegated).toEqual([]);
    container.providers[0] = { ...container.providers[0]!, canRunChildTask: true, constraints: [] };
    expect(yield* call(containerTask)).toMatchObject({ status: "started" });
  }),
);

it.effect("a clone that fails before a GitHub sign-in names where to sign in", () =>
  Effect.gen(function* () {
    const { call, container } = yield* harness("full-access");
    container.config = { ...container.config, chosen: true };
    container.delegateError = `${RemoteDelegation.CLONE_FAILED}could not read Username for 'https://github.com'`;
    const unsigned = yield* call(containerTask);
    expect(unsigned).toMatchObject({ code: "orchestration_error" });
    expect(unsigned.message).toContain("could not read Username");
    expect(unsigned.message).toContain("Settings → Assistants → Sandbox → Sign in to GitHub");
    // Signed in, the clone's own reason stands alone: a sign-in would not change it.
    container.github = "signed_in";
    const denied = yield* call(containerTask);
    expect(denied.message).not.toContain("Sign in to GitHub");
    // Other failures pass through as they are.
    container.github = "signed_out";
    container.delegateError = "The calling thread was not found.";
    expect((yield* call(containerTask)).message).toBe("The calling thread was not found.");
  }),
);

it.effect("container_discard discards the container, and reports why it cannot", () =>
  Effect.gen(function* () {
    const { call, container } = yield* harness("full-access");
    expect(yield* call({ action: "container_discard" })).toMatchObject({
      status: "discarded",
      container: "not_created",
    });
    expect(container.discards).toBe(1);
    container.discardError = "1 task is still running in the container.";
    expect(yield* call({ action: "container_discard" })).toMatchObject({
      code: "invalid_request",
      message: "1 task is still running in the container.",
    });
  }),
);
