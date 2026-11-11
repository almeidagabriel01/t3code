// An in-process environment for app render scenarios: a fetch stub for its HTTP API and a
// session that answers the shell, thread and config subscriptions from fixtures. Other RPCs
// stay pending so nothing retries on timers. Everything above the wire is the app's own.
import {
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  EnvironmentId,
  EventId,
  ExecutionEnvironmentDescriptor,
  MessageId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskError,
  ServerConfig,
  ImessageChannelSettingsError,
  TelegramChannelSettingsError,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  WsRpcGroup,
  AssistantError,
  type Assistant,
  type AssistantGroupMessage,
  type AssistantGroupsEvent,
  type AssistantGroupsHistoryResult,
  type AssistantGroupTask,
  type AutonomySettings,
  type AutonomyWatch,
  type AutonomyWatchUpsertInput,
  type AssistantSandboxStatus,
  type AssistantLibrary,
  type AssistantSpend,
  type ForkUpdateStatus,
  type MacPermissions,
  type ImessageChannelAccess,
  type ImessageChannelSettings,
  type ImessageChannelSettingsErrorReason,
  type ImessageChannelStatusEvent,
  type TelegramChannelConfigureInput,
  type TelegramChannelSettings,
  type TelegramChannelSettingsErrorReason,
  type TelegramChannelStatusEvent,
  type ScheduledTask,
  type AssistantsEvent,
  type AssistantTeam,
  type AssistantTeamsCreateInput,
  type Decision,
  type DecisionsEvent,
  type VcsStatusStreamEvent,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
  type TerminalMetadataStreamEvent,
} from "@t3tools/contracts";
import type {
  ConnectionAttemptError,
  ConnectionCatalogEntry,
  EnvironmentConnectionLease,
  RouteCheck,
} from "@t3tools/client-runtime/connection";
import type { WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { createModelCapabilities } from "@t3tools/shared/model";
import { APP_VERSION } from "~/branding";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcSchema } from "effect/rpc";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export const ENVIRONMENT_ID = EnvironmentId.make("environment-render");
export const PROJECT_ID = ProjectId.make("project-render");
const CODEX = ProviderInstanceId.make("codex");
const MODEL = { instanceId: CODEX, model: "gpt-5.4" };
const AT = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");

const descriptor = {
  environmentId: ENVIRONMENT_ID,
  label: "Render scenarios",
  platform: { os: "linux", arch: "x64" },
  // A matching version, since a mismatch adds an update banner a typical user never sees.
  serverVersion: APP_VERSION,
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: { repositoryIdentity: true },
};
const auth = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session",
};

const serverConfig: ServerConfig = {
  ...Schema.decodeUnknownSync(ServerConfig)({
    environment: descriptor,
    auth,
    cwd: "/workspace/render",
    keybindingsConfigPath: "/workspace/.t3/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        instanceId: CODEX,
        driver: "codex",
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-03-17T19:12:28.000Z",
        models: [
          { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null },
          { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
        ],
      },
    ],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/workspace/.t3/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {},
    threadSnapshotPagination: true,
    threadResumeCompletionMarker: true,
    shellResumeCompletionMarker: true,
  }),
  keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
};

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "render",
  workspaceRoot: "/workspace/render",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-03-17T19:12:28.000Z",
  updatedAt: "2026-03-17T19:12:28.000Z",
};

const base = (threadId: ThreadId, runId: RunId, id: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: AT,
  completedAt: AT,
  updatedAt: AT,
});

function userItem(threadId: ThreadId, runId: RunId, id: string, ordinal: number, text: string) {
  return {
    ...base(threadId, runId, id, ordinal),
    type: "user_message",
    messageId: MessageId.make(id),
    text,
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource: "web",
  } satisfies OrchestrationV2TurnItem;
}

export function assistantItem(
  threadId: ThreadId,
  runId: RunId,
  id: string,
  ordinal: number,
  text: string,
  streaming = false,
) {
  return {
    ...base(threadId, runId, id, ordinal),
    type: "assistant_message",
    messageId: MessageId.make(id),
    text,
    streaming,
    ...(streaming ? { status: "running" as const, completedAt: null } : {}),
  } satisfies OrchestrationV2TurnItem;
}

