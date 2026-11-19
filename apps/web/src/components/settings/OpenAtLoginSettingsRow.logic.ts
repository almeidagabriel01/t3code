import type { DesktopOpenAtLoginState } from "@t3tools/contracts";

export const OPEN_AT_LOGIN_FAILED = "Couldn't change this setting.";

const DESCRIPTIONS = {
  darwin:
    "Start T3 Code when you sign in to this Mac, so agents, the Runner and channels come back on their own.",
  win32:
    "Start T3 Code when you sign in to this computer, so agents, the Runner and channels come back on their own.",
} as const;

const TURNED_OFF_IN_SYSTEM = {
  darwin: "Turned off in System Settings → Login Items. Turn T3 Code on there to finish.",
  win32: "Turned off in Task Manager → Startup apps.",
} as const;

export interface OpenAtLoginRowView {
  readonly checked: boolean;
  readonly description: string;
  readonly notice: string | null;
  readonly canOpenSystemSettings: boolean;
}

/** `status` is null in unpackaged builds, where only the setting exists. */
export function openAtLoginRowView(state: DesktopOpenAtLoginState): OpenAtLoginRowView {
  const turnedOffInSystem = state.enabled && state.status === "requires-approval";
  const registrationFailed = state.enabled && state.status === "not-registered";
  return {
    checked: state.enabled && !registrationFailed,
    description: DESCRIPTIONS[state.platform],
    notice: turnedOffInSystem
      ? TURNED_OFF_IN_SYSTEM[state.platform]
      : registrationFailed
        ? OPEN_AT_LOGIN_FAILED
        : null,
    canOpenSystemSettings: turnedOffInSystem && state.platform === "darwin",
  };
}
