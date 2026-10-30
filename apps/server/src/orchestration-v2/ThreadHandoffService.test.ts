import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadHandoffInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ThreadHandoffSummary from "../memory/ThreadHandoffSummary.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadHandoff from "./ThreadHandoffService.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const projectId = ProjectId.make("project:handoff");
const sourceThreadId = ThreadId.make("thread:source");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" } as const;
const targetSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-test",
} as const;

const message = (role: "user" | "assistant", text: string) => ({
  id: `${role}:${text}`,
  role,
  text,
});

const checkpoint = (
  paths: ReadonlyArray<string>,
  overrides: { readonly status?: string; readonly appRunOrdinal?: number | null } = {},
) => ({
  status: "ready",
  appRunOrdinal: 1,
  ...overrides,
  files: paths.map((path) => ({ path })),
});

const harness = (source: {
  readonly worktreePath: string | null;
  readonly messages: ReadonlyArray<ReturnType<typeof message>>;
  readonly deletedAt?: string | null;
  readonly checkpoints?: ReadonlyArray<ReturnType<typeof checkpoint>>;
  readonly recordFails?: boolean;
  readonly summary?: "unavailable" | "failed";
}) =>
  Effect.gen(function* () {
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
    const recorded = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const summarized = yield* Ref.make(0);
    const disabled = yield* Ref.make(false);
    const thread = {
      id: sourceThreadId,
      projectId,
      title: "Fix login",
      branch: source.worktreePath === null ? null : "t3/login",
      worktreePath: source.worktreePath,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      modelSelection,
    };
    const layer = ThreadHandoff.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({ ...thread, deletedAt: source.deletedAt ?? null } as never),
            dispatch: (command) =>
              source.recordFails === true
                ? Effect.fail("record failed" as never)
                : Ref.update(recorded, (all) => [...all, command]).pipe(Effect.as({} as never)),
            getThreadProjection: () =>
              Effect.succeed({
                thread,
                messages: source.messages,
                plans: [],
                checkpoints: source.checkpoints ?? [],
                visibleTurnItems: [{ position: 0, item: { type: "message" } }],
              } as never),
          }),
          Layer.mock(ThreadHandoffSummary.ThreadHandoffSummary)({
            // A different text on every call, as a model gives.
            summarize: () =>
              source.summary === undefined
                ? Ref.updateAndGet(summarized, (count) => count + 1).pipe(
                    Effect.map((count) => `summary ${count}`),
                  )
                : Effect.fail(
                    new ThreadHandoffSummary.ThreadHandoffSummaryError({ reason: source.summary }),
                  ),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome({ id: projectId, workspaceRoot: "/repo" } as never),
          }),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({
            launch: (input) =>
              Effect.flatMap(Ref.get(disabled), (off) =>
                off
                  ? Effect.fail(
                      new ThreadManagement.ThreadManagementProviderInstanceDisabledError({
                        projectId,
                        instanceId: input.modelSelection.instanceId,
                      }),
                    )
                  : Ref.update(launches, (all) => [...all, input]).pipe(
                      Effect.as({ threadId: input.threadId } as never),
                    ),
              ),
          }),
        ),
      ),
    );
    const handoff = (
      overrides: Partial<
        Pick<OrchestrationV2ThreadHandoffInput, "mode" | "instructions"> & {
          clientRequestId: string | undefined;
        }
      > = {},
    ) =>
      Effect.flatMap(ThreadHandoff.ThreadHandoffService, (service) =>
        service.handoff({
          sourceThreadId,
          modelSelection: targetSelection,
          mode: "focused",
          clientRequestId: "request-1",
          createdBy: "user",
          creationSource: "web",
          ...overrides,
        }),
      ).pipe(Effect.provide(layer));
    return { handoff, launches, recorded, summarized, disabled };
  });

const conversation = [message("user", "make login faster"), message("assistant", "cached it")];