function run(threadId: ThreadId, id: RunId, ordinal: number, userMessageId: string) {
  return {
    id,
    threadId,
    ordinal,
    providerInstanceId: CODEX,
    modelSelection: MODEL,
    providerThreadId: null,
    userMessageId: MessageId.make(userMessageId),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: AT,
    startedAt: AT,
    completedAt: AT,
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2Run;
}

export interface FakeThread {
  /** Makes this a side chat of that thread. */
  readonly sideChatOf?: ThreadId;
  readonly id: ThreadId;
  readonly title: string;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
}

/** A thread of `turns` user prompts, each answered in markdown with a list and inline code. */
export function threadWithHistory(name: string, turns: number): FakeThread {
  const id = ThreadId.make(name);
  const runs: OrchestrationV2Run[] = [];
  const items: OrchestrationV2TurnItem[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const runId = RunId.make(`${name}-run-${turn}`);
    runs.push(run(id, runId, turn + 1, `${name}-user-${turn}`));
    items.push(
      userItem(id, runId, `${name}-user-${turn}`, turn * 2, `${name}: question ${turn}`),
      assistantItem(
        id,
        runId,
        `${name}-assistant-${turn}`,
        turn * 2 + 1,
        `Answer ${turn} for ${name}.\n\n- checked \`Sidebar.tsx\`\n- ran the tests\n\n` +
          "The width is now `clamp(next, MIN_WIDTH, MAX_WIDTH)`, so the layout no longer jumps.",
      ),
    );
  }
  return { id, title: `Thread ${name}`, runs, items };
}

function shellOf(thread: FakeThread): OrchestrationV2ThreadShell {
  const latest = thread.runs.at(-1);
  return {
    id: thread.id,
    projectId: PROJECT_ID,
    title: thread.title,
    providerInstanceId: CODEX,
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: thread.sideChatOf ?? thread.id,
      parentThreadId: thread.sideChatOf ?? null,
      relationshipToParent: null,
      ...(thread.sideChatOf ? { sideChat: true } : {}),
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: latest?.id ?? null,
    activeRunId: null,
    // Idle reads as waiting on the user, which shows a per-second duration in the sidebar.
    status: latest ? (latest.status === "failed" ? "failed" : "completed") : "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: AT,
    hasActionableProposedPlan: false,
    itemCount: thread.items.length,
    visibleItemCount: thread.items.length,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: AT,
    deletedAt: null,
  };
}

function projectionOf(thread: FakeThread): OrchestrationV2ThreadProjection {
  const shell = shellOf(thread);
  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = thread.items.map(
    (item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: thread.id,
      sourceItemId: item.id,
      item,
    }),
  );
  return {
    thread: {
      id: shell.id,
      projectId: shell.projectId,
      title: shell.title,
      providerInstanceId: shell.providerInstanceId,
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      activeProviderThreadId: null,
      lineage: shell.lineage,
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: AT,
      updatedAt: AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: AT,
      deletedAt: null,
    },
    runs: [...thread.runs],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [...thread.items],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: AT,
  };
}

let extraCapabilities: Record<string, boolean> = {};
let hostOs: "linux" | "darwin" = "linux";
let reasoningEffort = false;
const effortCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      role: "reasoning",
      currentValue: "medium",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
    },
  ],
});
// The same object when nothing is added, so scenarios that count renders see no new config.
let autonomyOverride: AutonomySettings | null = null;
/** Starts the server with these autonomy settings; reset when the environment is disposed. */
export function setFakeAutonomy(autonomy: AutonomySettings | null): void {
  autonomyOverride = autonomy;
}
const currentServerConfig = (): ServerConfig =>
  Object.keys(extraCapabilities).length === 0 &&
  hostOs === "linux" &&
  autonomyOverride === null &&
  !reasoningEffort
    ? serverConfig
    : {
        ...serverConfig,
        providers: reasoningEffort
          ? serverConfig.providers.map((provider) => ({
              ...provider,
              models: provider.models.map((model) => ({
                ...model,
                capabilities: effortCapabilities,
              })),
            }))
          : serverConfig.providers,
        settings: autonomyOverride
          ? { ...serverConfig.settings, autonomy: autonomyOverride }
          : serverConfig.settings,
        environment: {
          ...serverConfig.environment,
          platform: { ...serverConfig.environment.platform, os: hostOs },
          capabilities: { ...serverConfig.environment.capabilities, ...extraCapabilities },
        },
      };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Keyed by thread id: a live thread subscription's queue, for pushing events to it.
const threadSubscribers = new Map<string, Queue.Queue<OrchestrationV2ThreadStreamItem>>();
let terminalMetadataSubscriber: Queue.Queue<TerminalMetadataStreamEvent> | null = null;
let threads: ReadonlyArray<FakeThread> = [];
let dispatched: OrchestrationV2Command[] = [];
let acceptCommands = false;
let sequence = 1;
let vcsStatusSubscriber: Queue.Queue<VcsStatusStreamEvent> | null = null;

const subscribe = <A>(first: ReadonlyArray<A>, register?: (queue: Queue.Queue<A>) => () => void) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<A>();
      yield* Queue.offerAll(queue, first);
      if (register) {
        const unregister = register(queue);
        yield* Effect.addFinalizer(() => Effect.sync(unregister));
      }
      return Stream.fromQueue(queue);
    }),
  );

const shellSubscribers = new Set<Queue.Queue<OrchestrationV2ShellStreamItem>>();

const handlers: Record<string, (input: never) => unknown> = {
  // Recorded, and accepted only when the scenario asks, since a pending command holds every
  // later command on its thread. Accepted commands' events never arrive.
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
    Effect.suspend(() => {
      dispatched.push(command);
      return acceptCommands ? Effect.succeed({ sequence: sequence + 1 }) : Effect.never;
    }),
  [WS_METHODS.subscribeTerminalMetadata]: () =>
    subscribe<TerminalMetadataStreamEvent>([{ type: "snapshot", terminals: [] }], (queue) => {
      terminalMetadataSubscriber = queue;
      return () => {
        if (terminalMetadataSubscriber === queue) terminalMetadataSubscriber = null;
      };
    }),
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
    subscribe<OrchestrationV2ShellStreamItem>(
      [
        {
          kind: "snapshot",
          snapshot: {
            schemaVersion: 1,
            snapshotSequence: sequence,
            projects: [project],
            threads: threads.map(shellOf),
            archivedThreads: [],
          },
        },
        { kind: "synchronized" },
      ],
      (queue) => {
        shellSubscribers.add(queue);
        return () => shellSubscribers.delete(queue);
      },
    ),
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: { readonly threadId: ThreadId }) => {
    const thread = threads.find((candidate) => candidate.id === input.threadId);
    if (!thread) return Stream.never;
    return subscribe<OrchestrationV2ThreadStreamItem>(
      [
        { kind: "snapshot", snapshotSequence: sequence, projection: projectionOf(thread) },
        { kind: "synchronized" },
      ],
      (queue) => {
        threadSubscribers.set(thread.id, queue);

        // A replaced subscription closes after its successor registers.
        return () => {
          if (threadSubscribers.get(thread.id) === queue) threadSubscribers.delete(thread.id);
        };
      },
    );
  },
  [WS_METHODS.subscribeVcsStatus]: () =>
    subscribe<VcsStatusStreamEvent>([], (queue) => {
      vcsStatusSubscriber = queue;
      return () => {
        if (vcsStatusSubscriber === queue) vcsStatusSubscriber = null;
      };
    }),
  [WS_METHODS.subscribeServerConfig]: () =>
    subscribe([{ version: 1 as const, type: "snapshot" as const, config: currentServerConfig() }]),
};

