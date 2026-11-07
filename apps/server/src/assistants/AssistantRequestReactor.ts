import { CommandId, type MessageId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { AssistantDirectory } from "./AssistantDirectory.ts";
import {
  AssistantRequests,
  blockedText,
  deliveryText,
  replyMessageId,
  replyText,
} from "./AssistantRequests.ts";

const ENDED_BADLY = new Set(["failed", "cancelled", "interrupted"]);

/** A recipient whose run ended without answering must not leave the asker in silence. */
export class AssistantRequestReactor extends Context.Service<
  AssistantRequestReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/assistants/AssistantRequestReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const requests = yield* AssistantRequests;
  const directory = yield* AssistantDirectory;

  const handle: AssistantRequestReactor["Service"]["handle"] = Effect.fn(
    "AssistantRequestReactor.handle",
  )(
    function* (event) {
      if (event.type !== "run.created" && event.type !== "run.updated") return;
      const run = event.payload;
      if (!ENDED_BADLY.has(run.status)) return;
      const requestId = run.userMessageId;
      const recipient = yield* directory.forThread(run.threadId);
      const name = Option.match(recipient, {
        onNone: () => "The assistant",
        onSome: (found) => found.assistant.name,
      });
      const notice = blockedText(name, run.status, run.threadId);
      const asker = yield* requests.claimBlocked(requestId, run.threadId, notice);
      if (Option.isNone(asker)) return;
      const shell = yield* engine
        .getThreadShell(asker.value)
        .pipe(Effect.orElseSucceed(() => null));
      // Several assistants were asked: the notice waits for the others and goes with their replies.
      const outcome = yield* requests.settle(requestId);
      const from = {
        name,
        handle: Option.match(recipient, { onNone: () => "", onSome: (f) => f.assistant.handle }),
        threadId: run.threadId,
      };
      const messageId = replyMessageId(
        outcome.kind === "complete" ? (outcome.delivery.groupId as MessageId) : requestId,
      );
      const text =
        outcome.kind === "complete"
          ? yield* deliveryText(directory, outcome.delivery)
          : replyText(from, requestId, notice);
      const sent =
        shell === null
          ? undefined
          : outcome.kind === "held"
            ? ({ _tag: "Success" } as const)
            : yield* threads
                .sendToThread({
                  projectId: shell.projectId,
                  commandId: CommandId.make(messageId),
                  messageId,
                  threadId: asker.value,
                  senderThreadId: run.threadId,
                  text,
                  attachments: [],
                  mode: "queue",
                  createdBy: "agent",
                  creationSource: "server",
                })
                .pipe(Effect.result);
      if (sent === undefined || sent._tag === "Failure") {
        yield* requests.reopen(requestId);
        yield* Effect.logWarning("assistant request could not be marked blocked", { requestId });
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant request reactor failed", { eventType: event.type, cause }),
        ),
      ),
  );

  const start: AssistantRequestReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant request event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies AssistantRequestReactor["Service"];
});

export const layer = Layer.effect(AssistantRequestReactor, make);