it.effect("starts the new thread in the source's project and worktree with its modes", () =>
  Effect.gen(function* () {
    const { handoff, launches } = yield* harness({
      worktreePath: "/repo/.wt/login",
      messages: conversation,
    });
    const { threadId } = yield* handoff();
    const [launched] = yield* Ref.get(launches);
    assert.strictEqual(launched?.threadId, threadId);
    assert.strictEqual(launched?.projectId, projectId);
    assert.deepStrictEqual(launched?.modelSelection, targetSelection);
    assert.strictEqual(launched?.runtimeMode, "approval-required");
    assert.strictEqual(launched?.interactionMode, "plan");
    assert.deepStrictEqual(launched?.workspaceStrategy, {
      type: "existing_worktree",
      worktreePath: "/repo/.wt/login",
      branch: "t3/login",
    });
    assert.include(launched?.initialMessage?.text, "make login faster");
    assert.include(launched?.initialMessage?.text, "Original working directory: /repo/.wt/login");
    assert.isTrue(launched?.skipSetupScript);
  }),
);

it.effect("uses the project root when the source has no worktree", () =>
  Effect.gen(function* () {
    const { handoff, launches } = yield* harness({ worktreePath: null, messages: conversation });
    yield* handoff({ mode: "full" });
    const [launched] = yield* Ref.get(launches);
    assert.deepStrictEqual(launched?.workspaceStrategy, { type: "root" });
    assert.include(launched?.initialMessage?.text, "Saved transcript");
  }),
);

it.effect("derives one thread per request id", () =>
  Effect.gen(function* () {
    const { handoff } = yield* harness({ worktreePath: null, messages: conversation });
    const first = yield* handoff();
    const retry = yield* handoff();
    const other = yield* handoff({ clientRequestId: "request-2" });
    assert.strictEqual(retry.threadId, first.threadId);
    assert.notStrictEqual(other.threadId, first.threadId);
  }),
);

it.effect(
  "lands a repeated handoff of the same latest message on one thread without a request id",
  () =>
    Effect.gen(function* () {
      const { handoff } = yield* harness({ worktreePath: null, messages: conversation });
      const first = yield* handoff({ clientRequestId: undefined });
      const retry = yield* handoff({ clientRequestId: undefined });
      const full = yield* handoff({ clientRequestId: undefined, mode: "full" });
      const instructed = yield* handoff({
        clientRequestId: undefined,
        instructions: "Add tests.",
      });
      const instructedRetry = yield* handoff({
        clientRequestId: undefined,
        instructions: " Add tests. ",
      });
      assert.strictEqual(retry.threadId, first.threadId);
      assert.notStrictEqual(full.threadId, first.threadId);
      assert.notStrictEqual(instructed.threadId, first.threadId);
      assert.strictEqual(instructedRetry.threadId, instructed.threadId);
    }),
);

it.effect("leads the prompt with the instructions and lists the files the source changed", () =>
  Effect.gen(function* () {
    const { handoff, launches } = yield* harness({
      worktreePath: "/repo/.wt/login",
      messages: conversation,
      checkpoints: [
        checkpoint(["src/a.ts", "src/b.ts"]),
        checkpoint(["src/b.ts", "src/c.ts"]),
        checkpoint(["src/stale.ts"], { status: "stale" }),
        checkpoint(["src/subagent.ts"], { appRunOrdinal: null }),
      ],
    });
    yield* handoff({ instructions: "Add tests." });
    const [launched] = yield* Ref.get(launches);
    const text = launched?.initialMessage?.text ?? "";
    assert.include(text, "Instructions for you (do this first):");
    assert.include(text, "Add tests.");
    assert.include(
      text,
      "Files changed in the previous thread (3):\n- src/a.ts\n- src/b.ts\n- src/c.ts",
    );
    assert.notInclude(text, "stale.ts");
    assert.notInclude(text, "subagent.ts");
  }),
);

