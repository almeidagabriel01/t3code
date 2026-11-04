import * as Schema from "effect/Schema";

/** What macOS reports for one privacy permission; `unknown` when it cannot be read. */
export const MacPermissionStatus = Schema.Literals(["granted", "denied", "unknown"]);
export type MacPermissionStatus = typeof MacPermissionStatus.Type;

export const MAC_PERMISSION_PANES = ["screen-recording", "accessibility", "automation"] as const;
export const MacPermissionPane = Schema.Literals(MAC_PERMISSION_PANES);
export type MacPermissionPane = typeof MacPermissionPane.Type;

/** `supported` is false off macOS; the other fields are then `unknown` and the UI hides the page. */
export const MacPermissions = Schema.Struct({
  supported: Schema.Boolean,
  screenRecording: MacPermissionStatus,
  accessibility: MacPermissionStatus,
  automation: MacPermissionStatus,
});
export type MacPermissions = typeof MacPermissions.Type;

/** Reading Automation can make macOS prompt, so it is only read when `automation` is true. */
export const ComputerUsePermissionsInput = Schema.Struct({
  automation: Schema.optional(Schema.Boolean),
});
export type ComputerUsePermissionsInput = typeof ComputerUsePermissionsInput.Type;

export const ComputerUseOpenSettingsInput = Schema.Struct({ pane: MacPermissionPane });
export type ComputerUseOpenSettingsInput = typeof ComputerUseOpenSettingsInput.Type;

export const ComputerUseOpenSettingsResult = Schema.Struct({});
export type ComputerUseOpenSettingsResult = typeof ComputerUseOpenSettingsResult.Type;

export class ComputerUseError extends Schema.TaggedError<ComputerUseError>()("ComputerUseError", {
  reason: Schema.Literals([
    "unsupported_platform",
    "screen_recording_missing",
    "accessibility_missing",
    "not_approved",
    "approval_pending",
    "already_executed",
    "invalid",
    "failed",
  ]),
  /** Reaches the agent: what happened and what to do next. */
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    if (this.detail !== undefined) return this.detail;
    switch (this.reason) {
      case "unsupported_platform":
        return "Computer use is only available when T3 Code runs on a Mac.";
      case "screen_recording_missing":
        return "T3 Code does not have the Screen Recording permission. Ask the user to grant it in Settings > Mac permissions, then try again.";
      case "accessibility_missing":
        return "T3 Code does not have the Accessibility permission. Ask the user to grant it in Settings > Mac permissions, then try again.";
      case "not_approved":
        return "The user did not approve this action. Nothing was done.";
      case "approval_pending":
        return "Waiting for the user to approve this action.";
      case "already_executed":
        return "This approved action already ran once.";
      case "invalid":
        return "The action arguments are not valid.";
      case "failed":
        return "The Mac action failed.";
    }
  }
}
