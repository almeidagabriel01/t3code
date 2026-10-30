import {
  CommandId,
  OrchestrationV2ThreadHandoffError,
  ThreadId,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2ThreadHandoffInput,
  type OrchestrationV2ThreadHandoffResult,
} from "@t3tools/contracts";
import { buildThreadHandoffPrompt } from "@t3tools/shared/threadHandoffPrompt";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadHandoffSummary from "../memory/ThreadHandoffSummary.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export interface ThreadHandoffInput extends Omit<
  OrchestrationV2ThreadHandoffInput,
  "clientRequestId"
> {
  /** Without one, repeating a handoff of the same latest message to the same agent lands on one thread. */
  readonly clientRequestId?: string | undefined;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  /** The linked environment an agent acts for; the new thread carries it. */
  readonly linkOrigin?: OrchestrationV2LinkOrigin | undefined;
}

export class ThreadHandoffService extends Context.Service<
  ThreadHandoffService,
  {
    /** Starts a new thread in the source's project and workspace, seeded with the source's context. The source is untouched. */
    readonly handoff: (
      input: ThreadHandoffInput,
    ) => Effect.Effect<OrchestrationV2ThreadHandoffResult, OrchestrationV2ThreadHandoffError>;
  }
>()("t3/orchestration-v2/ThreadHandoffService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const summaries = yield* ThreadHandoffSummary.ThreadHandoffSummary;
  const crypto = yield* Crypto.Crypto;

  const handoff: ThreadHandoffService["Service"]["handoff"] = Effect.fn(
    "ThreadHandoffService.handoff",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.sourceThreadId,
      "handoff.mode": input.mode,
    });
    const fail = (
      reason: OrchestrationV2ThreadHandoffError["reason"],
      extra?: { readonly detail?: string; readonly cause?: unknown },
    ) =>
      new OrchestrationV2ThreadHandoffError({
        sourceThreadId: input.sourceThreadId,
        reason,
        ...extra,
      });
    const failed = (cause: unknown) => fail("launch-failed", { cause });

    const shell = yield* threads.getThreadShell(input.sourceThreadId).pipe(Effect.mapError(failed));
    if (shell === null || shell.deletedAt !== null) return yield* fail("source-not-found");
    const projection = yield* threads
      .getThreadProjection(input.sourceThreadId)
      .pipe(Effect.mapError(failed));
    const lastUser = projection.messages.findLast(
      (message) => message.role === "user" && message.text.trim() !== "",
    );
    if (lastUser === undefined) return yield* fail("nothing-to-hand-off");
    const project = yield* projects.getById(shell.projectId).pipe(Effect.mapError(failed));
    if (Option.isNone(project)) return yield* fail("source-not-found");

    const { thread } = projection;
    const workspacePath = thread.worktreePath ?? project.value.workspaceRoot;
    const latestPlan = projection.plans.findLast(
      (plan) => plan.kind === "proposed_plan" && plan.markdown !== "",
    );
    const instructions = input.instructions?.trim() || null;
    // Waits for the model; the text stays out of the request id below, which the mode already splits.
    const summaryText =
      input.mode === "summary"
        ? yield* summaries.summarize(thread.id).pipe(
            Effect.mapError((error) =>
              fail(error.reason === "unavailable" ? "summary-unavailable" : "summary-failed", {
                ...(error.detail === undefined ? {} : { detail: error.detail }),
                cause: error,
              }),
            ),
          )
        : null;
    // Already in the projection from each turn's checkpoint; nothing without a git workspace.
    const changedFiles = [
      ...new Set(
        projection.checkpoints.flatMap((checkpoint) =>
          checkpoint.status === "ready" && checkpoint.appRunOrdinal !== null
            ? checkpoint.files.map((file) => file.path)
            : [],
        ),
      ),
    ];
    const prompt = buildThreadHandoffPrompt({
      mode: input.mode,
      threadId: thread.id,
      title: thread.title,
      workspacePath,
      branch: thread.branch,
      summaryText,
      instructions,
      changedFiles,
      lastUserText: lastUser.text,
      lastAssistantText:
        projection.messages.findLast((message) => message.role === "assistant")?.text ?? null,
      latestPlanMarkdown: latestPlan?.kind === "proposed_plan" ? latestPlan.markdown : null,
      transcriptLines:
        input.mode === "full" ? projection.visibleTurnItems.map((row) => JSON.stringify(row)) : [],
    });

    // A fixed-length id: the thread's scratch folder name derives from it.
    const { instanceId, model } = input.modelSelection;
    const requestId =
      input.clientRequestId ??
      `latest:${lastUser.id}:${input.mode}:${instanceId}:${model}:${instructions ?? ""}`;
    const key = `${input.sourceThreadId.length}:${input.sourceThreadId}${requestId}`;
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(key))
      .pipe(Effect.mapError(failed));
    const commandId = CommandId.make(`handoff:${Hex.encode(digest)}`);
    const branch = thread.branch === null ? {} : { branch: thread.branch };
    const result = yield* launches
      .launch({
        commandId,
        threadId: ThreadId.make(commandId),
        projectId: thread.projectId,
        title: `${thread.title.trim() || "Untitled"} (handoff)`,
        modelSelection: input.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        workspaceStrategy:
          thread.worktreePath === null
            ? { type: "root", ...branch }
            : { type: "existing_worktree", worktreePath: thread.worktreePath, ...branch },
        initialMessage: { text: prompt, attachments: [] },
        // The source set the worktree up and its agent may still be working there.
        skipSetupScript: true,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
        ...(input.linkOrigin === undefined ? {} : { linkOrigin: input.linkOrigin }),
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ThreadManagementProviderInstanceDisabledError"
            ? fail("provider-disabled", { detail: error.message, cause: error })
            : failed(error),
        ),
      );
    // The new thread exists and runs; a missing marker on the source must not fail the handoff.
    yield* threads
      .dispatch({
        type: "thread.handoff.record",
        commandId: CommandId.make(`${commandId}:record`),
        threadId: input.sourceThreadId,
        targetThreadId: result.threadId,
        createdBy: input.createdBy,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not record a handoff on its source thread", {
            sourceThreadId: input.sourceThreadId,
            cause,
          }),
        ),
      );
    return { threadId: result.threadId };
  });

  return ThreadHandoffService.of({ handoff });
});

export const layer = Layer.effect(ThreadHandoffService, make);
