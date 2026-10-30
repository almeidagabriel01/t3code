import type { AssistantToolAccess } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { RuntimePolicyV2, type RuntimePolicyV2Shape } from "../orchestration-v2/RuntimePolicy.ts";
import { AssistantDirectory } from "./AssistantDirectory.ts";

/**
 * Read-only is the only access the runtime mode can't express: it also needs a read-only
 * sandbox with global reads, which every adapter decodes the same way. The other levels
 * are fully described by the thread's runtime mode.
 */
export function assistantRuntimeOverride(toolAccess: AssistantToolAccess) {
  return toolAccess === "read-only"
    ? ({
        sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" } },
        approvalPolicy: "never",
      } as const)
    : undefined;
}

/** Resolved on every turn start, so an access change applies to the next turn. */
export const layer: Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2 | AssistantDirectory> =
  Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      const directory = yield* AssistantDirectory;
      return {
        resolve: Effect.fn("AssistantRuntimePolicy.resolve")(function* (input) {
          const policy = yield* base.resolve(input);
          const found = yield* directory.forThread(input.thread.id);
          const override = Option.isNone(found)
            ? undefined
            : assistantRuntimeOverride(found.value.assistant.toolAccess);
          return override === undefined
            ? policy
            : ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({ ...policy, ...override });
        }),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
