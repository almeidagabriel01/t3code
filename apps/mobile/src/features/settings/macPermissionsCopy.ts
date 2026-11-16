import { MAC_PERMISSION_ROWS } from "@t3tools/client-runtime/state/mac-permissions";

/** The Mac permissions page's fixed labels; Settings search reads these same strings. */
export const MAC_PERMISSIONS_COPY = {
  intro:
    "What macOS lets T3 Code do on the Mac that runs it. Agents can take screenshots, and click or type only after you approve each action. Grant the permissions in System Settings on that Mac.",
  permissions: "Permissions",
  openOnMac: "Open on the Mac",
} as const;

export const MAC_PERMISSIONS_PAGE_LABELS: readonly string[] = [
  ...Object.values(MAC_PERMISSIONS_COPY),
  ...MAC_PERMISSION_ROWS.flatMap(({ label, description }) => [label, description]),
  // macOS lists these under Privacy & Security; computer use needs them.
  "privacy",
  "computer use",
];
