import {
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  type OrchestrationV2ProviderThread,
  ProviderSessionId,
  ThreadId,
  ProviderDriverKind,
  ProviderReplayEntry,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { startNextTurnAtTurnEnd } from "@t3tools/provider-testing/turnEndRace";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import {
  ACP_PROTOCOL,
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

export const AcpReplayTranscript = Schema.Struct({
  provider: ProviderDriverKind,
  protocol: Schema.Literal(ACP_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
export type AcpReplayTranscript = typeof AcpReplayTranscript.Type;

const decodeAcpReplayTranscriptSchema = Schema.decodeUnknownEffect(AcpReplayTranscript);
const encodeReplayTranscriptJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class AcpReplayTranscriptDecodeError extends Schema.TaggedError<AcpReplayTranscriptDecodeError>()(
  "AcpReplayTranscriptDecodeError",
  {
    expectedProvider: ProviderDriverKind,
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ${this.expectedProvider} ACP replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

const isAcpReplayTranscriptDecodeError = Schema.is(AcpReplayTranscriptDecodeError);

function metadataFromTranscript(transcript: ProviderReplayTranscript): {
  readonly provider?: string;
  readonly protocol?: string;
  readonly scenario?: string;
} {
  return {
    provider: transcript.provider,
    protocol: transcript.protocol,
    scenario: transcript.scenario,
  };
}

export function decodeAcpReplayTranscript(
  transcript: ProviderReplayTranscript,
  expectedProvider: ProviderDriverKind,
  options: { readonly retargetProvider?: boolean } = {},
): Effect.Effect<AcpReplayTranscript, AcpReplayTranscriptDecodeError> {
  const candidate = options.retargetProvider
    ? { ...transcript, provider: expectedProvider }
    : transcript;
  return decodeAcpReplayTranscriptSchema(candidate).pipe(
    Effect.filterOrFail(
      (decoded) => decoded.provider === expectedProvider,
      () =>
        new AcpReplayTranscriptDecodeError({
          expectedProvider,
          ...metadataFromTranscript(transcript),
          cause: `Expected provider ${expectedProvider}, received ${transcript.provider}`,
        }),
    ),
    Effect.mapError((cause) =>
      isAcpReplayTranscriptDecodeError(cause)
        ? cause
        : new AcpReplayTranscriptDecodeError({
            expectedProvider,
            ...metadataFromTranscript(transcript),
            cause,
          }),
    ),
  );
}

interface ReplayStatus {
  readonly cursor: number;
  readonly total: number;
  readonly failure?: unknown;
}

function decodeReplayStatus(raw: string): ReplayStatus {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    typeof Reflect.get(value, "cursor") !== "number" ||
    typeof Reflect.get(value, "total") !== "number"
  ) {
    throw new Error("ACP replay status is malformed.");
  }
  return value as ReplayStatus;
}

export function makeAcpReplayCompletenessAssertion(
  fileSystem: FileSystem.FileSystem,
  statusPath: string,
  transcript: AcpReplayTranscript,
): Effect.Effect<void, EffectAcpErrors.AcpError> {
  return fileSystem.readFileString(statusPath).pipe(
    Effect.mapError(
      (cause) =>
        new EffectAcpErrors.AcpTransportError({
          detail: `Failed to read ACP replay status for ${transcript.scenario}`,
          cause,
        }),
    ),
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => decodeReplayStatus(raw),
        catch: (cause) =>
          new EffectAcpErrors.AcpTransportError({
            detail: `Failed to decode ACP replay status for ${transcript.scenario}`,
            cause,
          }),
      }),
    ),
    Effect.flatMap((status) => {
      if (
        status.failure === undefined &&
        status.cursor === transcript.entries.length &&
        status.total === transcript.entries.length
      ) {
        return Effect.void;
      }
      return Effect.fail(
        new EffectAcpErrors.AcpTransportError({
          detail: `ACP replay did not consume all frames for ${transcript.scenario}`,
          cause: status,
        }),
      );
    }),
  );
}

function acpReplayAgentArgs(scriptPath: string): ReadonlyArray<string> {
  return ["--experimental-strip-types", scriptPath];
}

function holdGatedReplayLines(
  transcript: AcpReplayTranscript,
  replayGate: ProviderReplayGate,
): NonNullable<AcpSessionRuntime.AcpSessionRuntimeOptions["transformStdout"]> {
  const inboundLabels = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" ? [entry.label] : [],
  );
  let inboundIndex = 0;
  const encoder = new TextEncoder();
  return (stdout) =>
    stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.mapEffect((line) => {
        const label = line.trim().length === 0 ? undefined : inboundLabels[inboundIndex++];
        return Effect.promise((signal) => replayGate.beforeEmit(label, signal)).pipe(
          Effect.as(encoder.encode(`${line}\n`)),
        );
      }),
    );
}

export function makeAcpReplayRuntime(input: {
  readonly transcript: AcpReplayTranscript;
  readonly statusPath: string;
  readonly scriptPath: string;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly customModels?: AcpSessionRuntime.AcpSessionRuntimeOptions["customModels"];
  readonly cancelMeta?: AcpSessionRuntime.AcpSessionRuntimeOptions["cancelMeta"];
  readonly cancelBehavior?: AcpSessionRuntime.AcpSessionRuntimeOptions["cancelBehavior"];
  readonly initializeMeta?: AcpSessionRuntime.AcpSessionRuntimeOptions["initializeMeta"];
  readonly replayGate?: ProviderReplayGate;
}): (
  runtimeInput: AcpAdapterV2RuntimeInput,
) => Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  SecureRandom.SecureRandom | Scope.Scope
> {
  // Transcripts exceed the kernel's 128 KiB per-environment-variable limit.
  const transcriptPath = `${input.statusPath}.transcript.json`;
  return (runtimeInput) =>
    Effect.gen(function* () {
      yield* input.fileSystem
        .writeFileString(transcriptPath, encodeReplayTranscriptJson(input.transcript))
        .pipe(
          Effect.mapError(
            (cause) =>
              new EffectAcpErrors.AcpTransportError({
                detail: `Failed to write ACP replay transcript for ${input.transcript.scenario}`,
                cause,
              }),
          ),
        );
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          spawn: {
            command: process.execPath,
            args: acpReplayAgentArgs(input.scriptPath),
            cwd: runtimeInput.cwd,
            env: {
              ...process.env,
              T3_ACP_REPLAY_TRANSCRIPT_PATH: transcriptPath,
              T3_ACP_REPLAY_STATUS_PATH: input.statusPath,
              T3_ACP_REPLAY_WORKSPACE: runtimeInput.cwd,
            },
          },
          authMethodId: "replay",
          ...(input.customModels === undefined ? {} : { customModels: input.customModels }),
          ...(input.cancelMeta === undefined ? {} : { cancelMeta: input.cancelMeta }),
          ...(input.cancelBehavior === undefined ? {} : { cancelBehavior: input.cancelBehavior }),
          ...(input.initializeMeta === undefined ? {} : { initializeMeta: input.initializeMeta }),
          ...(input.replayGate === undefined
            ? {}
            : { transformStdout: holdGatedReplayLines(input.transcript, input.replayGate) }),
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      );
      return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
    });
}

