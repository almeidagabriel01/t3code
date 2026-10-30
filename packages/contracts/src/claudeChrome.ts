import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ClaudeChromeLaunchOverride = Schema.Literals(["on", "off"]);
export type ClaudeChromeLaunchOverride = typeof ClaudeChromeLaunchOverride.Type;

export const ClaudeChromeStatusInput = Schema.Struct({ instanceId: ProviderInstanceId });
export type ClaudeChromeStatusInput = typeof ClaudeChromeStatusInput.Type;

export const ClaudeChromeSetDefaultInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  enabled: Schema.Boolean,
});
export type ClaudeChromeSetDefaultInput = typeof ClaudeChromeSetDefaultInput.Type;

export const ClaudeChromeStatus = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** The instance's `.claude.json` `claudeInChromeDefaultEnabled`, as the CLI's `/chrome` toggles it. */
  enabledByDefault: Schema.Boolean,
  /** `--chrome` / `--no-chrome` in the instance's launch arguments wins over the default. */
  launchOverride: Schema.NullOr(ClaudeChromeLaunchOverride),
  /** What new sessions get. Running sessions keep the flags they started with. */
  effective: Schema.Boolean,
  extensionInstalled: Schema.NullOr(Schema.Boolean),
  pairedBrowser: Schema.NullOr(Schema.String),
  /** No home path and no `CLAUDE_CONFIG_DIR`: `~/.claude.json`, shared by every such instance. */
  sharedConfig: Schema.Boolean,
});
export type ClaudeChromeStatus = typeof ClaudeChromeStatus.Type;
