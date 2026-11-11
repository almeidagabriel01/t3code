import type {
  ComputerUseCapabilityKey,
  ComputerUseCapabilityState,
  ComputerUseHostReport,
  MacPermissionPane,
  MacPermissionStatus,
  MacPermissions,
} from "@t3tools/contracts";

export interface MacPermissionRow {
  readonly key: Exclude<keyof MacPermissions, "supported" | "host">;
  readonly pane: MacPermissionPane;
  readonly label: string;
  readonly description: string;
}

/** What each permission lets agents do. Shared by web and mobile so both read the same. */
export const MAC_PERMISSION_ROWS: ReadonlyArray<MacPermissionRow> = [
  {
    key: "screenRecording",
    pane: "screen-recording",
    label: "Screen Recording",
    description: "Lets agents take screenshots of your screen.",
  },
  {
    key: "accessibility",
    pane: "accessibility",
    label: "Accessibility",
    description: "Lets agents click, once you approve each click.",
  },
  {
    key: "automation",
    pane: "automation",
    label: "Automation",
    description:
      "Lets agents type and press keys through System Events, once you approve each one. Checked when you press Check again, since macOS may ask.",
  },
];

/** `checked` is false for a status that was deliberately not read, such as Automation before Check again. */
export const macPermissionStatusLabel = (status: MacPermissionStatus, checked = true): string =>
  !checked
    ? "Not checked"
    : status === "granted"
      ? "Granted"
      : status === "denied"
        ? "Not granted"
        : "Unknown";

/** Windows and Linux hosts have no permissions to grant; they report what the platform allows. */
export const isComputerUseHostOs = (os: string | undefined): os is "win32" | "linux" =>
  os === "win32" || os === "linux";

export const COMPUTER_USE_CAPABILITY_LABELS: Record<ComputerUseCapabilityKey, string> = {
  elements: "App controls",
  screenshot: "Screenshots",
  pointer: "Clicks by screen position",
  keyboard: "Key presses",
};

const CAPABILITY_STATE_LABELS: Record<ComputerUseCapabilityState, string> = {
  available: "Supported",
  consent: "Asks you first",
  limited: "Limited",
  unavailable: "Not supported",
};
export const computerUseCapabilityStateLabel = (state: ComputerUseCapabilityState): string =>
  CAPABILITY_STATE_LABELS[state];

export const computerUseHostLabel = (host: ComputerUseHostReport): string =>
  host.os === "win32"
    ? "Windows"
    : host.display === "wayland"
      ? "Linux, Wayland session"
      : host.display === "x11"
        ? "Linux, X11 session"
        : "Linux, no desktop session";

export const COMPUTER_USE_HOST_INTRO =
  "What agents can do on this computer. Every click, typed text and key press still asks for your approval first.";
export const COMPUTER_USE_HOST_NOT_REPORTED =
  "This computer does not report what agents can do there. Update T3 Code on it.";
