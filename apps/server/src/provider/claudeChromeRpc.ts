import {
  ProviderSetupError,
  type ClaudeChromeStatus,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";

import type { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

export const runClaudeChrome = Effect.fn("runClaudeChrome")(function* (
  registry: ProviderInstanceRegistry["Service"],
  instanceId: ProviderInstanceId,
  run: (
    chrome: NonNullable<ProviderInstance["claudeChrome"]>,
  ) => Effect.Effect<ClaudeChromeStatus, { readonly detail: string }>,
) {
  const refuse = (detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId, operation: "claude-chrome", detail, cause });
  const instance = yield* registry.getInstance(instanceId);
  if (instance === undefined || !instance.enabled) {
    return yield* refuse(instance ? "This provider is disabled." : "Provider instance not found.");
  }
  if (instance.claudeChrome === undefined) {
    return yield* refuse("Claude in Chrome is only available on Claude instances.");
  }
  return yield* run(instance.claudeChrome).pipe(
    Effect.mapError((error) => refuse(error.detail, error)),
  );
});
