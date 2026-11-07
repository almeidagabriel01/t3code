import type { AssistantToolAccess, AssistantWorkspace } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { RuntimePolicyV2, type RuntimePolicyV2Shape } from "../orchestration-v2/RuntimePolicy.ts";
import { AssistantDirectory } from "./AssistantDirectory.ts";

/**
 * Read-only is the one access the runtime mode can't express: it also needs a read-only sandbox
 * with global reads. A sandboxed assistant gets it whatever its access; the cap is on the provider
 * policy only, so the thread's runtime mode still limits the work it starts in the sandbox.
 */
export function assistantRuntimeOverride(
  toolAccess: AssistantToolAccess,
  workspace: AssistantWorkspace = "host",
) {
  return toolAccess === "read-only" || workspace === "sandbox"
    ? ({
        sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" } },
        approvalPolicy: "never",
      } as const)
    : undefined;
}

/** Resolved on every turn start, so an access change applies to the next turn. */
export const layer: Layer.Layer<
  RuntimePolicyV2,
  never,
  RuntimePolicyV2 | AssistantDirectory | ServerConfig
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const directory = yield* AssistantDirectory;
    const { sharedDir } = yield* ServerConfig;
    return {
      resolve: Effect.fn("AssistantRuntimePolicy.resolve")(function* (input) {
        const policy = yield* base.resolve(input);
        const found = yield* directory.forThread(input.thread.id);
        if (Option.isNone(found)) return policy;
        // Only assistants see the shared folder: it is where they hand files to each other.
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...policy,
          ...assistantRuntimeOverride(
            found.value.assistant.toolAccess,
            found.value.assistant.workspace,
          ),
          additionalDirectories: [...(policy.additionalDirectories ?? []), sharedDir],
        });
      }),
    } satisfies RuntimePolicyV2Shape;
  }),
);