class FakeCommandRejected extends Schema.TaggedError<FakeCommandRejected>()("FakeCommandRejected", {
  message: Schema.String,
}) {}

// Forking a side chat adds an empty thread under its parent, as the server does.
handlers[ORCHESTRATION_V2_WS_METHODS.dispatchCommand] = (command: {
  readonly type: string;
  readonly sourceThreadId?: ThreadId;
  readonly targetThreadId?: ThreadId;
  readonly title?: string;
}) =>
  Effect.suspend(() => {
    fakeCommands.dispatched.push(command);
    dispatched.push(command as OrchestrationV2Command);
    if (fakeCommands.failTypes.has(command.type)) {
      return Effect.fail(new FakeCommandRejected({ message: `${command.type} failed` }));
    }
    if (fakeCommands.holdTypes.has(command.type)) {
      // Refused when the test ends: one left unanswered blocks the same command in later tests.
      return Effect.callback<never, FakeCommandRejected>((resume) => {
        heldCommands.push(() =>
          resume(Effect.fail(new FakeCommandRejected({ message: `${command.type} held` }))),
        );
      });
    }
    return Effect.sync(() => dispatchCommand(command));
  });

const heldCommands: Array<() => void> = [];

/** Commands the fake server received, the types it rejects, and the types it holds unanswered. */
export const fakeCommands = {
  dispatched: [] as Array<{ readonly type: string; readonly [key: string]: unknown }>,
  failTypes: new Set<string>(),
  holdTypes: new Set<string>(),
  /** Answers every held command with a rejection. */
  refuseHeld: () => {
    for (const refuse of heldCommands.splice(0)) refuse();
  },
};

const dispatchCommand = (command: {
  readonly type: string;
  readonly sourceThreadId?: ThreadId;
  readonly targetThreadId?: ThreadId;
  readonly title?: string;
}) => {
  sequence += 1;
  if (command.type === "thread.fork" && command.sourceThreadId && command.targetThreadId) {
    const child: FakeThread = {
      id: command.targetThreadId,
      title: command.title ?? "Side chat",
      runs: [],
      items: [],
    };
    threads = [...threads, child];
    const shell = shellOf(child);
    const thread = {
      ...shell,
      lineage: {
        rootThreadId: command.sourceThreadId,
        parentThreadId: command.sourceThreadId,
        relationshipToParent: null,
        sideChat: true,
      },
    };
    for (const queue of shellSubscribers) {
      Effect.runSync(
        Queue.offer(queue, { kind: "thread.updated", sequence, location: "active", thread }),
      );
    }
  }
  return { sequence };
};

/** Decisions the fake server holds, and the answer and dismiss calls it received. */
export const fakeDecisions = {
  items: [] as Decision[],
  calls: [] as Array<{ readonly method: string; readonly input: unknown }>,
};
const decisionSubscribers = new Set<Queue.Queue<DecisionsEvent>>();
const settle = Effect.fn("fakeEnvironment.settle")(function* (
  method: string,
  input: { readonly decisionId: string },
  status: Decision["status"],
) {
  fakeDecisions.calls.push({ method, input });
  const found = fakeDecisions.items.find((item) => item.id === input.decisionId)!;
  const next: Decision = { ...found, status, answeredAt: "2026-03-17T19:12:28.000Z" };
  fakeDecisions.items = fakeDecisions.items.map((item) => (item === found ? next : item));
  for (const queue of decisionSubscribers) {
    yield* Queue.offer(queue, { type: "upserted", decision: next });
  }
  return next;
});
handlers[WS_METHODS.decisionsSubscribe] = () =>
  subscribe<DecisionsEvent>([{ type: "snapshot", decisions: fakeDecisions.items }], (queue) => {
    decisionSubscribers.add(queue);
    return () => decisionSubscribers.delete(queue);
  });
handlers[WS_METHODS.decisionsAnswer] = (input: { readonly decisionId: string }) =>
  settle(WS_METHODS.decisionsAnswer, input, "answered");
handlers[WS_METHODS.decisionsDismiss] = (input: { readonly decisionId: string }) =>
  settle(WS_METHODS.decisionsDismiss, input, "withdrawn");

