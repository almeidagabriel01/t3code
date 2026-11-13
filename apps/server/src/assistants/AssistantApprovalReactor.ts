import {
  isAssistantThreadId,
  type OrchestrationV2DomainEvent,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { requestDecision } from "../autonomy/needsYou.ts";
import * as DecisionService from "../decisions/DecisionService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import { AssistantDirectory } from "./AssistantDirectory.ts";

export class AssistantApprovalReactor extends Context.Service<
  AssistantApprovalReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Mirrors the approvals that were waiting when the server last stopped. */
    readonly catchUp: Effect.Effect<void>;
  }
>()("t3/assistants/AssistantApprovalReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const decisions = yield* DecisionService.DecisionService;
  const directory = yield* AssistantDirectory;
  const sql = yield* SqlClient.SqlClient;

  /** Withdraws the open decision that mirrors a request, in any thread, once the request is settled. */
  const withdrawMirror = Effect.fnUntraced(function* (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  ) {
    const open = (yield* decisions.list({ threadId })).find(
      (decision) => decision.status === "open" && decision.approvalRequestId === requestId,
    );
    if (open !== undefined) {
      yield* decisions.withdraw({ decisionId: open.id, fromThreadId: threadId });
    }
  });

  /** Makes the open decision match the request: one while it waits for the user, none after. */
  const sync = Effect.fnUntraced(function* (threadId: ThreadId, requestId: RuntimeRequestId) {
    const { request, item } = yield* projections.getRuntimeResponseContext(threadId, requestId);
    const mirrored =
      request !== undefined &&
      request.kind !== "user_input" &&
      request.status === "pending" &&
      request.responseCapability.type === "live";
    if (!mirrored) return yield* withdrawMirror(threadId, requestId);
    const found = yield* directory.forThread(threadId);
    if (Option.isNone(found)) return;
    const { assistant } = found.value;
    const { title, context, options } = requestDecision(assistant.name, request, item);
    yield* decisions.request({
      fromThreadId: threadId,
      projectId: assistant.projectId,
      threadTitle: assistant.name,
      clientRequestId: `approval:${requestId}`,
      title,
      context,
      options,
      approvalRequestId: requestId,
    });
  });

  // Other threads' requests are mirrored later by the waiting notice; any thread's mirror goes
  // away here as soon as its request is answered, cancelled or expires.
  const handle: AssistantApprovalReactor["Service"]["handle"] = (event) =>
    event.type !== "runtime-request.updated"
      ? Effect.void
      : (event.payload.status !== "pending"
          ? withdrawMirror(event.threadId, event.payload.id)
          : event.payload.kind === "user_input" || !isAssistantThreadId(event.threadId)
            ? Effect.void
            : sync(event.threadId, event.payload.id)
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("mirroring an assistant approval failed", {
              threadId: event.threadId,
              requestId: event.payload.id,
              cause,
            }),
          ),
        );

  const catchUp: AssistantApprovalReactor["Service"]["catchUp"] = Effect.gen(function* () {
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM assistants WHERE thread_id IS NOT NULL AND archived_at IS NULL`;
    // One bad thread never keeps the others' approvals from showing up.
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const threadId = row.thread_id as ThreadId;
          const { runtimeRequests } = yield* projections.getThreadRecords(threadId, [
            "runtimeRequests",
          ]);
          for (const request of runtimeRequests) {
            if (request.status === "pending") yield* sync(threadId, request.id);
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("catching up assistant approvals failed", {
              threadId: row.thread_id,
              cause,
            }),
          ),
        ),
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("catching up assistant approvals failed", { cause }),
    ),
  );

  const start: AssistantApprovalReactor["Service"]["start"] = () =>
    forkParked(
      Effect.all([catchUp, Stream.runForEach(engine.streamDomainEvents, handle)], {
        concurrency: "unbounded",
        discard: true,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant approval event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle, catchUp } satisfies AssistantApprovalReactor["Service"];
});

export const layer = Layer.effect(AssistantApprovalReactor, make);