it.effect(
  "summary mode swaps the last reply for the summary and keeps the same thread on a retry",
  () =>
    Effect.gen(function* () {
      const { handoff, launches, summarized } = yield* harness({
        worktreePath: null,
        messages: conversation,
      });
      const first = yield* handoff({ mode: "summary", clientRequestId: undefined });
      const retry = yield* handoff({ mode: "summary", clientRequestId: undefined });
      const [launched] = yield* Ref.get(launches);
      const text = launched?.initialMessage?.text ?? "";
      assert.include(text, "Summary of the previous thread:");
      assert.include(text, "summary 1");
      assert.include(text, "make login faster");
      assert.notInclude(text, "cached it");
      assert.notInclude(text, "Saved transcript");
      // The summary text differs per call, yet the request id does not depend on it.
      assert.strictEqual(yield* Ref.get(summarized), 2);
      assert.strictEqual(retry.threadId, first.threadId);
    }),
);

it.effect.each([
  { summary: "unavailable" as const, reason: "summary-unavailable" },
  { summary: "failed" as const, reason: "summary-failed" },
])("fails a summary handoff as $reason without launching", ({ summary, reason }) =>
  Effect.gen(function* () {
    const { handoff, launches } = yield* harness({
      worktreePath: null,
      messages: conversation,
      summary,
    });
    const exit = yield* Effect.exit(handoff({ mode: "summary" }));
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) assert.include(JSON.stringify(exit.cause), reason);
    assert.lengthOf(yield* Ref.get(launches), 0);
  }),
);

it.effect("leaves out the files section when the source has no checkpoints", () =>
  Effect.gen(function* () {
    const { handoff, launches } = yield* harness({ worktreePath: null, messages: conversation });
    yield* handoff({ mode: "full" });
    const [launched] = yield* Ref.get(launches);
    assert.notInclude(launched?.initialMessage?.text ?? "", "Files changed");
  }),
);

it.effect("records the handoff on the source once per launch and survives a record failure", () =>
  Effect.gen(function* () {
    const { handoff, recorded } = yield* harness({ worktreePath: null, messages: conversation });
    const first = yield* handoff();
    yield* handoff();
    const [one, two] = yield* Ref.get(recorded);
    assert.deepStrictEqual(one, two);
    assert.include(JSON.stringify(one), `"threadId":"${sourceThreadId}"`);
    assert.include(JSON.stringify(one), `"targetThreadId":"${first.threadId}"`);
    assert.include(JSON.stringify(one), "thread.handoff.record");

    const failing = yield* harness({
      worktreePath: null,
      messages: conversation,
      recordFails: true,
    });
    const result = yield* failing.handoff();
    assert.isString(result.threadId);
  }),
);

it.effect.each([
  { name: "no messages", messages: [], deletedAt: null, reason: "nothing-to-hand-off" },
  {
    name: "only an assistant message",
    messages: [message("assistant", "hi")],
    deletedAt: null,
    reason: "nothing-to-hand-off",
  },
  {
    name: "a deleted source",
    messages: conversation,
    deletedAt: "2026-01-01T00:00:00.000Z",
    reason: "source-not-found",
  },
])("rejects $name before launching", ({ messages, deletedAt, reason }) =>
  Effect.gen(function* () {
    const { handoff, launches } = yield* harness({ worktreePath: null, messages, deletedAt });
    const exit = yield* Effect.exit(handoff());
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) assert.include(JSON.stringify(exit.cause), reason);
    assert.lengthOf(yield* Ref.get(launches), 0);
  }),
);

it.effect("reports a disabled provider as such", () =>
  Effect.gen(function* () {
    const { handoff, disabled } = yield* harness({ worktreePath: null, messages: conversation });
    yield* Ref.set(disabled, true);
    const exit = yield* Effect.exit(handoff());
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) assert.include(JSON.stringify(exit.cause), "provider-disabled");
  }),
);