/** Assistants the fake server holds; it only serves the snapshot, mutations stay pending. */
export const fakeAssistants = { items: [] as Assistant[], teams: [] as AssistantTeam[] };
const assistantSubscribers = new Set<Queue.Queue<AssistantsEvent>>();
handlers[WS_METHODS.assistantsSubscribe] = () =>
  subscribe<AssistantsEvent>(
    [
      {
        type: "snapshot",
        assistants: fakeAssistants.items,
        teams: fakeAssistants.teams,
        tasks: [],
      },
    ],
    (queue) => {
      assistantSubscribers.add(queue);
      return () => assistantSubscribers.delete(queue);
    },
  );
/** Replaces the assistants, including for a subscription an earlier screen left open. */
export function publishAssistants(items: Assistant[], teams: AssistantTeam[] = []): void {
  fakeAssistants.items = items;
  fakeAssistants.teams = teams;
  for (const queue of assistantSubscribers) {
    Effect.runSync(Queue.offer(queue, { type: "snapshot", assistants: items, teams, tasks: [] }));
  }
}

/** Team calls the fake server received. */
export const fakeTeamEdits = {
  creates: [] as unknown[],
  updates: [] as unknown[],
  deletes: [] as unknown[],
};
handlers[WS_METHODS.assistantTeamsCreate] = (input: AssistantTeamsCreateInput) => {
  fakeTeamEdits.creates.push(input);
  return Effect.succeed({
    id: "team-new",
    name: input.name,
    memberIds: input.memberIds,
    leadId: input.leadId ?? null,
    createdAt: "2026-03-17T19:00:00.000Z",
    updatedAt: "2026-03-17T19:00:00.000Z",
  });
};
handlers[WS_METHODS.assistantTeamsUpdate] = (input: { readonly teamId: string }) => {
  fakeTeamEdits.updates.push(input);
  const found = fakeAssistants.teams.find((team) => team.id === input.teamId);
  return found ? Effect.succeed(found) : Effect.never;
};
handlers[WS_METHODS.assistantTeamsDelete] = (input: { readonly teamId: string }) => {
  fakeTeamEdits.deletes.push(input);
  return Effect.succeed({ teamId: input.teamId });
};

/** One group's chat as the fake server holds it, and the calls it received. */
export const fakeGroupChat = {
  messages: [] as AssistantGroupMessage[],
  tasks: [] as AssistantGroupTask[],
  hasMore: false,
  /** What the next history call returns. */
  older: null as AssistantGroupsHistoryResult | null,
  /** Refuses the next post with this reason. */
  postRefusal: null as {
    readonly reason: "mention_required" | "archived";
    readonly message: string;
  } | null,
  posts: [] as Array<Record<string, unknown>>,
  taskActions: [] as Array<Record<string, unknown>>,
  reads: [] as Array<Record<string, unknown>>,
  conversations: [] as Array<Record<string, unknown>>,
  histories: [] as Array<Record<string, unknown>>,
};
const groupChatSubscribers = new Set<Queue.Queue<AssistantGroupsEvent>>();
handlers[WS_METHODS.assistantGroupsSubscribe] = () =>
  subscribe<AssistantGroupsEvent>(
    [
      {
        type: "snapshot",
        messages: fakeGroupChat.messages,
        tasks: fakeGroupChat.tasks,
        hasMore: fakeGroupChat.hasMore,
      },
    ],
    (queue) => {
      groupChatSubscribers.add(queue);
      return () => groupChatSubscribers.delete(queue);
    },
  );
/** Replaces the chat, including for a subscription an earlier screen left open. */
export function publishGroupChat(
  messages: AssistantGroupMessage[],
  tasks: AssistantGroupTask[] = [],
  hasMore = false,
): void {
  Object.assign(fakeGroupChat, { messages, tasks, hasMore });
  for (const queue of groupChatSubscribers) {
    Effect.runSync(Queue.offer(queue, { type: "snapshot", messages, tasks, hasMore }));
  }
}
handlers[WS_METHODS.assistantGroupsHistory] = (input: Record<string, unknown>) => {
  fakeGroupChat.histories.push(input);
  return Effect.succeed(fakeGroupChat.older ?? { messages: [], tasks: [], hasMore: false });
};
handlers[WS_METHODS.assistantGroupsPost] = (input: Record<string, unknown>) => {
  fakeGroupChat.posts.push(input);
  const refusal = fakeGroupChat.postRefusal;
  if (refusal !== null) return Effect.fail(new AssistantError(refusal));
  const message = {
    ...fakeGroupChat.messages.at(-1)!,
    id: `posted-${fakeGroupChat.posts.length}`,
    text: String(input.text),
  } as AssistantGroupMessage;
  return Effect.succeed({ message, tasks: [] });
};
handlers[WS_METHODS.assistantGroupsMarkRead] = (input: { readonly readSeq?: number }) => {
  fakeGroupChat.reads.push(input);
  return Effect.succeed({ readSeq: input.readSeq ?? 0 });
};
handlers[WS_METHODS.assistantGroupsConversation] = (input: {
  readonly teamId: string;
  readonly action: string;
}) => {
  fakeGroupChat.conversations.push(input);
  const { messages, tasks } = fakeGroupChat;
  if (input.action === "clear") publishGroupChat([], []);
  else if (input.action === "new" || input.action === "compact") {
    const seq = (messages.at(-1)?.seq ?? 0) + 1;
    publishGroupChat(
      [
        ...messages,
        {
          ...messages[0]!,
          id: `boundary-${seq}`,
          seq,
          kind: "boundary",
          text: input.action,
        } as AssistantGroupMessage,
      ],
      tasks,
    );
  }
  return Effect.succeed({ teamId: input.teamId });
};
handlers[WS_METHODS.assistantGroupsTaskAction] = (input: { readonly taskId: string }) => {
  fakeGroupChat.taskActions.push(input);
  const found = fakeGroupChat.tasks.find((task) => task.id === input.taskId);
  return found ? Effect.succeed(found) : Effect.never;
};

