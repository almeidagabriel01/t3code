import type { MacPermissionPane, MacPermissionStatus, MacPermissions } from "@t3tools/contracts";

export interface MacPermissionRow {
  readonly key: Exclude<keyof MacPermissions, "supported">;
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
      "Lets agents type and press keys through System Events, once you approve each one.",
  },
];

export const macPermissionStatusLabel = (status: MacPermissionStatus): string =>
  status === "granted" ? "Granted" : status === "denied" ? "Not granted" : "Unknown";
