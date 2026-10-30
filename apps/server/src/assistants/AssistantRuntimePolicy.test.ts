import { assert, it } from "@effect/vitest";
import {
  type Assistant,
  type AssistantToolAccess,
  assistantThreadIdFor,
  ThreadId,
} from "@t3tools/contracts";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import { AssistantDirectory } from "./AssistantDirectory.ts";
import * as AssistantRuntimePolicy from "./AssistantRuntimePolicy.ts";

const assistantThread = assistantThreadIdFor("helper", 1);
const plainThread = ThreadId.make("thread-1");

const resolveFor = (threadId: ThreadId, toolAccess: AssistantToolAccess) =>
  Effect.gen(function* () {
    const policy = yield* RuntimePolicyV2;
    return yield* policy.resolve({ thread: { id: threadId }, modelSelection: {} } as never);
  }).pipe(
    Effect.provide(
      AssistantRuntimePolicy.layer.pipe(
        Layer.provide(
          Layer.succeed(RuntimePolicyV2, {
            resolve: () =>
              Effect.succeed({
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: "/work",
              } as never),
          }),
        ),
        Layer.provide(
          Layer.succeed(AssistantDirectory, {
            forThread: (id) =>
              Effect.succeed(
                id === assistantThread
                  ? Option.some({ assistant: { toolAccess } as Assistant, current: true })
                  : Option.none(),
              ),
          }),
        ),
      ),
    ),
  );

it.effect("pins read-only assistants to a read-only sandbox and leaves the rest alone", () =>
  Effect.gen(function* () {
    const readOnly = yield* resolveFor(assistantThread, "read-only");
    assert.deepStrictEqual(readOnly.sandboxPolicy, {
      type: "readOnly",
      access: { type: "fullAccess" },
    });
    assert.strictEqual(readOnly.approvalPolicy, "never");
    assert.strictEqual(readOnly.cwd, "/work");
    for (const access of ["workspace-write", "full"] as const) {
      assert.strictEqual((yield* resolveFor(assistantThread, access)).sandboxPolicy, undefined);
    }
    assert.strictEqual((yield* resolveFor(plainThread, "read-only")).sandboxPolicy, undefined);
  }),
);

const decodeCodexSandbox = Schema.decodeSync(CodexSchema.V2TurnStartParams__SandboxPolicy);

it("the read-only override decodes as a Codex turn sandbox policy", () => {
  const override = AssistantRuntimePolicy.assistantRuntimeOverride("read-only");
  assert.ok(override);
  const decoded = decodeCodexSandbox(override.sandboxPolicy);
  assert.strictEqual(decoded.type, "readOnly");
});