/** The sandbox status the fake serves, and the sandbox calls it received. */
export const fakeSandbox = {
  status: {
    state: "not_created",
    step: null,
    error: null,
    environmentId: null,
    url: null,
    linkedEnvironmentsEnabled: false,
    cpus: null,
    whenDone: "discard",
  } as AssistantSandboxStatus,
  calls: [] as Array<{ readonly tag: string; readonly input: unknown }>,
};
const sandboxSubscribers = new Set<Queue.Queue<AssistantSandboxStatus>>();
handlers[WS_METHODS.assistantSandboxSubscribe] = () =>
  subscribe<AssistantSandboxStatus>([fakeSandbox.status], (queue) => {
    sandboxSubscribers.add(queue);
    return () => sandboxSubscribers.delete(queue);
  });
/** Replaces the sandbox status, including for a subscription an earlier screen left open. */
export function publishSandbox(status: AssistantSandboxStatus): void {
  fakeSandbox.status = status;
  for (const queue of sandboxSubscribers) Effect.runSync(Queue.offer(queue, status));
}
for (const tag of [
  WS_METHODS.assistantSandboxStart,
  WS_METHODS.assistantSandboxStop,
  WS_METHODS.assistantSandboxRemove,
  WS_METHODS.assistantSandboxConfigure,
]) {
  handlers[tag] = (input: unknown) =>
    Effect.sync(() => {
      fakeSandbox.calls.push({ tag, input });
      return fakeSandbox.status;
    });
}
handlers[WS_METHODS.assistantSandboxPairing] = (input: unknown) =>
  Effect.sync(() => {
    fakeSandbox.calls.push({ tag: WS_METHODS.assistantSandboxPairing, input });
    return { pairingUrl: "http://127.0.0.1:1/pair#token=fake" };
  });

/** Spend the fake serves for any assistant, and the update calls it received. */
export const fakeAssistantEdits = {
  spend: null as AssistantSpend | null,
  library: null as AssistantLibrary | null,
  updates: [] as unknown[],
  creates: [] as unknown[],
  avatarImages: [] as unknown[],
  /** What a create returns; null leaves it pending, which holds back every later assistant edit. */
  created: null as Assistant | null,
};
handlers[WS_METHODS.assistantsSpend] = () =>
  fakeAssistantEdits.spend ? Effect.succeed(fakeAssistantEdits.spend) : Effect.never;
handlers[WS_METHODS.assistantsLibrary] = () =>
  Effect.succeed(fakeAssistantEdits.library ?? { files: [], truncated: false });
handlers[WS_METHODS.assistantsUpdate] = (input: { readonly assistantId: string }) => {
  fakeAssistantEdits.updates.push(input);
  const found = fakeAssistants.items.find((item) => item.id === input.assistantId);
  return found ? Effect.succeed(found) : Effect.never;
};
handlers[WS_METHODS.assistantsSetAvatarImage] = (input: { readonly assistantId: string }) => {
  fakeAssistantEdits.avatarImages.push(input);
  const found = fakeAssistants.items.find((item) => item.id === input.assistantId);
  return found ? Effect.succeed(found) : Effect.never;
};

/** Settings patches the fake server received. */
export const fakeSettings = { patches: [] as unknown[] };
handlers[WS_METHODS.serverUpdateSettings] = (input: { readonly patch: object }) => {
  fakeSettings.patches.push(input.patch);
  return Effect.succeed({ ...serverConfig.settings, ...input.patch });
};

handlers[WS_METHODS.assistantsCreate] = (input: object) => {
  fakeAssistantEdits.creates.push(input);
  return fakeAssistantEdits.created ? Effect.succeed(fakeAssistantEdits.created) : Effect.never;
};

/** Autonomy watches the fake server holds, and the calls it received. */
export const fakeWatches = {
  items: [] as AutonomyWatch[],
  calls: [] as Array<{ readonly tag: string; readonly input: unknown }>,
};
handlers[WS_METHODS.autonomyWatchesList] = () =>
  Effect.sync(() => ({ watches: fakeWatches.items }));
handlers[WS_METHODS.autonomyWatchUpsert] = (input: AutonomyWatchUpsertInput) => {
  fakeWatches.calls.push({ tag: "upsert", input });
  const saved: AutonomyWatch = {
    id: input.id ?? ("new-watch" as AutonomyWatch["id"]),
    enabled: input.enabled ?? true,
    triggerCount: 0,
    lastTriggeredAt: null,
    createdAt: "2026-03-17T19:12:28.000Z",
    assistantId: input.assistantId,
    title: input.title,
    filter: input.filter,
    instruction: input.instruction,
    oneShot: input.oneShot,
    expiresAt: input.expiresAt,
  };
  fakeWatches.items = [...fakeWatches.items.filter((item) => item.id !== saved.id), saved];
  return Effect.succeed(saved);
};
handlers[WS_METHODS.autonomyWatchSetEnabled] = (input: {
  readonly id: string;
  readonly enabled: boolean;
}) => {
  fakeWatches.calls.push({ tag: "setEnabled", input });
  fakeWatches.items = fakeWatches.items.map((item) =>
    item.id === input.id ? { ...item, enabled: input.enabled } : item,
  );
  return Effect.succeed(fakeWatches.items.find((item) => item.id === input.id)!);
};
handlers[WS_METHODS.autonomyWatchDelete] = (input: { readonly id: string }) => {
  fakeWatches.calls.push({ tag: "delete", input });
  fakeWatches.items = fakeWatches.items.filter((item) => item.id !== input.id);
  return Effect.succeed({ id: input.id });
};

