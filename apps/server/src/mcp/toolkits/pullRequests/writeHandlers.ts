import { CommandId, OrchestratorMcpFailure, type PullRequestRef } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as PullRequestSyncReactor from "../../../orchestration-v2/PullRequestSyncReactor.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import type { Locate } from "./readHandlers.ts";
import {
  PullRequestWriteRefusedError,
  PullRequestWriteUnconfirmedError,
  type PullRequestsToolkit,
  type PullRequestWriteParameters,
} from "./tools.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const need = <T>(value: T | undefined, name: string, action: string) =>
  value === undefined
    ? Effect.fail(invalid(`${action} needs \`${name}\`.`))
    : Effect.succeed(value);

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/** Same bar as the PR actions in the app: a writable credential, no plan mode, and for outside clients full access. */
const gate = Effect.fn("PullRequestsToolkit.writeGate")(function* () {
  const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
  const { limits } = yield* loadCaller();
  if (scope.readOnly === true || limits.interactionMode === "plan")
    return yield* denied(
      "Pull request writes need a writable credential and a thread in default interaction mode.",
    );
  if (scope.thread === undefined && limits.runtimeMode !== "full-access")
    return yield* denied("Pull request writes from an outside MCP client need full access.");
});

export const makePullRequestWriteHandlers = Effect.fn("PullRequestsToolkit.makeWriteHandlers")(
  function* (locate: Locate) {
    const service = yield* PullRequestService.PullRequestService;
    const sync = yield* PullRequestSyncReactor.PullRequestSyncReactor;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;

    /** What to send, as plain fields so the same request always fingerprints the same. */
    const plan = Effect.fn("PullRequestsToolkit.planWrite")(function* (
      input: PullRequestWriteParameters,
      ref: PullRequestRef,
    ) {
      const { action } = input;
      const on = input.on ?? true;
      switch (action) {
        case "comment": {
          const body = yield* need(input.body, "body", action);
          return { payload: { body }, run: service.comment({ ...ref, body }) };
        }
        case "comment_update": {
          const commentId = yield* need(input.commentId, "commentId", action);
          const kind = yield* need(input.commentKind, "commentKind", action);
          const body = yield* need(input.body, "body", action);
          return {
            payload: { commentId, kind, body },
            run: service.updateComment({ ...ref, commentId, kind, body }),
          };
        }
        case "review_submit": {
          const verdict = yield* need(input.verdict, "verdict", action);
          const body = input.body ?? "";
          return {
            payload: { verdict, body },
            run: service.submitReview({ ...ref, verdict, body, comments: [] }),
          };
        }
        case "thread_reply": {
          const threadId = yield* need(input.reviewThreadId, "reviewThreadId", action);
          const body = yield* need(input.body, "body", action);
          return {
            payload: { threadId, body },
            run: service.replyToThread({ ...ref, threadId, body }),
          };
        }
        case "thread_resolve": {
          const threadId = yield* need(input.reviewThreadId, "reviewThreadId", action);
          return {
            payload: { threadId, on },
            run: service.setThreadResolution({ ...ref, threadId, resolved: on }),
          };
        }
        case "react": {
          const content = yield* need(input.content, "content", action);
          const subjectId = input.subjectId;
          return {
            payload: { content, subjectId: subjectId ?? null, on },
            run: service.setReaction({
              ...ref,
              ...(subjectId === undefined ? {} : { subjectId }),
              content,
              reacted: on,
            }),
          };
        }
        case "labels": {
          const labels = yield* need(input.labels, "labels", action);
          if (labels.length === 0) return yield* invalid("labels needs at least one label.");
          return {
            payload: { labels, on },
            run: service.setLabels({ ...ref, labels, applied: on }),
          };
        }
        case "reviewers": {
          const reviewers = yield* need(input.reviewers, "reviewers", action);
          return {
            payload: { reviewers, on },
            run: service.requestReviewers({ ...ref, reviewers, requested: on }),
          };
        }
        case "update": {
          const { title, body } = input;
          if (title === undefined && body === undefined)
            return yield* invalid("update needs `title` or `body`.");
          return {
            payload: { title: title ?? null, body: body ?? null },
            run: service.update({
              ...ref,
              ...(title === undefined ? {} : { title }),
              ...(body === undefined ? {} : { body }),
            }),
          };
        }
        default: {
          const operation = yield* need(input.operation, "operation", action);
          const { mergeMethod, updateMethod } = input;
          return {
            payload: {
              operation,
              mergeMethod: mergeMethod ?? null,
              updateMethod: updateMethod ?? null,
            },
            run: service
              .runAction({
                ...ref,
                action: operation,
                ...(mergeMethod === undefined ? {} : { mergeMethod }),
                ...(updateMethod === undefined ? {} : { updateMethod }),
              })
              .pipe(
                Effect.tap(() =>
                  sync.requestSync({
                    host: ref.host ?? "",
                    repository: ref.repository,
                    number: ref.number,
                  }),
                ),
              ),
          };
        }
      }
    });

    const crypto = yield* Crypto.Crypto;
    const write = Effect.fn("PullRequestsToolkit.write")(function* (
      input: PullRequestWriteParameters,
    ) {
      yield* gate();
      const { target, ref } = yield* locate(input);
      const { payload, run } = yield* plan(input, ref);
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const commandId = CommandId.make(
        `mcp:pull-request:${encodeURIComponent(scope.requestNamespace)}:${encodeURIComponent(input.clientRequestId)}`,
      );
      const fingerprint = Hex.encode(
        yield* crypto
          .digest(
            "SHA-256",
            new TextEncoder().encode(encodeJson([input.action, target.url, payload])),
          )
          .pipe(Effect.orDie),
      );
      const commandType = `mcp.pull-request.${input.action}:${fingerprint}`;
      const accepted = (error: string | null) => ({
        commandId,
        projectId: ref.projectId,
        commandType,
        acceptedAt: DateTime.nowUnsafe(),
        resultSequence: 0,
        status: "accepted" as const,
        error,
      });
      const unrecorded = () =>
        new PullRequestWriteRefusedError({
          detail:
            "The write could not be recorded, so nothing was sent. The same call may run again.",
        });
      const result = { ...target, status: "accepted" as const };

      const earlier = yield* receipts
        .getProjectByCommandId(commandId)
        .pipe(Effect.mapError(unrecorded));
      if (Option.isSome(earlier)) {
        const receipt = earlier.value;
        if (receipt.commandType !== commandType)
          return yield* new PullRequestWriteRefusedError({
            detail: "This clientRequestId was already used for a different request. Use a new one.",
          });
        if (receipt.status === "accepted")
          return receipt.error === null
            ? { ...result, replayed: true }
            : yield* new PullRequestWriteUnconfirmedError({});
        // A refused attempt sent nothing, so the same id may go again.
        yield* receipts.upsert(accepted(null)).pipe(Effect.mapError(unrecorded));
      } else {
        // ponytail: reserved before sending, so a crash mid-send replays as accepted; reads reconcile.
        const reserved = yield* receipts
          .insertIfAbsent(accepted(null))
          .pipe(Effect.mapError(unrecorded));
        if (!reserved) return { ...result, replayed: true };
      }

      yield* run.pipe(
        Effect.catchTags({
          PullRequestUnavailableError: (error) => failed(error),
          PullRequestOperationError: (error) => failed(error),
        }),
      );
      return result;

      // The service's own checks fail before any host request and carry no host cause. A host
      // error may follow an earlier request of the same write, so it stays an unknown outcome.
      function failed(error: { readonly message: string; readonly cause?: unknown }) {
        return error.cause === undefined
          ? receipts
              .upsert({ ...accepted(error.message), status: "rejected" })
              .pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.fail(new PullRequestWriteRefusedError({ detail: error.message })),
                ),
              )
          : receipts
              .upsert(accepted(error.message))
              .pipe(
                Effect.ignore,
                Effect.andThen(Effect.fail(new PullRequestWriteUnconfirmedError({ cause: error }))),
              );
      }
    });

    return {
      t3_pull_request_write: McpToolAccess.writesWithCapability(write),
    } satisfies Pick<
      McpToolAccess.Handlers<typeof PullRequestsToolkit.tools>,
      "t3_pull_request_write"
    >;
  },
);
