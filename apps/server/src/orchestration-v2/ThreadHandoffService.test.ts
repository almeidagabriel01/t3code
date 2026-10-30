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

const message = (role: "user" | "assistant", text: string) => ({ role, text });

const harness = (source: {
  readonly worktreePath: string | null;
  readonly messages: ReadonlyArray<ReturnType<typeof message>>;
  readonly deletedAt?: string | null;
}) =>
  Effect.gen(function* () {
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
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
            getThreadProjection: () =>
              Effect.succeed({
                thread,
                messages: source.messages,
                plans: [],
                visibleTurnItems: [{ position: 0, item: { type: "message" } }],
              } as never),
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
      overrides: Partial<Pick<OrchestrationV2ThreadHandoffInput, "mode" | "clientRequestId">> = {},
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
    return { handoff, launches, disabled };
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