/** Scheduled tasks the fake server holds; `failToggle` makes the next toggle fail with it. */
export const fakeScheduledTasks = {
  items: [] as ScheduledTask[],
  toggles: [] as Array<{ readonly id: string; readonly enabled: boolean }>,
  runs: [] as string[],
  failToggle: null as string | null,
};
const taskSubscribers = new Set<Queue.Queue<{ readonly tasks: ScheduledTask[] }>>();
handlers[WS_METHODS.scheduledTasksSubscribe] = () =>
  subscribe([{ tasks: fakeScheduledTasks.items }], (queue) => {
    taskSubscribers.add(queue);
    return () => taskSubscribers.delete(queue);
  });
/** Replaces the scheduled tasks, including for a subscription an earlier screen left open. */
export function publishScheduledTasks(items: ScheduledTask[]): void {
  fakeScheduledTasks.items = items;
  for (const queue of taskSubscribers) Effect.runSync(Queue.offer(queue, { tasks: items }));
}
handlers[WS_METHODS.scheduledTasksSetEnabled] = (input: {
  readonly id: string;
  readonly enabled: boolean;
}) => {
  fakeScheduledTasks.toggles.push(input);
  if (fakeScheduledTasks.failToggle !== null) {
    return Effect.fail(new ScheduledTaskError({ message: fakeScheduledTasks.failToggle }));
  }
  const found = fakeScheduledTasks.items.find((item) => item.id === input.id)!;
  return Effect.succeed({ task: { ...found, enabled: input.enabled } });
};

handlers[WS_METHODS.scheduledTasksRunNow] = (input: { readonly id: string }) => {
  fakeScheduledTasks.runs.push(input.id);
  const found = fakeScheduledTasks.items.find((item) => item.id === input.id)!;
  return Effect.succeed({ task: found });
};

/** iMessage settings and access the fake server holds, and the calls it received. */
const IMESSAGE_DEFAULTS: ImessageChannelSettings = {
  enabled: false,
  allowedHandles: [],
  selfHandles: [],
  status: "disabled",
};
export const fakeImessage = {
  settings: IMESSAGE_DEFAULTS,
  access: "ok" as ImessageChannelAccess,
  ownHandles: [] as ReadonlyArray<string>,
  failConfigure: null as ImessageChannelSettingsErrorReason | null,
  configures: [] as unknown[],
  accessChecks: 0,
};
/** Starts an iMessage scenario from a clean server. */
export function resetFakeImessage(
  settings: Partial<ImessageChannelSettings> = {},
  access: ImessageChannelAccess = "ok",
): void {
  fakeImessage.settings = { ...IMESSAGE_DEFAULTS, ...settings };
  fakeImessage.access = access;
  fakeImessage.ownHandles = [];
  fakeImessage.failConfigure = null;
  fakeImessage.configures = [];
  fakeImessage.accessChecks = 0;
}
const imessageStatusSubscribers = new Set<Queue.Queue<ImessageChannelStatusEvent>>();
/** Pushes a live status event to the open subscription. */
export function publishImessageStatus(event: ImessageChannelStatusEvent): void {
  for (const queue of imessageStatusSubscribers) Effect.runSync(Queue.offer(queue, event));
}
handlers[WS_METHODS.imessageChannelGetSettings] = () => Effect.sync(() => fakeImessage.settings);
handlers[WS_METHODS.imessageChannelCheckAccess] = () =>
  Effect.sync(() => {
    fakeImessage.accessChecks += 1;
    return { access: fakeImessage.access, ownHandles: fakeImessage.ownHandles };
  });
handlers[WS_METHODS.imessageChannelSubscribeStatus] = () =>
  subscribe<ImessageChannelStatusEvent>([], (queue) => {
    imessageStatusSubscribers.add(queue);
    return () => imessageStatusSubscribers.delete(queue);
  });
handlers[WS_METHODS.imessageChannelConfigure] = (input: {
  readonly enabled?: boolean;
  readonly allowedHandles?: ReadonlyArray<string>;
  readonly selfHandles?: ReadonlyArray<string>;
}) => {
  fakeImessage.configures.push(input);
  if (fakeImessage.failConfigure !== null) {
    return Effect.fail(
      new ImessageChannelSettingsError({ reason: fakeImessage.failConfigure, detail: "nope" }),
    );
  }
  const current = fakeImessage.settings;
  fakeImessage.settings = {
    ...current,
    enabled: input.enabled ?? current.enabled,
    allowedHandles: input.allowedHandles ?? current.allowedHandles,
    selfHandles: input.selfHandles ?? current.selfHandles,
  };
  return Effect.succeed(fakeImessage.settings);
};

