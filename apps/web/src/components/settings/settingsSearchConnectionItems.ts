import {
  COMPUTER_USE_CAPABILITY_LABELS,
  MAC_PERMISSION_ROWS,
} from "@t3tools/client-runtime/state/mac-permissions";
import type { ComputerUseCapabilityKey } from "@t3tools/contracts";
import type { SettingsSearchItem } from "./settingsSearch";

export const CONNECTION_SETTINGS_COPY = {
  deviceHubVersions: "Hub:",
  agentDeviceVersions: "agent-device:",
  networkAccessNoControl: "This connection cannot view or change network exposure.",
  networkAccessRemoteConfigured:
    "Remote access is already configured. Change network exposure where the server starts.",
  networkAccessLoopback:
    "Only this machine can connect. Restart with a non-loopback host for remote pairing.",
  networkAccessUnavailable: "Network exposure information is unavailable.",
  primaryEnvironmentTitle: "Primary environment",
  projectIconAutomatic: "Automatic",
  projectArchivedHidden: "Hidden from project pickers. Threads and files are kept.",
  removeCheckoutTitle: "Remove checkout",
  removeCheckoutDescription:
    "Deletes the selected machine's checkout entries and their threads. Other machines and files on disk are not touched.",
  removeEverywhereTitle: "Remove this project everywhere",
  removeEverywhereDescription: (count: number) =>
    `Deletes all ${count} checkout entries and their threads on every machine. Files on disk are not touched.`,
  t3ConnectSignedOut:
    "Sign in to make this environment available to your other devices through T3 Connect.",
  t3ConnectRevoked: "This environment was removed from T3 Connect. Turn it on to link it again.",
  t3ConnectUnreachable: "T3 Connect is on, but other devices cannot reach this environment.",
  t3ConnectReachable: "This environment is available to your other devices through T3 Connect.",
  t3ConnectNotChecked: "T3 Connect is on. Reachability has not been checked yet.",
  t3ConnectOutOfSync:
    "T3 Connect is out of sync. This environment is linked only to publish agent activity, so other devices cannot connect. Turn T3 Connect on to repair it.",
  t3ConnectLinkAgain:
    "This environment was removed from T3 Connect. Run `t3 connect link` on the host to link it again.",
  t3ConnectLinkOnHost: "Run `t3 connect link` on the host, then restart T3 Code there.",
  t3ConnectPermissions:
    "To edit these settings, pair this connection with both View relay and Manage relay permissions.",
  publishSignedOut: "Sign in to send activity to mobile notifications and Live Activities.",
  deviceHostFallback: "Device host",
  linkClientBlocked: "Shut out: it cannot list, watch or drive any device here.",
  linkClientAllowed: "Can use devices here under the access settings above.",
  linkedSourceHidden: "Hidden: its devices are not listed here or offered to agents.",
  linkedSourceListed: "Listed when it next answers.",
  agentBrowserAccessProject:
    "Allow agents in this project to use the shared browser. Applies when the agent session next starts.",
} as const;

const MAC_PERMISSION_SEARCH_ITEMS = MAC_PERMISSION_ROWS.map((row) => ({
  id: `mac-permission-${row.key}` as const,
  title: row.label,
  description: row.description,
  to: "/settings/mac-permissions" as const,
  targetId: "mac-permissions",
}));

const COMPUTER_USE_CAPABILITY_SEARCH_ITEMS = (
  Object.keys(COMPUTER_USE_CAPABILITY_LABELS) as ComputerUseCapabilityKey[]
).map((key) => ({
  id: `computer-use-${key}` as const,
  title: COMPUTER_USE_CAPABILITY_LABELS[key],
  to: "/settings/computer-use" as const,
  targetId: "computer-use",
}));

