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
    const prompt = buildThreadHandoffPrompt({
      mode: input.mode,
      threadId: thread.id,
      title: thread.title,
      workspacePath,
      branch: thread.branch,
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
      input.clientRequestId ?? `latest:${lastUser.id}:${input.mode}:${instanceId}:${model}`;
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
    return { threadId: result.threadId };
  });

  return ThreadHandoffService.of({ handoff });
});

export const layer = Layer.effect(ThreadHandoffService, make);