/** Telegram settings the fake server holds, and the calls it received. */
const TELEGRAM_DEFAULTS: TelegramChannelSettings = {
  enabled: false,
  tokenConfigured: false,
  allowedUserIds: [],
  status: "disabled",
};
export const fakeTelegram = {
  settings: TELEGRAM_DEFAULTS,
  failConfigure: null as TelegramChannelSettingsErrorReason | null,
  configures: [] as TelegramChannelConfigureInput[],
};
/** Starts a Telegram scenario from a clean server. */
export function resetFakeTelegram(settings: Partial<TelegramChannelSettings> = {}): void {
  fakeTelegram.settings = { ...TELEGRAM_DEFAULTS, ...settings };
  fakeTelegram.failConfigure = null;
  fakeTelegram.configures = [];
}
const telegramStatusSubscribers = new Set<Queue.Queue<TelegramChannelStatusEvent>>();
/** Pushes a live status event to the open subscription. */
export function publishTelegramStatus(event: TelegramChannelStatusEvent): void {
  for (const queue of telegramStatusSubscribers) Effect.runSync(Queue.offer(queue, event));
}
handlers[WS_METHODS.telegramChannelGetSettings] = () => Effect.sync(() => fakeTelegram.settings);
handlers[WS_METHODS.telegramChannelSubscribeStatus] = () =>
  subscribe<TelegramChannelStatusEvent>([], (queue) => {
    telegramStatusSubscribers.add(queue);
    return () => telegramStatusSubscribers.delete(queue);
  });
handlers[WS_METHODS.telegramChannelConfigure] = (input: TelegramChannelConfigureInput) => {
  fakeTelegram.configures.push(input);
  if (fakeTelegram.failConfigure !== null) {
    return Effect.fail(
      new TelegramChannelSettingsError({ reason: fakeTelegram.failConfigure, detail: "nope" }),
    );
  }
  const current = fakeTelegram.settings;
  const clearing = input.clearToken === true && input.botToken === undefined;
  fakeTelegram.settings = {
    ...current,
    enabled: clearing ? false : (input.enabled ?? current.enabled),
    tokenConfigured:
      input.botToken !== undefined ? true : clearing ? false : current.tokenConfigured,
    allowedUserIds: input.allowedUserIds ?? current.allowedUserIds,
  };
  const waiting = (current.pendingSenders ?? []).filter(
    (sender) =>
      !input.dismissUserIds?.includes(sender.userId) &&
      !fakeTelegram.settings.allowedUserIds.includes(sender.userId),
  );
  const { pendingSenders: _dropped, ...rest } = fakeTelegram.settings;
  fakeTelegram.settings = waiting.length === 0 ? rest : { ...rest, pendingSenders: waiting };
  // The live stream carries the waiting list too, as the real runtime publishes after a change.
  publishTelegramStatus({
    status: current.status,
    ...(waiting.length === 0 ? {} : { pendingSenders: waiting }),
  });
  return Effect.succeed(fakeTelegram.settings);
};

export const fakeForkUpdate: {
  status: ForkUpdateStatus;
  commands: Array<{ readonly type: string } & Record<string, unknown>>;
} = {
  status: {
    available: true,
    path: "/workspace/render",
    channel: "stable",
    headSha: "aaaaaaaa11",
    headSubject: null,
    headTag: null,
    upstreamSha: "bbbbbbbb22",
    upstreamTag: "v1.0.0",
    behind: 0,
    wouldConflict: null,
    conflictFiles: [],
  },
  commands: [],
};
handlers[WS_METHODS.serverForkUpdateStatus] = () => Effect.sync(() => fakeForkUpdate.status);
export const fakeMacPermissions: {
  permissions: MacPermissions;
  opened: Array<string>;
  /** Whether each status read asked for Automation. */
  reads: Array<boolean>;
} = {
  permissions: {
    supported: true,
    screenRecording: "granted",
    accessibility: "denied",
    automation: "unknown",
  },
  opened: [],
  reads: [],
};
handlers[WS_METHODS.computerUsePermissions] = (input: { readonly automation?: boolean }) =>
  Effect.sync(() => {
    fakeMacPermissions.reads.push(input.automation === true);
    const { permissions } = fakeMacPermissions;
    return input.automation === true ? permissions : { ...permissions, automation: "unknown" };
  });
handlers[WS_METHODS.computerUseOpenSettings] = (input: { readonly pane: string }) =>
  Effect.sync(() => {
    fakeMacPermissions.opened.push(input.pane);
    return {};
  });
handlers[WS_METHODS.projectsMutate] = (input: { readonly type: string }) => {
  fakeForkUpdate.commands.push(input as (typeof fakeForkUpdate.commands)[number]);
  return Effect.succeed({ ...input, createdAt: AT, updatedAt: AT });
};

// Unanswered calls stay pending, like a server that has not replied yet.
const client = new Proxy(handlers, {
  get: (target, method: string) =>
    target[method] ??
    (() => {
      const rpc = WsRpcGroup.requests.get(method);
      return rpc && RpcSchema.isStreamSchema(rpc.successSchema) ? Stream.never : Effect.never;
    }),
});

const session: EnvironmentConnectionLease["session"] = {
  client: client as unknown as WsRpcProtocolClient,
  initialConfig: Effect.sync(currentServerConfig),
  subscribeServerConfig: () =>
    subscribe([{ version: 1 as const, type: "snapshot" as const, config: currentServerConfig() }]),
  ready: Effect.void,
  probe: Effect.void,
  inboundFrames: Effect.succeed(0),
  closed: Effect.never,
};