export const CONNECTION_SETTINGS_SEARCH_ITEMS = [
  ...MAC_PERMISSION_SEARCH_ITEMS,
  ...COMPUTER_USE_CAPABILITY_SEARCH_ITEMS,
  {
    id: "devices",
    title: "Devices",
    to: "/settings/devices",
  },
  {
    id: "phone-wifi-pairing",
    title: "Phone over Wi-Fi",
    description: "Pair an Android phone on the same network by scanning a QR code with it.",
    to: "/settings/devices",
    targetId: "devices",
  },
  {
    id: "browser-search-engine-custom",
    title: "Custom search URL",
    description: "Use %s where the search terms go.",
    to: "/settings/browser",
    targetId: "browser-search-engine",
  },
  {
    id: "browser-agent-access",
    title: "Agent access",
    to: "/settings/browser",
    scope: "project-defaults",
  },
  {
    id: "browser",
    title: "Browsing",
    to: "/settings/browser",
  },
  {
    id: "browser-recordings",
    title: "Recordings",
    to: "/settings/browser",
  },
  {
    id: "integrations-other",
    title: "Other",
    to: "/settings/integrations",
  },
  {
    id: "kanban-view",
    title: "Boards",
    to: "/settings/kanban",
  },
  {
    id: "kanban-board-to-configure",
    title: "Board to configure",
    description: "Automations, templates and labels belong to a single board.",
    to: "/settings/kanban",
    targetId: "kanban-view",
  },
  {
    id: "kanban-agents",
    title: "Agent integration",
    to: "/settings/kanban",
  },
  {
    id: "kanban-new-board-defaults",
    title: "Default for new boards",
    to: "/settings/kanban",
  },
  {
    id: "kanban-add-column",
    title: "Add a column",
    to: "/settings/kanban",
  },
  {
    id: "kanban-default-card-templates",
    title: "Default card templates",
    to: "/settings/kanban",
  },
  {
    id: "wsl-only",
    title: "WSL only",
    description: "Run only the WSL backend. T3 Code restarts when this changes.",
    to: "/settings/access",
    targetId: "wsl-backend",
    desktopOnly: true,
    windowsOnly: true,
    localBackendManagementOnly: true,
    wslAvailableOnly: true,
  },
  {
    id: "server-version",
    title: "Version",
    to: "/settings/access",
    targetId: "connections-environment",
    localBackendManagementOnly: true,
  },
  {
    id: "this-app",
    title: "This app",
    to: "/settings/connections",
    desktopOnly: true,
  },
  {
    id: "scheduled-tasks",
    title: "Scheduled tasks",
    to: "/settings/scheduled-tasks",
  },
  {
    id: "project-checkouts",
    title: "Checkouts",
    to: "/settings/projects",
  },
  {
    id: "project-name",
    title: "Name",
    description: "The shared name for this project group in the sidebar and thread lists.",
    to: "/settings/projects",
  },
  {
    id: "project-icon",
    title: "Project icon",
    to: "/settings/projects",
    searchTerms: [CONNECTION_SETTINGS_COPY.projectIconAutomatic],
  },
  {
    id: "project-pin",
    title: "Pin",
    description: "Pinned projects come first in project pickers.",
    to: "/settings/projects",
    targetId: "project-overview",
  },
  {
    id: "project-archive",
    title: "Archive",
    description: "Hides the project from project pickers. Threads and files are kept.",
    to: "/settings/projects",
    targetId: "project-overview",
    searchTerms: [CONNECTION_SETTINGS_COPY.projectArchivedHidden],
  },
  {
    id: "project-danger",
    title: "Danger",
    to: "/settings/projects",
  },
  {
    id: "project-remove",
    title: "Remove project",
    description: "Deletes the project entry and its threads. Files on disk are not touched.",
    to: "/settings/projects",
    targetId: "project-danger",
    searchTerms: [
      CONNECTION_SETTINGS_COPY.removeCheckoutTitle,
      CONNECTION_SETTINGS_COPY.removeCheckoutDescription,
      CONNECTION_SETTINGS_COPY.removeEverywhereTitle,
      CONNECTION_SETTINGS_COPY.removeEverywhereDescription(2),
    ],
  },
  {
    id: "device-access",
    title: "Device access",
    to: "/settings/devices",
    targetId: "devices",
    searchTerms: [CONNECTION_SETTINGS_COPY.deviceHostFallback],
  },
  {
    id: "device-signing",
    title: "iPhone signing",
    to: "/settings/devices",
  },
  {
    id: "apple-team-id",
    title: "Apple Team ID",
    description:
      "Agents need your team id to sign the runner they install on a USB iPhone. Find it under Membership in your Apple Developer account.",
    to: "/settings/devices",
    targetId: "device-signing",
  },
  {
    id: "apple-runner-bundle-id",
    title: "Runner bundle id (optional)",
    description:
      "Leave empty to use the default. Set it when the default id is taken by another team.",
    to: "/settings/devices",
    targetId: "device-signing",
  },
  {
    id: "device-first-run",
    title: "First run on the phone",
    description:
      "Trust the developer profile in Settings, General, VPN & Device Management, and turn on Developer Mode in Privacy & Security.",
    to: "/settings/devices",
    targetId: "device-signing",
  },
  {
    id: "device-link-requests",
    title: "Device requests",
    to: "/settings/devices",
    targetId: "devices",
  },
  {
    id: "device-link-clients",
    title: "Linked environments using devices here",
    to: "/settings/devices",
    targetId: "devices",
    searchTerms: [
      CONNECTION_SETTINGS_COPY.linkClientBlocked,
      CONNECTION_SETTINGS_COPY.linkClientAllowed,
    ],
  },
  {
    id: "device-linked-sources",
    title: "Devices from linked environments",
    to: "/settings/devices",
    targetId: "devices",
    searchTerms: [
      CONNECTION_SETTINGS_COPY.linkedSourceHidden,
      CONNECTION_SETTINGS_COPY.linkedSourceListed,
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