export function makeTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly instanceId: ProviderInstanceId;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly now: DateTime.Utc;
  readonly ordinal?: number;
  readonly modelSelection?: ModelSelection;
  readonly messageCreatedBy?: "user" | "agent";
  readonly messageCreationSource?: "web" | "mobile" | "mcp" | "provider" | "server";
  readonly messageText?: string;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  const ordinal = input.ordinal ?? 1;
  const suffix = `${input.threadId}:${ordinal}`;
  const modelSelection =
    input.modelSelection ?? ({ instanceId: input.instanceId, model: "default" } as const);
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project:${input.threadId}`),
      title: "ACP adapter test",
      providerInstanceId: input.instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make(`run:${suffix}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt:${suffix}`),
    rootNodeId: NodeId.make(`node:${suffix}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message:${suffix}`),
      text: input.messageText ?? "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy: input.runtimePolicy,
  };
}

const layerHost = TestProviderHost.layer().pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

export const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
);

export const ACP_TEST_DRIVER = ProviderDriverKind.make("acp-test");

export function makeMockRuntime(input: {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly mockAgentPath: string;
  readonly environment?:
    | Readonly<Record<string, string>>
    | ((runtimeOrdinal: number) => Readonly<Record<string, string>>);
  readonly protocolEvents?: Queue.Queue<EffectAcpProtocol.AcpProtocolLogEvent>;
  readonly cancelBehavior?: AcpSessionRuntime.AcpSessionRuntimeOptions["cancelBehavior"];
  readonly ownDescendantProcessGroups?: boolean;
  readonly ownDetachedProcessGroup?: boolean;
  readonly processGroupPlatform?: NodeJS.Platform;
  readonly processGroupTerminationGrace?: Duration.Input;
  readonly linuxCgroupController?: AcpSessionRuntime.AcpSessionRuntimeOptions["linuxCgroupController"];
  readonly posixProcessTreeController?: AcpSessionRuntime.AcpSessionRuntimeOptions["posixProcessTreeController"];
  readonly windowsProcessTreeTerminator?: AcpSessionRuntime.AcpSessionRuntimeOptions["windowsProcessTreeTerminator"];
  readonly wrapCancel?: (
    cancel: AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"],
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"];
  readonly wrapOutgoingResponse?: (
    onOutgoingResponse: NonNullable<AcpAdapterV2RuntimeInput["onOutgoingResponse"]>,
  ) => NonNullable<AcpAdapterV2RuntimeInput["onOutgoingResponse"]>;
  readonly wrapRuntime?: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    runtimeOrdinal: number,
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"];
}): AcpAdapterV2Flavor["makeRuntime"] {
  let runtimeOrdinal = 0;
  return (runtimeInput) =>
    Effect.gen(function* () {
      runtimeOrdinal += 1;
      const protocolEvents = input.protocolEvents;
      const protocolLogging =
        protocolEvents === undefined
          ? runtimeInput.protocolLogging
          : {
              ...runtimeInput.protocolLogging,
              logIncoming: true,
              logOutgoing: true,
              logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
                Queue.offer(protocolEvents, event).pipe(
                  Effect.andThen(runtimeInput.protocolLogging.logger?.(event) ?? Effect.void),
                  Effect.asVoid,
                ),
            };
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          ...(input.cancelBehavior === undefined ? {} : { cancelBehavior: input.cancelBehavior }),
          ...(input.ownDetachedProcessGroup === undefined
            ? {}
            : { ownDetachedProcessGroup: input.ownDetachedProcessGroup }),
          ...(input.ownDescendantProcessGroups === undefined
            ? {}
            : { ownDescendantProcessGroups: input.ownDescendantProcessGroups }),
          ...(input.ownDetachedProcessGroup === true
            ? { processGroupPlatform: input.processGroupPlatform ?? "linux" }
            : {}),
          ...(input.processGroupTerminationGrace === undefined
            ? {}
            : { processGroupTerminationGrace: input.processGroupTerminationGrace }),
          ...(input.linuxCgroupController === undefined
            ? {}
            : { linuxCgroupController: input.linuxCgroupController }),
          ...(input.posixProcessTreeController === undefined
            ? {}
            : { posixProcessTreeController: input.posixProcessTreeController }),
          ...(input.windowsProcessTreeTerminator === undefined
            ? {}
            : { windowsProcessTreeTerminator: input.windowsProcessTreeTerminator }),
          protocolLogging,
          spawn: {
            command: process.execPath,
            args: [input.mockAgentPath],
            cwd: runtimeInput.cwd,
            env: {
              T3_ACP_SESSION_LIFECYCLE: "1",
              ...(typeof input.environment === "function"
                ? input.environment(runtimeOrdinal)
                : input.environment),
            },
          },
          authMethodId: "test",
          ...(input.wrapOutgoingResponse === undefined ||
          runtimeInput.onOutgoingResponse === undefined
            ? {}
            : {
                onOutgoingResponse: input.wrapOutgoingResponse(runtimeInput.onOutgoingResponse),
              }),
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
      const wrapped = {
        ...runtime,
        ...(input.wrapCancel === undefined ? {} : { cancel: input.wrapCancel(runtime.cancel) }),
      };
      return input.wrapRuntime?.(wrapped, runtimeOrdinal) ?? wrapped;
    });
}

const isProviderAdapterProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);

export const makePromptInactivityHarness = Effect.fnUntraced(function* (input: {
  readonly environment: (runtimeOrdinal: number) => Readonly<Record<string, string>>;
  readonly runtimeMode?: "full-access" | "approval-required";
}) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const natives: Array<AcpSessionRuntime.AcpSessionRuntime["Service"]> = [];
  const instanceId = ProviderInstanceId.make("acp-prompt-inactivity");
  const adapter = yield* makeAcpAdapterV2({
    instanceId,
    flavor: {
      driver: ACP_TEST_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      promptInactivityTimeout: "15 minutes",
      makeRuntime: makeMockRuntime({
        childProcessSpawner,
        mockAgentPath: yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        ),
        environment: input.environment,
        wrapRuntime: (runtime) => {
          natives.push(runtime);
          return runtime;
        },
      }),
    },
    selfInvocation: yield* resolveSelfInvocation(),
  });
  const threadId = ThreadId.make("thread-acp-prompt-inactivity");
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const modelSelection = { instanceId, model: "default" } as const;
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-acp-prompt-inactivity"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const startTurn = (ordinal: number) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal }),
        ),
      ),
    );
  return {
    runtime,
    natives,
    startTurn,
    /** A turn still running makes the next start fail, without waiting on time. */
    nextTurnRejected: (ordinal: number) =>
      startTurn(ordinal).pipe(
        Effect.flip,
        Effect.map(
          (error) =>
            isProviderAdapterProtocolError(error.cause) &&
            error.cause.reason === "previous_turn_active",
        ),
        Effect.catchCause(() => Effect.succeed(false)),
      ),
    emitUpdate: (notification: EffectAcpSchema.SessionNotification) =>
      natives.at(-1)!.request("_test/emit-update", notification),
    terminals: (count: number) =>
      runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.take(count),
        Stream.runCollect,
        Effect.map((events) =>
          Array.from(events, (event) => {
            if (event.type !== "turn.terminal") throw new Error("Expected a turn terminal");
            return event;
          }),
        ),
      ),
  };
});

/** The turn-slot race on the ACP adapter every ACP driver shares; the mock agent ends each prompt itself. */
export const acpTurnSlotRace = Effect.gen(function* () {
  const harness = yield* makePromptInactivityHarness({ environment: () => ({}) });
  const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
  const exit = yield* startNextTurnAtTurnEnd({
    events: harness.runtime.events.pipe(Stream.tap((event) => Effect.sync(() => seen.push(event)))),
    startFirst: harness.startTurn(1),
    endFirst: Effect.void,
    startNext: harness.startTurn(2),
  });
  return { exit, seen };
}).pipe(Effect.provide(layerTest), Effect.scoped);