/** Stands in for client-runtime's ConnectionDriver: every connection opens the session above. */
export const fakeDriver = {
  connect: (
    entry: ConnectionCatalogEntry,
  ): Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope> =>
    Effect.succeed({
      prepared: {
        environmentId: ENVIRONMENT_ID,
        label: descriptor.label,
        httpBaseUrl: window.location.origin,
        socketUrl: window.location.origin.replace(/^http/, "ws"),
        httpAuthorization: null,
        target: entry.target,
      },
      session,
    }),
  preflight: () => Effect.succeed(true),
  checkHost: () => Effect.succeed<RouteCheck>("unchecked"),
};
export type FakeDriver = typeof fakeDriver;

const realFetch = globalThis.fetch;
const encodeEnvironmentDescriptor = Schema.encodeSync(ExecutionEnvironmentDescriptor);
const decodeEnvironmentDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const encodeDescriptor = (capabilities: Record<string, boolean>) =>
  encodeEnvironmentDescriptor(
    decodeEnvironmentDescriptor({
      ...descriptor,
      platform: { ...descriptor.platform, os: hostOs },
      capabilities: { ...descriptor.capabilities, ...capabilities },
    }),
  );

/** Serves the environment's HTTP API and these threads until disposed. */
export function installFakeEnvironment(
  fixtures: ReadonlyArray<FakeThread>,
  options: {
    readonly decisions?: boolean;
    readonly assistants?: boolean;
    readonly imessageChannel?: boolean;
    readonly telegramChannel?: boolean;
    readonly sideChats?: boolean;
    /** The host reports macOS, as a Mac running T3 Code does. */
    readonly mac?: boolean;
    readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
    /** Models offer a Low/Medium/High reasoning effort. */
    readonly reasoningEffort?: boolean;
    /** Accepted for upstream tests; the command handler below settles every command. */
    readonly acceptCommands?: boolean;
  } = {},
): Disposable {
  threads = fixtures;
  dispatched = [];
  acceptCommands = options.acceptCommands === true;
  hostOs = options.mac ? "darwin" : "linux";
  reasoningEffort = options.reasoningEffort ?? false;
  extraCapabilities = {
    ...(options.decisions ? { decisions: true } : {}),
    ...(options.assistants ? { assistants: true } : {}),
    ...(options.imessageChannel ? { imessageChannel: true } : {}),
    ...(options.telegramChannel ? { telegramChannel: true } : {}),
    ...(options.sideChats ? { sideChats: true } : {}),
  };
  const encodedDescriptor = encodeDescriptor(extraCapabilities);
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== window.location.origin) return realFetch(input, init);
    if (url.pathname === "/.well-known/t3/environment") return json(encodedDescriptor);
    if (url.pathname === "/api/auth/session") {
      return json({
        authenticated: true,
        auth,
        scopes: options.scopes ?? AuthStandardClientScopes,
        sessionMethod: "browser-session-cookie",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    }
    // Snapshot endpoints fall back to the socket, which serves the same fixtures.
    if (/^\/(api|oauth|\.well-known)\//.test(url.pathname)) return json({}, 404);
    return realFetch(input, init);
  };
  return {
    [Symbol.dispose]: () => {
      globalThis.fetch = realFetch;
      threads = [];
      fakeCommands.dispatched.length = 0;
      fakeCommands.failTypes.clear();
      fakeCommands.holdTypes.clear();
      fakeCommands.refuseHeld();
      autonomyOverride = null;
      fakeSettings.patches = [];
      fakeWatches.items = [];
      fakeWatches.calls = [];
      // The app caches the environment's config and capabilities here; the next test starts cold.
      appAtomRegistry.reset();
      dispatched = [];
      acceptCommands = false;
    },
  };
}

/** Commands the app dispatched to the environment, oldest first. */
export function dispatchedCommands(): ReadonlyArray<OrchestrationV2Command> {
  return dispatched;
}

type ThreadEvent = Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "event" }>["event"];

export async function emitTerminalMetadata(event: TerminalMetadataStreamEvent): Promise<void> {
  if (terminalMetadataSubscriber === null) throw new Error("No terminal metadata subscription");
  await Effect.runPromise(Queue.offer(terminalMetadataSubscriber, event));
}

/** Whether the app holds a live subscription to the thread, so events reach it. */
export function isThreadSubscribed(threadId: ThreadId): boolean {
  return threadSubscribers.has(threadId);
}

/** Delivers one domain event, such as a run or turn-item update, to the thread's subscription. */
export async function emitThreadEvent(
  threadId: ThreadId,
  event: Pick<ThreadEvent, "type" | "payload">,
): Promise<void> {
  const queue = threadSubscribers.get(threadId);
  if (!queue) throw new Error(`No live subscription for ${threadId}`);
  sequence += 1;
  await Effect.runPromise(
    Queue.offer(queue, {
      kind: "event",
      sequence,
      event: { ...event, id: EventId.make(`event-${sequence}`), threadId, occurredAt: AT },
    } as OrchestrationV2ThreadStreamItem),
  );
}

export function runningRun(threadId: ThreadId, id: string, ordinal: number, userMessageId: string) {
  return {
    ...run(threadId, RunId.make(id), ordinal, userMessageId),
    status: "running" as const,
    completedAt: null,
  };
}

export { userItem };

export async function emitVcsStatus(event: VcsStatusStreamEvent): Promise<void> {
  if (vcsStatusSubscriber === null) throw new Error("No VCS status subscription");
  await Effect.runPromise(Queue.offer(vcsStatusSubscriber, event));
}
