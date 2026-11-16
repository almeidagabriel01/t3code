import { HOSTED_APP_CHANNEL } from "~/branding";
import { isElectron, isSecretsFeatureEnabled } from "~/env";
import { isMacPlatform, isWindowsPlatform, normalizeSearchText } from "~/lib/utils";
import {
  MAX_FALLBACK_MODEL_SELECTIONS,
  PROVIDER_DISPLAY_NAMES,
  STATIC_KEYBINDING_COMMANDS,
  type KeybindingCommand,
} from "@t3tools/contracts";
import type { EnvironmentId, IntegrationsState } from "@t3tools/contracts";
import { integrationDirectory } from "@t3tools/client-runtime/integrations";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  COMPUTER_USE_HOST_INTRO,
  COMPUTER_USE_HOST_NOT_REPORTED,
} from "@t3tools/client-runtime/state/mac-permissions";
import {
  HEAVY_LIMIT_COPY,
  HEAVY_NOTICES_COPY,
  RUNNER_SETTING_COPY,
} from "@t3tools/client-runtime/state/runnerModel";
import { GLASS_SETTINGS_SEARCH_ITEMS } from "./settingsSearchGlassItems";
import {
  PROVIDER_SETTINGS_COPY,
  PROVIDER_SETTINGS_SEARCH_ITEMS,
} from "./settingsSearchProviderItems";
import { GENERAL_SETTINGS_COPY, GENERAL_SETTINGS_SEARCH_ITEMS } from "./settingsSearchGeneralItems";
import { MEMORY_SETTINGS_SEARCH_ITEMS } from "./settingsSearchMemoryItems";
import { ASSISTANT_SETTINGS_SEARCH_ITEMS } from "./settingsSearchAssistantItems";
import {
  MAINTENANCE_SETTINGS_COPY,
  MAINTENANCE_SETTINGS_SEARCH_ITEMS,
} from "./settingsSearchMaintenanceItems";
import {
  CONNECTION_SETTINGS_COPY,
  CONNECTION_SETTINGS_SEARCH_ITEMS,
} from "./settingsSearchConnectionItems";
import { hasDesktopWindowMaterialApi } from "../../desktop/useDesktopWindowMaterial";
import {
  sourceControlClients,
  type SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import { DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Schema from "effect/Schema";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { writeLocalStorageValue } from "../../hooks/useLocalStorage";
import { commandLabel } from "./KeybindingsSettings.logic";
import type { ResolvedSettingsScope } from "./settingsScope";

export type SettingsPath =
  | "/settings/projects"
  | "/settings/general"
  | "/settings/diagnostics"
  | "/settings/voice"
  | "/settings/appearance"
  | "/settings/chat"
  | "/settings/diffs"
  | "/settings/keybindings"
  | "/settings/snap-shot"
  | "/settings/providers"
  | "/settings/assistants"
  | "/settings/integrations"
  | "/settings/imessage"
  | "/settings/telegram"
  | "/settings/memory"
  | "/settings/threads"
  | "/settings/browser"
  | "/settings/devices"
  | "/settings/mac-permissions"
  | "/settings/computer-use"
  | "/settings/scheduled-tasks"
  | "/settings/kanban"
  | "/settings/source-control"
  | "/settings/worktrees"
  | "/settings/status-bar"
  | "/settings/fork-updates"
  | "/settings/connections"
  | "/settings/access"
  | "/settings/secrets"
  | "/settings/maintenance"
  | "/settings/labs"
  | "/settings/about"
  | "/settings/archived";

export type SettingsSearchScope =
  | "environment"
  | "environment-defaults"
  | "project-defaults"
  | "project"
  | "checkout"
  | "connections";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  /** The description the row draws under its title, read by the row itself. */
  readonly description?: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  readonly searchTerms?: ReadonlyArray<string>;
  /** The machine a setting belongs to, beside the page name, where titles repeat across machines. */
  readonly machine?: "This Mac" | "Linux PC";
  readonly scope?: SettingsSearchScope;
  readonly desktopOnly?: boolean;
  readonly macOnly?: boolean;
  readonly windowsOnly?: boolean;
  /** macOS and Windows, where the desktop app can register a login item. */
  readonly loginItemsOnly?: boolean;
  readonly releaseChannelOnly?: boolean;
  readonly secretsFeatureOnly?: boolean;
  readonly cloudOnly?: boolean;
  readonly environmentOnly?: boolean;
  readonly providerSettingsOnly?: boolean;
  readonly localBackendManagementOnly?: boolean;
  readonly localEnvironmentOnly?: boolean;
  readonly primaryEnvironmentOnly?: boolean;
  readonly wslAvailableOnly?: boolean;
  readonly managedTunnelOnly?: boolean;
  readonly peerLinksOnly?: boolean;
  readonly requiresMemory?: boolean;
  readonly requiresIntegrations?: boolean;
  readonly requiresImessage?: boolean;
  readonly requiresTelegram?: boolean;
  readonly macProviderSettingsOnly?: boolean;
  /** Needs a connected Windows or Linux host, which has no permissions page. */
  readonly computerUseHostOnly?: boolean;
  readonly fastWorktreeCheckoutOnly?: boolean;
  readonly textGeneratorsOnly?: boolean;
  readonly secondary?: boolean;
  readonly requiresThreadAutoSettlement?: boolean;
  readonly requiresDesktopWindowMaterial?: boolean;
}

export interface SettingsSearchAvailability {
  readonly localEnvironmentDisabled?: boolean;
  readonly hasCloudPublicConfig: boolean;
  readonly hasEnvironment: boolean;
  readonly hasProviderSettingsEnvironment: boolean;
  readonly canManageLocalBackend: boolean;
  readonly isWslSettingsRowVisible: boolean;
  readonly hasThreadAutoSettlement: boolean;
  readonly managedTunnelActive?: boolean;
  readonly hasPeerLinkHost?: boolean;
  readonly hasMemory?: boolean;
  readonly hasIntegrations?: boolean;
  readonly hasImessage?: boolean;
  readonly hasTelegram?: boolean;
  readonly hasMacProviderSettingsEnvironment?: boolean;
  readonly hasComputerUseHostEnvironment?: boolean;
  readonly hasFastWorktreeCheckoutEnvironment?: boolean;
  /** An environment without a provider allow-list, which hides text generators. */
  readonly hasTextGeneratorsEnvironment?: boolean;
  readonly hasPrimaryEnvironment?: boolean;
}

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/diagnostics": "Diagnostics",
  "/settings/projects": "Projects",
  "/settings/general": "General",
  "/settings/appearance": "Appearance",
  "/settings/chat": "Chat",
  "/settings/diffs": "Diffs & pull requests",
  "/settings/keybindings": "Keybindings",
  "/settings/snap-shot": "SnapShots",
  "/settings/providers": "Providers",
  "/settings/assistants": "Assistants",
  "/settings/integrations": "Integrations",
  "/settings/imessage": "iMessage",
  "/settings/telegram": "Telegram",
  "/settings/memory": "Memory",
  "/settings/threads": "Threads",
  "/settings/browser": "Browser",
  "/settings/devices": "Devices",
  "/settings/mac-permissions": "Mac permissions",
  "/settings/computer-use": "Computer use",
  "/settings/scheduled-tasks": "Scheduled tasks",
  "/settings/kanban": "Kanban",
  "/settings/source-control": "Source control",
  "/settings/worktrees": "Worktrees",
  "/settings/status-bar": "Status bar",
  "/settings/fork-updates": "Fork updates",
  "/settings/connections": "Environments",
  "/settings/access": "Sharing & access",
  "/settings/secrets": "Secrets",
  "/settings/maintenance": "Maintenance",
  "/settings/labs": "Labs",
  "/settings/about": "About",
  "/settings/voice": "Voice",
  "/settings/archived": "Archive",
};

/** Sidebar order. A group without a heading is set apart by space alone. */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  readonly heading: string | null;
  readonly paths: ReadonlyArray<SettingsPath>;
}> = [
  {
    heading: null,
    paths: [
      "/settings/general",
      "/settings/appearance",
      "/settings/status-bar",
      "/settings/chat",
      "/settings/diffs",
      "/settings/keybindings",
      "/settings/voice",
      "/settings/snap-shot",
    ],
  },
  {
    heading: "Agents",
    paths: [
      "/settings/providers",
      "/settings/assistants",
      "/settings/integrations",
      "/settings/imessage",
      "/settings/telegram",
      "/settings/memory",
      "/settings/threads",
      "/settings/browser",
      "/settings/devices",
      "/settings/mac-permissions",
      "/settings/computer-use",
      "/settings/scheduled-tasks",
      "/settings/kanban",
    ],
  },
  {
    heading: "Code",
    paths: ["/settings/projects", "/settings/source-control", "/settings/worktrees"],
  },
  {
    heading: "Connections",
    paths: [
      "/settings/connections",
      "/settings/access",
      ...(isSecretsFeatureEnabled ? (["/settings/secrets"] as const) : []),
    ],
  },
  {
    heading: null,
    paths: [
      "/settings/fork-updates",
      "/settings/maintenance",
      "/settings/labs",
      "/settings/about",
      "/settings/archived",
    ],
  },
];

export function keybindingSearchAnchorId<Command extends KeybindingCommand>(command: Command) {
  return `keybinding-${command}` as const;
}

const KEYBINDING_SEARCH_ITEMS = STATIC_KEYBINDING_COMMANDS.toSorted((left, right) =>
  commandLabel(left).localeCompare(commandLabel(right)),
).map((command) => {
  const defaultKeys = DEFAULT_KEYBINDINGS.filter((binding) => binding.command === command).map(
    (binding) => binding.key,
  );
  return {
    id: keybindingSearchAnchorId(command),
    title: commandLabel(command),
    to: "/settings/keybindings" as const,
    searchTerms: [command, ...defaultKeys],
    secondary: true,
    ...(defaultKeys.length === 0 ? { targetId: "keybindings" } : {}),
  };
});

const PROVIDER_NAME_SEARCH_ITEMS = Object.entries(PROVIDER_DISPLAY_NAMES).flatMap(
  ([driver, name]) =>
    name === undefined
      ? []
      : [
          {
            id: `provider-name-${driver}` as const,
            title: name,
            to: "/settings/providers" as const,
            targetId: "providers",
          },
        ],
);

export function sourceControlHostSettingsSearchId(kind: string) {
  return `source-control-host-${kind}` as const;
}

/** Each host's own settings: its accounts and token, or the fields of its settings form. */
export function sourceControlHostSearchItems(
  definitions: ReadonlyArray<SourceControlDefinition>,
): ReadonlyArray<
  SettingsSearchItem & { readonly id: ReturnType<typeof sourceControlHostSettingsSearchId> }
> {
  return definitions.flatMap((definition) => {
    if (!definition.settings) return [];
    const names = [definition.label, ...(definition.searchKeywords ?? [])].join(" ");
    const { credentials } = definition;
    return [
      {
        id: sourceControlHostSettingsSearchId(definition.kind),
        title: credentials
          ? `${definition.label} accounts and token`
          : `${definition.label} credentials`,
        to: "/settings/source-control" as const,
        searchTerms: [
          credentials
            ? `${names} ${credentials.cliName} account login user host switch multiple accounts disable sign in token personal access token pat api key credential`
            : `${names} ${Object.keys(definition.settings.fields).join(" ")} token credentials sign in`,
        ],
        environmentOnly: true,
        scope: "environment-defaults" as const,
      },
    ];
  });
}

/** Each integration the directory draws on a connected environment, by the name and blurb it shows. */
export function integrationSearchItems(
  states: ReadonlyArray<IntegrationsState>,
): ReadonlyArray<SettingsSearchItem> {
  const rows = new Map<string, SettingsSearchItem>();
  for (const state of states) {
    const { connected, available, other } = integrationDirectory(state, {
      query: "",
      category: null,
    });
    for (const row of [...connected, ...available, ...other]) {
      if (rows.has(row.key)) continue;
      rows.set(row.key, {
        id: `integration-${row.key}`,
        title: row.title,
        searchTerms: [row.description],
        to: "/settings/integrations",
        targetId: "integrations",
      });
    }
  }
  return [...rows.values()];
}

/** For settings that apply to every host. */
const SOURCE_CONTROL_HOST_LABELS = sourceControlClients.definitions
  .map((definition) => definition.label)
  .join(" ");
const SOURCE_CONTROL_HOST_TERMS = sourceControlClients.definitions
  .flatMap((definition) => [definition.label, ...(definition.searchKeywords ?? [])])
  .join(" ");

export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "memory-records",
    title: "Memories",
    to: "/settings/memory",
    requiresMemory: true,
    searchTerms: ["forget", "conflict", "quarantine", "revert"],
  },
  {
    id: "storage-worktree-keep-when",
    targetId: "storage-worktrees",
    title: "Keep worktrees with local changes",
    description: "Includes ignored files, except node_modules.",
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: [
      "any local files uncommitted changes edited tracked files ignored env build output cleanup",
      MAINTENANCE_SETTINGS_COPY.keepWhenTracked,
      MAINTENANCE_SETTINGS_COPY.keepWhenUncommitted,
    ],
  },
  {
    id: "storage-delete-now",
    title: "Delete now",
    description: "Turn on a cleanup rule to use this.",
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: ["storage cleanup run now results report removed kept failed"],
  },
  {
    id: "storage-worktrees",
    title: "Cleanup",
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: [
      "worktree cleanup disk storage automatic delete unchanged worktrees retention days project",
    ],
  },
  {
    id: "storage-worktrees-location",
    title: "Worktree location",
    description:
      "Folder where new worktrees are created, on any drive, such as D:\\worktrees or ~/worktrees. Existing worktrees stay where they are. Leave empty to use the T3 home folder.",
    to: "/settings/worktrees",
    scope: "environment-defaults",
    searchTerms: ["worktree location folder directory path drive external disk"],
  },
  {
    id: "storage-artifacts",
    title: "Artifacts and logs",
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: ["disk storage screenshots captures cleanup retention"],
  },
  {
    id: "project-defaults",
    title: "Project defaults and overrides",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["model workspace environments projects inheritance checkout"],
  },
  {
    id: "project-overview",
    title: "Project overview",
    to: "/settings/projects",
    searchTerms: ["name icon emoji image checkout remove delete"],
  },
  {
    id: "default-model",
    title: "Model",
    description: "Default model for new threads. Projects can override it.",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: [
      "default model new thread project provider reasoning effort",
      PROVIDER_SETTINGS_COPY.projectModel,
      PROVIDER_SETTINGS_COPY.automaticModel,
    ],
  },
  {
    id: "fallback-model",
    title: "Fallback models",
    description: `Tried in order for new threads when the default model's provider is out of usage. Up to ${MAX_FALLBACK_MODEL_SELECTIONS}.`,
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: ["fallback agent provider out of usage new threads"],
    environmentOnly: true,
  },
  {
    id: "default-permissions",
    title: "Permissions",
    description: "Default permissions for new threads. Projects can override them.",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: [
      "new thread default runtime mode supervised approvals auto accept edits full access",
      PROVIDER_SETTINGS_COPY.projectPermissions,
    ],
  },
  {
    id: "color-scheme",
    title: "Color scheme",
    to: "/settings/appearance",
    searchTerms: ["appearance light dark system mode"],
    targetId: "appearance",
  },
  {
    id: "theme",
    title: "Themes",
    to: "/settings/appearance",
    searchTerms: ["appearance colors palette custom import"],
    targetId: "appearance",
  },
  {
    // Prefixed because the slider control already owns the `appearance-contrast` id.
    id: "setting-appearance-contrast",
    description: "Adjust the contrast of colors and borders across the interface.",
    title: "Contrast",
    to: "/settings/appearance",
    searchTerms: ["colors borders interface"],
  },
  ...GLASS_SETTINGS_SEARCH_ITEMS,
  {
    id: "diff-color-scheme",
    description: "Choose colors for additions and deletions, including change counts.",
    title: "Diff colors",
    to: "/settings/diffs",
    searchTerms: ["red green blue orange additions deletions changes counts palette colorblind"],
  },
  {
    id: "chat-width",
    description: "Set how wide messages and the composer can grow on large screens.",
    title: "Chat width",
    to: "/settings/appearance",
    searchTerms: ["wide full width column layout messages composer monitor"],
  },
  {
    id: "thread-details-items",
    description: "Choose what the thread details card shows. You can also right-click the card.",
    title: "Thread details",
    to: "/settings/appearance",
    searchTerms: [
      "customize show hide panel card environment editor scripts branch pull request git changes servers automations lineage usage limits 5 hour weekly quota tokens context window",
    ],
  },
  {
    id: "right-panel-quick-buttons",
    description:
      "Choose which quick buttons appear under the right panel's tabs, and their order. You can also right-click the buttons.",
    title: "Panel shortcuts",
    to: "/settings/appearance",
    searchTerms: [
      "customize right panel quick buttons shortcuts files diff terminal browser notes side chat device pull requests reorder",
    ],
  },
  {
    id: "effort-display",
    description: "Show reasoning effort in the composer as its name, such as High, or as bars.",
    title: "Effort display",
    to: "/settings/appearance",
    searchTerms: ["reasoning effort thinking bars graph word label level composer"],
  },
  {
    id: "math-rendering",
    description:
      "Typeset LaTeX math, such as $x^2$ or \\[x^2\\], in messages and Markdown previews. The composer keeps TeX source editable.",
    title: "Render math",
    to: "/settings/appearance",
    searchTerms: ["latex tex katex equations formulas markdown"],
  },
  {
    id: "panel-animations",
    description: "Set how fast panels open and close.",
    title: "Panel animations",
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    title: "Environment identification",
    to: "/settings/appearance",
    searchTerms: ["dev nightly latest channel artwork pill label hide none"],
    targetId: "appearance-interface",
  },
  {
    id: "interface-font",
    title: "Interface font",
    description: "Everything outside code blocks and the terminal.",
    to: "/settings/appearance",
    searchTerms: ["typography family size system sans"],
  },
  {
    id: "prompt-font",
    title: "Prompt font",
    description: "Only the box you write prompts in. Mono works well here.",
    to: "/settings/appearance",
    searchTerms: ["typography family size composer input"],
  },
  {
    id: "code-font",
    title: "Code font",
    description: "Code blocks, diffs, and file previews.",
    to: "/settings/appearance",
    searchTerms: ["typography family size monospace code blocks diffs file previews"],
  },
  {
    id: "terminal-font",
    title: "Terminal font",
    description: "Terminal output, independent from code blocks and diffs.",
    to: "/settings/appearance",
    searchTerms: ["typography family size monospace output"],
  },
  {
    id: "separate-fonts",
    description:
      "Set the prompt, code, and terminal fonts separately instead of one monospace font.",
    title: "Separate fonts",
    to: "/settings/appearance",
    searchTerms: ["typography advanced prompt code terminal font family size individually"],
  },
  {
    id: "font-smoothing",
    description: "Use thinner grayscale text smoothing instead of the macOS default.",
    title: "Font smoothing",
    to: "/settings/appearance",
    searchTerms: ["typography text grayscale anti aliasing macos thin"],
    macOnly: true,
  },
  {
    id: "word-wrap",
    description: "Wrap long lines in code blocks, diffs, and file previews by default.",
    title: "Word wrap",
    to: "/settings/appearance",
    searchTerms: ["long lines code blocks diffs file previews"],
  },
  {
    id: "composer-context",
    description: "Keep branch and worktree controls below the composer after a thread starts.",
    title: "Composer context",
    to: "/settings/appearance",
  },
  {
    id: "project-grouping",
    description: "Combine matching repositories across environments.",
    title: "Project grouping",
    to: "/settings/general",
    searchTerms: ["combine matching repositories environments sidebar"],
  },
  {
    id: "project-order",
    description: "Order of projects in the sidebar project picker and command palette.",
    title: "Project order",
    to: "/settings/general",
    searchTerms: ["sort projects sidebar manual created recent"],
  },
  {
    id: "snooze-options",
    description:
      "Choices in every snooze menu, listed soonest first. Weekdays mean the next one after today.",
    title: "Snooze options",
    to: "/settings/threads",
    searchTerms: ["snooze presets times later tonight tomorrow next week remind"],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "snooze-limited-threads",
    description:
      "Snooze threads until their usage limits reset. Enable auto-resume to continue the agent after the reset.",
    title: "Snooze until limits reset",
    to: "/settings/threads",
    searchTerms: ["usage quota rate limit reset wake recover continue"],
  },
  {
    id: "auto-resume-limited-threads",
    description:
      "Automatically resume threads when their usage limits reset. You can cancel auto-resume in each thread.",
    title: "Resume after usage limits",
    to: "/settings/threads",
    searchTerms: ["usage quota rate limit reset recover continue"],
  },
  {
    id: "thread-order",
    description:
      "What needs you or finished unseen comes first, then running agents, then the rest.",
    title: "Thread order",
    to: "/settings/general",
    searchTerms: [
      "sort threads sidebar fixed recent activity move top reorder drag",
      GENERAL_SETTINGS_COPY.threadOrderFixed,
    ],
  },
  {
    id: "two-line-rows",
    description:
      "Show active and pinned threads on two lines: the title, then the branch, pull request, and agent.",
    title: "Two-line thread rows",
    to: "/settings/general",
    searchTerms: ["sidebar thread rows multiline branch pull request details compact"],
  },
  {
    id: "sidebar-show-assistants-section",
    description:
      "List your assistants and groups above the projects, with the threads they started under them.",
    title: "Show Teams section",
    to: "/settings/general",
    searchTerms: ["sidebar assistants teams groups jarvis pinned hide"],
  },
  {
    id: "sidebar-show-subagents",
    description: "List a thread's active subagents under it in the sidebar.",
    title: "Show subagents",
    to: "/settings/general",
    searchTerms: ["sidebar child agents nested threads"],
  },
  {
    id: "sidebar-agent-activity",
    description: "Compact folds several subagents into one summary row. Full lists every one.",
    title: "Agent activity",
    to: "/settings/general",
    searchTerms: ["sidebar subagents compact full summary rows"],
  },
  {
    id: "project-hover-card",
    description:
      "Choose what the card shows when you hover a project. Turn everything off to disable the card.",
    title: "Project hover card",
    to: "/settings/general",
    searchTerms: ["sidebar hover preview ports terminals resources path"],
  },
  {
    id: "mac-permissions",
    title: "Mac permissions",
    to: "/settings/mac-permissions",
    searchTerms: [
      "computer use screen recording accessibility automation click screenshot privacy system settings",
    ],
    macProviderSettingsOnly: true,
  },
  {
    id: "computer-use",
    title: "Computer use",
    description: COMPUTER_USE_HOST_INTRO,
    to: "/settings/computer-use",
    searchTerms: [
      "windows linux wayland x11 screenshot click type keys desktop control agents capabilities",
      COMPUTER_USE_HOST_NOT_REPORTED,
    ],
    computerUseHostOnly: true,
  },
  {
    id: "fork-updates-folder",
    title: "Fork checkout folder",
    description: "Your fork's git checkout on this machine. Leave empty for ~/DEV/Pessoal/t3code.",
    to: "/settings/fork-updates",
    desktopOnly: true,
    searchTerms: ["fork upstream merge update checkout path git"],
  },
  {
    id: "fork-updates-channel",
    title: "Fork update channel",
    description:
      "Stable and nightly are different apps. Auto follows the version your fork is built from.",
    to: "/settings/fork-updates",
    desktopOnly: true,
    searchTerms: ["stable nightly release channel upstream tag"],
  },
  {
    id: "fork-updates-status",
    title: "Fork updates",
    to: "/settings/fork-updates",
    desktopOnly: true,
    searchTerms: [
      "upstream behind release check update now resolve agent conflict merge",
      MAINTENANCE_SETTINGS_COPY.forkChecking,
      MAINTENANCE_SETTINGS_COPY.forkNoCheckout,
      MAINTENANCE_SETTINGS_COPY.forkAddProject,
    ],
  },
  {
    id: "status-bar-visible",
    description:
      "Show a bar along the bottom of the window. Right-click it to choose what it shows.",
    title: "Status bar",
    to: "/settings/status-bar",
    searchTerms: ["show hide footer bottom bar usage ports resources"],
  },
  {
    id: "status-bar-segment-usage",
    description: "Provider usage limits and reset countdowns.",
    title: "Usage segment",
    to: "/settings/status-bar",
    searchTerms: ["status bar show hide provider limits countdown"],
  },
  {
    id: "status-bar-segment-ports",
    description: "Listening ports, with the processes that hold them.",
    title: "Ports segment",
    to: "/settings/status-bar",
    searchTerms: ["status bar show hide listening ports"],
  },
  {
    id: "status-bar-segment-resources",
    description: "Memory, CPU and running terminals.",
    title: "Resource usage segment",
    to: "/settings/status-bar",
    searchTerms: ["status bar show hide memory cpu terminals"],
  },
  {
    id: "status-bar-segment-keep-awake",
    description: "A coffee cup while this computer is being held awake.",
    title: "Keep awake segment",
    to: "/settings/status-bar",
    searchTerms: ["status bar show hide coffee sleep"],
  },
  {
    id: "status-bar-items",
    description: "Choose which accounts the usage segment shows. New accounts show by default.",
    title: "Status bar accounts",
    to: "/settings/status-bar",
    searchTerms: ["usage providers accounts claude codex instances choose which"],
  },
  {
    id: "status-bar-usage-mode",
    description:
      "Verbose shows a meter with each limit window. Compact shows only the tightest one.",
    title: "Usage display",
    to: "/settings/status-bar",
    searchTerms: ["status bar verbose compact tightest limit meter"],
  },
  {
    id: "status-bar-usage-percentage",
    description: "Show how much of each limit is used, or how much is left.",
    title: "Usage percentage",
    to: "/settings/status-bar",
    searchTerms: ["status bar used remaining left limit"],
  },
  {
    id: "status-bar-usage-reset",
    description:
      "Weekly limits show the day they reset, or the time when that is within 24 hours. The 5-hour session limit always shows its countdown.",
    title: "Reset shown as",
    to: "/settings/status-bar",
    searchTerms: ["usage limit reset day weekday countdown time left weekly"],
  },
  {
    id: "status-bar-usage-pace",
    description:
      "Mark where even spending would be on each limit, and show how far ahead or behind you are.",
    title: "Usage pace",
    to: "/settings/status-bar",
    searchTerms: ["usage expected pace marker tick deficit reserve points ahead behind"],
  },
  {
    id: "status-bar-usage-pace-in-bar",
    description:
      "Also show the pace marker and how far over or under pace you are in the bar itself. Off keeps it in the usage popover only.",
    title: "Pace in the status bar",
    to: "/settings/status-bar",
    searchTerms: ["usage expected pace bottom bar chip marker popover only"],
  },
  {
    id: "status-bar-usage-projection",
    description:
      "Project where each limit lands at reset, or when it runs out, once a fifteenth of the window has passed.",
    title: "Usage projection",
    to: "/settings/status-bar",
    searchTerms: ["usage projection forecast at reset runs out"],
  },
  {
    id: "status-bar-usage-daily-budget",
    description:
      "For weekly limits, show how much of the budget allowed through today you have used.",
    title: "Daily budget",
    to: "/settings/status-bar",
    searchTerms: ["usage weekly daily budget allowance today"],
  },
  {
    id: "status-bar-usage-thresholds",
    description:
      "Bars turn amber past the watch level and red past the critical level. Watch stays below critical.",
    title: "Usage thresholds",
    to: "/settings/status-bar",
    searchTerms: ["usage watch critical threshold color warning percent"],
  },
  {
    id: "status-bar-usage-sessions",
    description: "List the threads using each account in the usage popover.",
    title: "Sessions per account",
    to: "/settings/status-bar",
    searchTerms: ["usage sessions threads account working waiting roster"],
  },
  {
    id: "status-bar-usage-refresh",
    description:
      "How often usage limits are checked in the background. Usage also updates live while agents run. Paused while the window is hidden.",
    title: "Refresh usage",
    to: "/settings/status-bar",
    searchTerms: ["status bar usage limits poll interval automatic manual minutes background"],
  },
  {
    id: "status-bar-ports-refresh",
    description:
      "How often listening ports are checked in the background. An open ports list refreshes every few seconds.",
    title: "Refresh ports",
    to: "/settings/status-bar",
    searchTerms: ["status bar listening ports poll interval seconds background"],
  },
  {
    id: "status-bar-ports-count",
    description: "What the ports count includes. The list always shows both.",
    title: "Ports count",
    to: "/settings/status-bar",
    searchTerms: ["status bar project ports all listening"],
  },
  {
    id: "status-bar-resource-sort",
    description: "How the resource manager orders projects and terminals when it opens.",
    title: "Resource manager sort",
    to: "/settings/status-bar",
    searchTerms: ["status bar memory cpu name order terminals projects"],
  },
  {
    id: "assistants",
    title: "Assistants",
    to: "/settings/assistants",
    searchTerms: [
      "assistants jarvis named assistant instructions tool access read only full access reset conversation archive",
    ],
  },
  {
    id: "integrations",
    title: "Integrations",
    to: "/settings/integrations",
    requiresIntegrations: true,
    searchTerms: [
      "integrations connectors connect sign in oauth token mcp google calendar gmail linear github notion slack claude.ai codex own app client id redirect",
    ],
  },
  {
    id: "imessage",
    title: "iMessage",
    to: "/settings/imessage",
    requiresImessage: true,
    searchTerms: [
      "imessage messages text sms mac full disk access automation handles phone number email chat with yourself allowed assistants jarvis",
    ],
  },
  {
    id: "telegram",
    title: "Telegram",
    to: "/settings/telegram",
    requiresTelegram: true,
    searchTerms: [
      "telegram bot botfather token user id chat allowed senders assistants jarvis messages phone",
    ],
  },
  {
    id: "kanban-default-layout",
    title: "Global board layout",
    description:
      "How the all-boards page groups cards when it opens. Each project's own board is always by column.",
    to: "/settings/kanban",
    searchTerms: ["kanban board all projects by status by project swimlanes"],
  },
  {
    id: "kanban-automations",
    title: "Automations",
    to: "/settings/kanban",
    searchTerms: ["kanban board move card thread started run completed pull request merged"],
  },
  {
    id: "kanban-definition-of-done",
    title: "Definition of done",
    to: "/settings/kanban",
    searchTerms: ["kanban board checklist review done summary comment"],
  },
  {
    id: "kanban-agent-tool",
    title: "Let agents use the board",
    description: "When off, agents don't see the kanban tool at all.",
    to: "/settings/kanban",
    searchTerms: ["kanban board agent tool t3_kanban mcp enable disable"],
  },
  {
    id: "kanban-agent-default-board",
    title: "Default board for agents",
    description: "Which board an agent uses when it names no project and no card.",
    to: "/settings/kanban",
    searchTerms: ["kanban board agent project ask thread"],
  },
  {
    id: "kanban-default-template",
    title: "Default columns for new boards",
    description:
      "Columns and card templates a board starts with. Boards that already exist keep theirs.",
    to: "/settings/kanban",
    searchTerms: [
      "kanban board default template columns roles wip limit new boards reset built-in",
    ],
  },
  {
    id: "kanban-templates",
    title: "Card templates",
    to: "/settings/kanban",
    searchTerms: ["kanban board bug feature refactor chore checklist"],
  },
  {
    id: "kanban-labels",
    title: "Labels",
    to: "/settings/kanban",
    searchTerms: ["kanban board tags colors"],
  },
  {
    id: "tool-call-visibility",
    description:
      "Hide the commands, edits, and searches agents run. Hide successful keeps failures. Zen shows only final answers. Approvals, questions, and errors always show.",
    title: "Tool calls in chat",
    to: "/settings/chat",
    searchTerms: [
      "hide tool calls commands edits searches work log activity quiet chat zen final answers only",
    ],
  },
  {
    id: "screen-reader-announcements",
    description:
      "What a screen reader hears from the open thread: a turn starting, needing you, and ending. Status and messages adds what the agent writes before its last message. Everything adds each step.",
    title: "Screen reader announcements",
    to: "/settings/chat",
    searchTerms: [
      "accessibility a11y screen reader nvda jaws voiceover orca narrator speech announce read aloud messages activity steps",
    ],
  },
  {
    id: "guest-links",
    title: "Guest links",
    description: `${MAINTENANCE_SETTINGS_COPY.guestLinksBefore}${MAINTENANCE_SETTINGS_COPY.sharingLink}${MAINTENANCE_SETTINGS_COPY.guestLinksAfter}`,
    to: "/settings/labs",
    scope: "environment",
    searchTerms: [
      "beta share guest invite link teammate watch t3 connect tunnel",
      MAINTENANCE_SETTINGS_COPY.guestLinksSignedOut,
    ],
  },
  {
    id: "linked-environments-beta",
    title: "Linked environments",
    description: `${MAINTENANCE_SETTINGS_COPY.linkedEnvironmentsBefore}${MAINTENANCE_SETTINGS_COPY.connectionsLink}${MAINTENANCE_SETTINGS_COPY.linkedEnvironmentsAfter}`,
    to: "/settings/labs",
    scope: "environment",
    searchTerms: ["beta link another machine vps peer agents work there delegate"],
  },
  {
    id: "prompt-suggestions-beta",
    title: "Suggest next prompt",
    description:
      "Show a predicted next message in the empty composer after a Claude or Codex turn. Tab uses it. Each is an extra cached request on your plan. Needs Codex 0.165+. Claude threads update on restart.",
    to: "/settings/labs",
    scope: "environment",
    searchTerms: ["beta tab autocomplete predict next message claude codex ghost text"],
  },
  {
    id: "simlock-hosts",
    title: "Simlock device hosts (alpha)",
    description: `${MAINTENANCE_SETTINGS_COPY.simlockBefore}${MAINTENANCE_SETTINGS_COPY.simlockName}${MAINTENANCE_SETTINGS_COPY.simlockMiddle}${MAINTENANCE_SETTINGS_COPY.devicesLink}${MAINTENANCE_SETTINGS_COPY.simlockAfter}`,
    to: "/settings/labs",
    scope: "environment",
    searchTerms: ["beta alpha simlock callstack simulator emulator ios android pool lease gateway"],
  },
  {
    id: "worktree-fast-checkout",
    title: "Fast worktree checkout",
    description:
      "On a Mac, clone new worktrees from a checkout cached in the T3 home folder instead of writing every file. Uses Git’s normal checkout when it can’t. Turning it off deletes the cache.",
    to: "/settings/labs",
    scope: "environment",
    fastWorktreeCheckoutOnly: true,
    searchTerms: ["beta fast worktree checkout clone apfs copy-on-write cache macos speed"],
  },
  {
    id: "voice-transcription-destination",
    title: "Transcribe with",
    to: "/settings/voice",
    searchTerms: [
      "send microphone audio dictation destination speech voice stt transcription environment machine consent privacy cloud OpenAI Grok OpenRouter",
    ],
  },
  {
    id: "voice-microphone",
    title: "Microphone",
    description:
      "System default follows your operating system. Record a ten-second test and play it back here. Test audio stays on this device and is never transcribed.",
    to: "/settings/voice",
    searchTerms: ["mic input audio device"],
  },
  {
    id: "dictation-shortcut-mode",
    title: "Dictation shortcut",
    description: "How the dictation shortcut starts and stops recording.",
    to: "/settings/voice",
    searchTerms: ["speech voice keyboard hotkey hold toggle auto"],
  },
  {
    id: "speech-language",
    title: "Language",
    description:
      "Choose an environment above to see the languages its transcription model supports.",
    to: "/settings/voice",
    searchTerms: [
      "speech voice transcription language translate english auto detect",
      MAINTENANCE_SETTINGS_COPY.languageCloud,
      MAINTENANCE_SETTINGS_COPY.languageDetects,
      MAINTENANCE_SETTINGS_COPY.languageFixed,
    ],
  },
  {
    id: "speech-dictionary",
    title: "Dictionary",
    description:
      "Names and terms transcription should spell your way, saved on this device. Add an alias when it keeps hearing a term wrong. The name of the project you dictate in is also sent as a hint.",
    to: "/settings/voice",
    searchTerms: ["speech voice transcription vocabulary names glossary alias"],
  },
  {
    id: "speech-project-dictionary",
    title: "Project dictionary",
    description:
      "Saved on the environment and used in every project there, along with each person’s own dictionary. Pick a project above to limit these words to one project.",
    to: "/settings/voice",
    scope: "project-defaults",
    searchTerms: [
      "speech voice transcription vocabulary shared dictionary team environment glossary",
      MAINTENANCE_SETTINGS_COPY.sharedDictionaryTitle,
      MAINTENANCE_SETTINGS_COPY.projectDictionaryBefore,
      MAINTENANCE_SETTINGS_COPY.projectDictionaryAfter,
    ],
  },
  {
    id: "speech-post-processing-model",
    title: "Cleanup model",
    description:
      "Model for transcript cleanup, such as a cheaper or faster one. When disabled, use the text generation model configured for this environment.",
    to: "/settings/voice",
    scope: "environment",
    searchTerms: ["speech voice transcript cleanup provider model post-processing"],
  },
  {
    id: "speech-correction-word",
    title: "Correction cue",
    description:
      "The word or phrase you say to flag a correction, like “sorry” or “scratch that”. Cleanup applies the correction only where one is meant, and hears the cue as a hint.",
    to: "/settings/voice",
    searchTerms: ["speech voice cleanup sorry scratch that fix mistake"],
  },
  {
    id: "speech-silence-filtering",
    title: "Silence filtering",
    description:
      "Skip silence and other non-speech audio before transcription, keeping a short buffer so words aren’t cut off.",
    to: "/settings/voice",
    searchTerms: ["voice speech vad silero pauses noise", MAINTENANCE_SETTINGS_COPY.silenceOpenAi],
  },
  {
    id: "remove-filler-words",
    title: "Remove filler words",
    description: "Remove filler words like “um” and “uh” from transcripts.",
    to: "/settings/voice",
    searchTerms: ["voice speech transcription hesitation um uh cleanup"],
  },
  {
    id: "speech-post-processing",
    title: "Clean up transcripts",
    description:
      "Fixes punctuation, numbers, and spoken corrections with the cleanup model on the draft’s environment. Sends the transcript and nearby draft text, never audio.",
    to: "/settings/voice",
    searchTerms: ["speech transcription polish clean provider prompt post-processing"],
  },
  {
    id: "speech-models",
    title: "Transcription models",
    to: "/settings/voice",
    searchTerms: [
      "speech voice stt download whisper parakeet canary moonshine accuracy speed benchmark languages",
    ],
  },
  {
    id: "speech-hardware",
    title: "Hardware",
    description: "Auto uses the environment’s GPU when it has one.",
    to: "/settings/voice",
    searchTerms: ["speech voice stt advanced transcription hardware gpu cpu acceleration"],
  },
  {
    id: "microphone-test",
    title: "Test microphone",
    to: "/settings/voice",
    searchTerms: ["test mic audio playback loopback record input level"],
  },
  {
    id: "transcription-test",
    title: "Test model",
    to: "/settings/voice",
    searchTerms: ["test voice speech model transcription recognition"],
  },
  {
    id: "auto-settle-inactive-threads",
    description: "Sidebar threads with no activity for this long settle automatically.",
    title: "Auto-settle inactive threads",
    to: "/settings/threads",
    searchTerms: ["sidebar inactivity days no activity automatically"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "compact-idle-threads",
    description:
      "When to compact an idle Claude thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Each Claude provider can override this.",
    title: "Compact idle threads",
    to: "/settings/providers",
    scope: "environment-defaults",
    searchTerms: ["claude context compaction idle cache tokens usage summary resume"],
  },
  {
    id: "close-idle-claude-agents",
    description:
      "Minutes without activity before an idle Claude agent process is closed. The conversation resumes on your next message.",
    title: "Close idle Claude agents",
    to: "/settings/providers",
    scope: "environment-defaults",
    searchTerms: ["claude process memory idle timeout minutes stop resume"],
  },
  {
    id: "auto-settle-merged-threads",
    description:
      "Settle a thread when its pull request merges. Closed pull requests still settle automatically.",
    title: "Auto-settle merged threads",
    to: "/settings/threads",
    searchTerms: ["pull request merge closed automatically sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "keep-threads-with-pull-requests",
    description:
      "Inactivity does not settle threads with a pull request. Merge and close still do.",
    title: "Keep threads with a PR",
    to: "/settings/threads",
    targetId: "auto-settle-inactive-threads",
    searchTerms: ["pull request inactivity auto-settle merge close sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "days-before-auto-settle",
    description: "Any new activity un-settles a thread automatically.",
    title: "Days of inactivity before auto-settle",
    to: "/settings/threads",
    targetId: "auto-settle-inactive-threads",
    searchTerms: ["thread timeout activity sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "thread-notifications",
    description:
      "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while T3 Code is open.",
    title: "Thread notifications",
    to: "/settings/general",
    searchTerms: ["notification sound alert completion input approval desktop"],
  },
  {
    id: "in-app-notifications",
    description:
      "Show a toast when another thread finishes, fails, or needs input or approval while this app has focus.",
    title: "In-app notifications",
    to: "/settings/general",
    searchTerms: ["notification toast popup completion input approval failure"],
  },
  {
    id: "time-format",
    description: "System default follows your browser or OS clock preference.",
    title: "Time format",
    to: "/settings/general",
    searchTerms: ["timestamp clock locale system browser os 12 hour 24 hour"],
  },
  {
    id: "response-streaming",
    description: GENERAL_SETTINGS_COPY.responseStreamingTurn,
    title: "Response streaming",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: [
      "output token paragraph buffered wait turn legacy",
      GENERAL_SETTINGS_COPY.responseStreamingParagraph,
      GENERAL_SETTINGS_COPY.responseStreamingMixed,
    ],
  },
  {
    id: "hide-whitespace-changes",
    description: "Set whether the diff panel ignores whitespace-only edits by default.",
    title: "Hide whitespace changes",
    to: "/settings/diffs",
    searchTerms: ["diff ignore spaces edits default"],
  },
  {
    id: "default-diff-file-state",
    description:
      "Start with files expanded or collapsed when opening diffs or a pull request's Code tab.",
    title: "Default diff file state",
    to: "/settings/diffs",
    searchTerms: ["collapsed expanded collapse expand files pull request pr code tab"],
  },
  {
    id: "diff-layout",
    description:
      "Show diffs stacked or side by side. The toggle in the diff toolbar changes this too.",
    title: "Diff layout",
    to: "/settings/diffs",
    searchTerms: ["stacked split side by side unified inline view"],
  },
  {
    id: "proactive-panels",
    description:
      "Open linked pull requests first. Otherwise, open Changes for edits to at least 3 files or 50 lines.",
    title: "Open pull requests and changes panels proactively",
    to: "/settings/diffs",
    searchTerms: ["proactive automatically open diff pull request pr right panel agent completion"],
  },
  {
    id: "skills-in-slash-menu",
    description: "Also include skills in the / command menu. Skills always appear when you type $.",
    title: "Show skills in slash menu",
    to: "/settings/chat",
    searchTerms: ["command menu dollar $ slash /"],
  },
  {
    id: "composer-rich-text",
    description: "Show formatted Markdown as you type.",
    title: "Rich text composer",
    to: "/settings/chat",
    searchTerms: ["composer rich text tiptap bold italic markdown styled wysiwyg"],
  },
  {
    id: "send-shortcut",
    description: "Choose when Enter sends a prompt or inserts a new line",
    title: "Send shortcut",
    to: "/settings/chat",
    searchTerms: ["enter return command ctrl multiline prompt new line composer"],
  },
  {
    id: "follow-up-behavior",
    description: "Queue follow-ups while the agent runs or steer the current run.",
    title: "Follow-up behavior",
    to: "/settings/chat",
    searchTerms: [
      "queue steer running turn send default behavior composer single-line multiline prompts",
      GENERAL_SETTINGS_COPY.followUpOpposite,
    ],
  },
  {
    id: "provider-update-checks",
    description:
      "Check installed provider CLIs for newer available versions and fetch model catalog updates. When off, new models may not appear.",
    title: "Provider update checks",
    to: "/settings/maintenance",
    searchTerms: [
      "installed cli versions newer available codex claude cursor grok fx kiro opencode",
    ],
    scope: "environment-defaults",
  },
  {
    id: "continue-threads-after-server-update",
    description:
      "Automatically resume interrupted threads after an update, crash, or machine restart on the selected environments.",
    title: "Continue threads after restarts",
    to: "/settings/maintenance",
    scope: "project-defaults",
    searchTerms: [
      "resume running active interrupted work restart reboot machine crash desktop update automatically",
    ],
  },
  {
    id: "background-activity",
    title: "Background activity",
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: [
      "balanced performance battery saver advanced git fetch provider health refresh host power monitor idle policy",
      GENERAL_SETTINGS_COPY.backgroundActivityPolicy,
    ],
  },
  {
    id: "keep-awake",
    title: "Keep this computer awake",
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: ["sleep caffeinate prevent idle lid laptop agents working always power"],
  },
  {
    id: "new-threads",
    title: "New threads",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["default workspace mode draft local worktree"],
  },
  {
    id: "worktree-submodules",
    title: "Submodules",
    description:
      "How new worktrees populate git submodules. Projects and their t3.json can override it.",
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: [
      "git submodule init recursive top-level none worktree t3.json",
      PROVIDER_SETTINGS_COPY.projectSubmodules,
    ],
  },
  {
    id: "start-from-origin",
    title: "Start from remote",
    description:
      "Uses the latest commit of the base branch’s tracked remote branch, even if its name differs. Otherwise uses the same-named branch on origin. Uses your local branch if that remote branch is missing.",
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: ["new worktrees start remote origin latest fetched branch local"],
  },
  {
    id: "add-project-starts-in",
    description: 'Leave empty to use "~/" when the Add Project browser opens.',
    title: "Add project starts in",
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: ["base directory folder browser path home"],
  },
  {
    id: "ghq-clone-layout",
    description: "Clones go to github.com/owner/repo under the folder above, like ghq.",
    title: "Clone into host folders",
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: ["ghq clone destination host owner repository root layout"],
  },
  {
    id: "unpin-confirmation",
    description: "Ask before unpinning a thread from the pinned section.",
    title: "Unpin confirmation",
    to: "/settings/general",
    searchTerms: ["ask before thread pinned section"],
  },
  {
    id: "archive-confirmation",
    description: "Require a second click on the inline archive action before a thread is archived.",
    title: "Archive confirmation",
    to: "/settings/general",
    searchTerms: ["ask before thread second click inline action"],
  },
  {
    id: "delete-confirmation",
    description: "Ask before deleting a thread and its chat history.",
    title: "Delete confirmation",
    to: "/settings/general",
    searchTerms: ["ask before thread chat history"],
  },
  {
    id: "quit-confirmation",
    description: "Hold mode also quits on two quick presses.",
    title: "Quit shortcut",
    to: "/settings/general",
    searchTerms: ["confirmation desktop app exit direct hold double click press twice"],
    desktopOnly: true,
  },
  {
    id: "open-at-login",
    title: "Open at login",
    to: "/settings/general",
    searchTerms: ["launch start startup sign in login items restart reboot background"],
    desktopOnly: true,
    loginItemsOnly: true,
  },
  {
    id: "show-in-menu-bar",
    description:
      "List threads that need you, running threads and pinned threads in the macOS menu bar.",
    title: "Show in menu bar",
    to: "/settings/general",
    searchTerms: ["tray icon macos desktop app threads needs you running pinned"],
    desktopOnly: true,
    macOnly: true,
  },
  {
    id: "text-generation-model",
    description:
      "For thread titles and other generated text. Source control has its own setting. Text generators from Providers also appear here.",
    title: "Text generation model",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["generated thread titles source control content default provider"],
  },
  {
    id: "thread-title-instructions",
    description: "Appended to the prompt for new and regenerated thread titles.",
    title: "Thread title instructions",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["generated thread titles prompt custom style naming rename regenerate"],
  },
  {
    id: "app-version",
    description: "Current version of the application.",
    title: "Version",
    to: "/settings/about",
    searchTerms: ["about check for updates download install upgrade release"],
  },
  {
    id: "update-track",
    description:
      "Switches this app and every connected machine whose database the target release supports.",
    title: "Update track",
    to: "/settings/about",
    searchTerms: [
      "release channel stable latest nightly prerelease",
      GENERAL_SETTINGS_COPY.updateTrackHosted,
      GENERAL_SETTINGS_COPY.nightlyUnavailable,
      GENERAL_SETTINGS_COPY.nightlySwitchToStable,
      GENERAL_SETTINGS_COPY.oneMachineStillRuns,
      GENERAL_SETTINGS_COPY.manyMachinesStillRun,
    ],
    releaseChannelOnly: true,
  },
  {
    id: "cli-command",
    title: "t3 command",
    to: "/settings/about",
    searchTerms: ["cli terminal shell path install command line"],
    desktopOnly: true,
  },
  {
    id: "mobile-app",
    description: "Connect to your server from your phone or tablet.",
    title: "Mobile app",
    to: "/settings/about",
    searchTerms: ["phone tablet iPhone iPad iOS Android App Store Google Play QR"],
  },
  {
    id: "welcome-page",
    description: "See your agents, import projects, and set up your phone.",
    title: "Welcome page",
    to: "/settings/about",
    primaryEnvironmentOnly: true,
    searchTerms: ["onboarding setup first run getting started agents import projects"],
  },
  {
    id: "privacy-policy",
    description: "How we handle your data, including the anonymous usage data T3 Code collects.",
    title: "Privacy policy",
    to: "/settings/about",
    searchTerms: ["telemetry analytics usage data tracking legal opt out"],
  },
  {
    id: "telemetry-export",
    title: "OpenTelemetry export",
    to: "/settings/diagnostics",
    targetId: "telemetry-export",
    scope: "environment",
    searchTerms: ["OTel OTLP telemetry export endpoints logs traces metrics Grafana"],
  },
  {
    id: "heavy-work-enabled",
    title: "Heavy work queue",
    description:
      "On: tests, builds and simulators take turns, and agents ask before adding to a busy machine. Off: heavy jobs start right away and agents do not ask first.",
    to: "/settings/maintenance",
    searchTerms: ["heavy work queue turn on off disable enable start right away without asking"],
  },
  {
    id: "heavy-work-max",
    machine: "This Mac",
    title: "Jobs at once on this Mac",
    description:
      "With 1, heavy jobs run strictly one at a time. With more, the next one starts only while this Mac is under its limits.",
    to: "/settings/maintenance",
    searchTerms: ["heavy work queue concurrency parallel slots tests builds simulators"],
  },
  {
    id: "heavy-work-pause",
    title: "Pause heavy work queue",
    description: "While paused nothing new starts. Jobs already running continue.",
    to: "/settings/maintenance",
    searchTerms: ["heavy work queue hold stop starting"],
  },
  {
    id: "heavy-work-cpu-ceiling",
    machine: "This Mac",
    title: HEAVY_LIMIT_COPY.macCpuCeilingPercent.title,
    description: HEAVY_LIMIT_COPY.macCpuCeilingPercent.description,
    to: "/settings/maintenance",
    searchTerms: ["heavy work queue mac cpu limit ceiling busy percent room"],
  },
  {
    id: "heavy-work-memory-floor",
    machine: "This Mac",
    title: HEAVY_LIMIT_COPY.macMemoryFloorPercent.title,
    description: HEAVY_LIMIT_COPY.macMemoryFloorPercent.description,
    to: "/settings/maintenance",
    searchTerms: ["heavy work queue mac memory ram free floor percent low"],
  },
  {
    id: "heavy-work-slow-agents",
    machine: "This Mac",
    title: "Slow down agent jobs when the Mac is busy",
    description:
      "While this Mac stays over its CPU limit, agents' running jobs and the build daemons they use drop to background priority, and speed up again once there is room. Your own jobs keep their speed.",
    to: "/settings/maintenance",
    searchTerms: [
      "heavy work queue agent jobs background priority throttle slow cpu busy limit qos taskpolicy",
    ],
  },
  {
    id: "heavy-work-over-limit",
    title: HEAVY_LIMIT_COPY.heavyOverLimitSeconds.title,
    description: HEAVY_LIMIT_COPY.heavyOverLimitSeconds.description,
    to: "/settings/maintenance",
    searchTerms: [
      "heavy work queue runner hybrid sustained spike seconds limit wait move linux mac",
    ],
  },
  {
    id: "heavy-work-claude-hook",
    title: "Claude Code hook for the heavy work queue",
    description:
      "Adds a hook to your Claude Code settings so heavy Bash commands in Claude sessions outside T3 Code wait in this queue too. Sessions T3 Code starts already do.",
    to: "/settings/maintenance",
    searchTerms: ["heavy work queue claude code hook settings bash commands outside install"],
  },
  {
    id: "heavy-work-device-idle",
    title: "Power off idle simulators",
    description:
      "Emulators and simulators T3 Code used power off after this long without use. Opening one boots it again.",
    to: "/settings/maintenance",
    searchTerms: ["heavy work queue emulator simulator idle power off shut down minutes"],
  },
  {
    id: "heavy-work-notices",
    title: HEAVY_NOTICES_COPY.title,
    description: HEAVY_NOTICES_COPY.description,
    to: "/settings/maintenance",
    searchTerms: [
      "heavy work queue runner notices notifications toast alerts failed failure linux offline online moved machine mac",
    ],
  },
  {
    id: "runner-enabled",
    title: RUNNER_SETTING_COPY.runnerEnabled.title,
    description: RUNNER_SETTING_COPY.runnerEnabled.description,
    to: "/settings/maintenance",
    searchTerms: ["runner linux pc remote ssh offload heavy work tests"],
  },
  {
    id: "runner-where",
    title: RUNNER_SETTING_COPY.runnerWhere.title,
    description: RUNNER_SETTING_COPY.runnerWhere.description,
    to: "/settings/maintenance",
    searchTerms: [
      "runner this mac linux mac first hybrid automatic offload balance both queues everything",
    ],
  },
  {
    id: "runner-mac-first-after",
    title: RUNNER_SETTING_COPY.runnerMacFirstAfter.title,
    description: RUNNER_SETTING_COPY.runnerMacFirstAfter.description,
    to: "/settings/maintenance",
    searchTerms: ["runner mac first jobs running waiting threshold overflow linux"],
  },
  {
    id: "runner-linux-everything",
    title: RUNNER_SETTING_COPY.runnerLinuxEverything.title,
    description: RUNNER_SETTING_COPY.runnerLinuxEverything.description,
    to: "/settings/maintenance",
    searchTerms: ["runner linux all every heavy command except stay on mac"],
  },
  {
    id: "runner-bring-back",
    title: RUNNER_SETTING_COPY.runnerBringBack.title,
    description: RUNNER_SETTING_COPY.runnerBringBack.description,
    to: "/settings/maintenance",
    searchTerms: ["runner linux copy files created changed back results output sync"],
  },
  {
    id: "runner-linux-commands",
    title: RUNNER_SETTING_COPY.runnerLinuxCommands.title,
    description: RUNNER_SETTING_COPY.runnerLinuxCommands.description,
    to: "/settings/maintenance",
    searchTerms: ["runner linux patterns tests lint typecheck allow list"],
  },
  {
    id: "runner-mac-only",
    title: RUNNER_SETTING_COPY.runnerMacOnly.title,
    description: RUNNER_SETTING_COPY.runnerMacOnly.description,
    to: "/settings/maintenance",
    searchTerms: ["runner mac only patterns simulator xcodebuild gradle"],
  },
  {
    id: "runner-unavailable",
    title: RUNNER_SETTING_COPY.runnerUnavailable.title,
    description: RUNNER_SETTING_COPY.runnerUnavailable.description,
    to: "/settings/maintenance",
    searchTerms: ["runner linux offline unavailable ask wait run here"],
  },
  {
    id: "runner-dropped",
    title: RUNNER_SETTING_COPY.runnerDropped.title,
    description: RUNNER_SETTING_COPY.runnerDropped.description,
    to: "/settings/maintenance",
    searchTerms: [
      "runner linux run failed fails dropped disconnected mid run tool missing agent ask wait",
    ],
  },
  {
    id: "runner-ask-minutes",
    title: RUNNER_SETTING_COPY.runnerAskMinutes.title,
    description: RUNNER_SETTING_COPY.runnerAskMinutes.description,
    to: "/settings/maintenance",
    searchTerms: ["runner ask me question timeout minutes deadline"],
  },
  {
    id: "runner-deadline",
    title: RUNNER_SETTING_COPY.runnerDeadlineAction.title,
    description: RUNNER_SETTING_COPY.runnerDeadlineAction.description,
    to: "/settings/maintenance",
    searchTerms: ["runner ask deadline unanswered cancel run here wait"],
  },
  {
    id: "runner-host",
    machine: "Linux PC",
    title: RUNNER_SETTING_COPY.runnerHost.title,
    description: RUNNER_SETTING_COPY.runnerHost.description,
    to: "/settings/maintenance",
    scope: "environment",
    searchTerms: ["runner ssh host alias remoto linux pc"],
  },
  {
    id: "runner-linux-slots",
    machine: "Linux PC",
    title: RUNNER_SETTING_COPY.runnerLinuxSlots.title,
    description: RUNNER_SETTING_COPY.runnerLinuxSlots.description,
    to: "/settings/maintenance",
    scope: "environment",
    searchTerms: ["runner linux slots concurrency parallel"],
  },
  {
    id: "runner-linux-cpu-ceiling",
    machine: "Linux PC",
    title: RUNNER_SETTING_COPY.runnerLinuxCpuCeilingPercent.title,
    description: RUNNER_SETTING_COPY.runnerLinuxCpuCeilingPercent.description,
    to: "/settings/maintenance",
    scope: "environment",
    searchTerms: ["runner linux cpu limit ceiling load busy percent"],
  },
  {
    id: "runner-linux-memory-floor",
    machine: "Linux PC",
    title: RUNNER_SETTING_COPY.runnerLinuxMemoryFloorPercent.title,
    description: RUNNER_SETTING_COPY.runnerLinuxMemoryFloorPercent.description,
    to: "/settings/maintenance",
    scope: "environment",
    searchTerms: ["runner linux memory ram free floor percent"],
  },
  {
    id: "runner-heartbeat",
    title: RUNNER_SETTING_COPY.runnerHeartbeatSeconds.title,
    description: RUNNER_SETTING_COPY.runnerHeartbeatSeconds.description,
    to: "/settings/maintenance",
    scope: "environment",
    searchTerms: ["runner heartbeat interval seconds health check"],
  },
  {
    id: "runner-offline-after",
    title: RUNNER_SETTING_COPY.runnerOfflineAfterFailures.title,
    description: RUNNER_SETTING_COPY.runnerOfflineAfterFailures.description,
    to: "/settings/maintenance",
    scope: "environment",
    searchTerms: ["runner offline failures checks heartbeat"],
  },
  {
    id: "runner-ssh-timeout",
    title: RUNNER_SETTING_COPY.runnerSshTimeoutSeconds.title,
    description: RUNNER_SETTING_COPY.runnerSshTimeoutSeconds.description,
    to: "/settings/maintenance",
    scope: "environment",
    searchTerms: ["runner ssh timeout seconds connect"],
  },
  {
    id: "runner-stop-wait",
    title: RUNNER_SETTING_COPY.runnerStopWaitSeconds.title,
    description: RUNNER_SETTING_COPY.runnerStopWaitSeconds.description,
    to: "/settings/maintenance",
    scope: "environment",
    searchTerms: ["runner stop kill grace seconds linux job"],
  },
  {
    id: "heavy-work-rules",
    title: "Heavy work priority by project",
    description:
      "Jobs from these projects go ahead of, or behind, the others. Jobs already queued keep their place.",
    to: "/settings/maintenance",
    searchTerms: [
      "heavy work queue always first last priority project",
      MAINTENANCE_SETTINGS_COPY.heavyRulesEmpty,
    ],
  },
  {
    id: "diagnostics",
    description: "Inspect processes, resource use, and logs on this environment.",
    title: "Diagnostics",
    to: "/settings/maintenance",
    searchTerms: [
      "logs traces processes resource history failures spans cpu memory",
      GENERAL_SETTINGS_COPY.diagnosticsOneAtATime,
    ],
  },
  {
    id: "detect-problems",
    title: "Detect problems",
    to: "/settings/maintenance",
    scope: "project-defaults",
    searchTerms: ["problem cards failures assistants watch errors ignore noisy project"],
  },
  {
    id: "open-source-licenses",
    description: "Notices for dependencies, assets, and optional tools used by T3 Code.",
    title: "Open source licenses",
    to: "/settings/about",
  },
  {
    id: "keybindings",
    title: "Keybindings",
    to: "/settings/keybindings",
    searchTerms: ["keyboard shortcuts hotkeys commands bindings json"],
  },
  ...KEYBINDING_SEARCH_ITEMS,
  ...PROVIDER_NAME_SEARCH_ITEMS,
  {
    id: "snap-shot-enabled",
    title: "SnapShots",
    searchTerms: ["window capture screenshot"],
    to: "/settings/snap-shot",
  },
  {
    id: "snap-shot-accessibility",
    title: "Include app text",
    description: "Include text and controls when the app makes them available.",
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
    searchTerms: [
      "capture accessibility data text UI structure elements privacy omit agent context",
    ],
  },
  {
    id: "snap-shot-shortcut",
    title: "Capture shortcut",
    description: "Capture the window you're using without switching apps.",
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
    searchTerms: [MAINTENANCE_SETTINGS_COPY.snapShotPicker],
  },
  {
    id: "snap-shot-sound",
    title: "Capture sound",
    description: "Choose the sound played when capture starts.",
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-flash",
    title: "Capture flash",
    description: "Show a gentle cue on the captured window.",
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-animations",
    title: "Capture animations",
    description: "Animate captured windows into your draft.",
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
    searchTerms: [
      "agents cli google sign in sign out install subscription instances authentication api key models configuration binary path config directory codex_home shadow home endpoint arguments environment variables display name accent color custom favorite hidden auto compact native sessions import resume",
    ],
  },
  {
    id: "mcp-servers",
    title: "MCP servers",
    to: "/settings/providers",
    searchTerms: [
      "global mcp server tools stdio http command arguments headers environment variables token _t3 every provider",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "t3-skills",
    title: "T3 skills",
    to: "/settings/providers",
    searchTerms: ["global skills folder SKILL.md rescan $t3 every provider enable disable remove"],
    providerSettingsOnly: true,
  },
  {
    id: "provider-budget",
    title: "Spending budget",
    to: "/settings/providers",
    searchTerms: [
      "provider budget spend cost limit cap dollars usd daily weekly monthly warn block exceeded api key instance",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "usage-limit-alerts",
    title: "Limit alerts",
    description: "Your assistant messages you once when this much is left.",
    to: "/settings/providers",
    searchTerms: [
      "usage limit alert notify warn low remaining weekly session quota subscription telegram threshold percent",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "usage-limit-alerts-while-paused",
    title: "Limit alerts while paused",
    description:
      "Your assistant still tells you when a subscription limit runs low, for every provider. Set the levels on each provider in Providers.",
    to: "/settings/assistants",
    searchTerms: [
      "usage limit alert autonomy paused off notifications still reach telegram every provider",
    ],
    environmentOnly: true,
  },
  {
    id: "usage-providers",
    title: "Usage providers",
    to: "/settings/providers",
    searchTerms: [
      "usage sources CLIProxyAPI CLI proxy hub quota subscription limits management key add remove",
      PROVIDER_SETTINGS_COPY.cliProxy,
      PROVIDER_SETTINGS_COPY.usageHubDisabled,
    ],
    providerSettingsOnly: true,
  },
  {
    id: "text-generators",
    title: "Text generators",
    to: "/settings/providers",
    searchTerms: [
      "model api api key openai openrouter anthropic ollama lm studio custom endpoint base url thread titles commit messages",
      PROVIDER_SETTINGS_COPY.textGeneratorOff,
    ],
    providerSettingsOnly: true,
    textGeneratorsOnly: true,
  },
  {
    id: "provider-health-check-interval",
    title: "Health check interval",
    to: "/settings/providers",
    description:
      "Refresh provider status, versions, and models in the background. Set to 0 to disable.",
    searchTerms: [
      "refresh availability versions auth state models background probes seconds off",
      PROVIDER_SETTINGS_COPY.healthIntervalPolicy,
    ],
    providerSettingsOnly: true,
  },
  {
    id: "agent-browser-access",
    title: "Agent browser access",
    description: "Allow agents to use the shared browser. Projects can override it.",
    to: "/settings/browser",
    scope: "project-defaults",
    searchTerms: [
      "allow disable enable open drive preview tools sessions project override",
      CONNECTION_SETTINGS_COPY.agentBrowserAccessProject,
    ],
  },
  {
    id: "device-sources",
    title: "Device sources",
    to: "/settings/devices",
    searchTerms: [
      "device hosts ssh remote mac mini identity key connection eas expo cloud simlock pool gateway local simulators",
    ],
  },
  {
    id: "agent-device-access",
    title: "Agents can use devices",
    description: "New agent sessions can open and drive these devices.",
    to: "/settings/devices",
    targetId: "devices",
    searchTerms: [
      "allow simulator emulator ios android drive tools sessions",
      CONNECTION_SETTINGS_COPY.agentDeviceVersions,
    ],
  },
  {
    id: "device-hub",
    title: "Use devices",
    description: "Open simulators and emulators in the Device panel.",
    to: "/settings/devices",
    targetId: "devices",
    searchTerms: [
      "device hub simulator emulator ios android install start version",
      CONNECTION_SETTINGS_COPY.deviceHubVersions,
    ],
  },
  {
    id: "device-platform-support",
    title: "Local simulators",
    to: "/settings/devices",
    targetId: "device-sources",
    searchTerms: ["simulator support xcode android studio sdk avd runtime"],
  },
  {
    id: "browser-profiles",
    title: "Browser profiles",
    description:
      "Profiles separate cookies and logins. Incognito data is cleared when the app closes.",
    to: "/settings/browser",
    targetId: "browser",
  },
  {
    id: "browser-default-profile",
    title: "Default browser profile",
    to: "/settings/browser",
    targetId: "browser-profiles",
  },
  {
    id: "browser-default-viewport",
    title: "Default browser viewport",
    description:
      "Tab size for you and agents. Fill fits the panel; other sizes show the device toolbar.",
    to: "/settings/browser",
    searchTerms: ["preview size width height device desktop mobile rotate"],
  },
  {
    id: "browser-default-zoom",
    title: "Default browser zoom",
    description: "Page zoom applied to new browser tabs.",
    to: "/settings/browser",
    searchTerms: ["preview page scale tabs percent"],
  },
  {
    id: "browser-default-appearance",
    title: "Default browser appearance",
    description: "The color scheme pages are told to prefer. System follows your OS setting.",
    to: "/settings/browser",
    searchTerms: ["preview color scheme light dark system os"],
  },
  {
    id: "browser-recording-frame-rate",
    title: "Browser recording frame rate",
    description: "Maximum recording rate. 30 fps saves CPU and storage; 60 fps is smoother.",
    to: "/settings/browser",
  },
  {
    id: "browser-recording-key-presses",
    title: "Show key presses in recordings",
    description: "Show pressed keys and shortcuts in new recordings. Password fields are excluded.",
    to: "/settings/browser",
    searchTerms: ["browser preview keyboard shortcuts keystrokes overlay capture"],
  },
  {
    id: "browser-recording-mouse-presses",
    title: "Show mouse presses in recordings",
    description: "Highlight mouse presses and held buttons in new recordings.",
    to: "/settings/browser",
    searchTerms: ["browser preview clicks buttons drag overlay capture"],
  },
  {
    id: "browser-link-target",
    title: "Open links in",
    description:
      "Where links in the chat and terminal open. Hold ⌘ or Ctrl while clicking a link to open it in your default browser either way.",
    to: "/settings/browser",
    searchTerms: ["links default browser in-app browser external open"],
  },
  {
    id: "browser-search-engine",
    title: "Search engine",
    description: "What the address bar searches when you type something that isn't a URL.",
    to: "/settings/browser",
    searchTerms: ["address bar duckduckgo google bing brave kagi ecosia custom url"],
  },
  {
    id: "pull-request-links-open-in-app",
    title: "Open pull requests in T3 Code",
    description:
      "Clicking a pull request link opens it in T3 Code. Turn off to open pull request links like any other link, on your git host.",
    to: "/settings/diffs",
    searchTerms: [
      `pr commit links ${SOURCE_CONTROL_HOST_LABELS} browser external click default pull request view panel`,
    ],
  },
  {
    id: "browser-auto-show-floating-preview",
    title: "Auto-show floating preview",
    description:
      "Show the floating preview when an agent opens a browser or device unless the agent says otherwise.",
    to: "/settings/browser",
    searchTerms: ["agent opens browser device simulator pop into view hide"],
  },
  {
    id: "automatic-pull",
    title: "Automatically pull",
    description:
      "Keeps the default branch current when the checkout has no local changes or commits. Projects can override it.",
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: [
      "auto pull default branch current checkout fast forward upstream",
      PROVIDER_SETTINGS_COPY.projectAutomaticPull,
    ],
  },
  {
    id: "remove-agent-credits-on-merge",
    title: "Remove agent credits when merging",
    description:
      "Remove recognized agent credit lines from merge and squash messages on hosts that support it, keeping human co-authors. Includes auto-merge. Excludes merge queues, stack merges, and existing commits.",
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: [
      `pull request ${SOURCE_CONTROL_HOST_LABELS} squash co-authored-by attribution claude codex generated`,
    ],
  },
  {
    id: "pull-request-merge-method",
    title: "Default merge method",
    description:
      "Pull requests start with this method. Last selected reuses whatever you chose most recently on this device.",
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: [
      "pull request merge squash rebase last selected",
      PROVIDER_SETTINGS_COPY.projectMergeMethod,
    ],
  },
  {
    id: "source-control",
    title: "Source control",
    to: "/settings/source-control",
    scope: "environment-defaults",
    searchTerms: [
      `version control git ${SOURCE_CONTROL_HOST_TERMS} hosting integrations credentials scan server environment`,
    ],
  },
  {
    id: "git-fetch-interval",
    title: "Git fetch interval",
    to: "/settings/maintenance",
    targetId: "background-activity",
    searchTerms: [
      "automatic remote branch refresh background credentials security keys seconds off",
    ],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "worktree-branch-naming",
    title: "Worktree branch naming",
    description: "Choose how new worktree branches are named from your first message.",
    to: "/settings/worktrees",
    searchTerms: ["static semantic prefix custom prompt instructions feat fix refactor chore"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  ...sourceControlHostSearchItems(sourceControlClients.definitions),
  {
    id: "source-control-writing-style",
    title: "Commit and pull request writing",
    to: "/settings/source-control",
    searchTerms: [
      "repository conventions conventional commits custom instructions commit messages change pr pull request merge request titles descriptions body style prompt write my own",
    ],
    environmentOnly: true,
  },
  {
    id: "follow-change-request-templates",
    title: "Follow pull request templates",
    description: "Use the repository's pull request template when it has one.",
    to: "/settings/source-control",
    searchTerms: ["repository pr pull request merge request change request description structure"],
    environmentOnly: true,
  },
  {
    id: "source-control-writer-model",
    title: "Source control writer model",
    description:
      "Model for commit messages, pull request text, and branch or bookmark names. When disabled, use the text generation model configured for this environment.",
    to: "/settings/source-control",
    searchTerms: [
      "override generated commit change request pr titles descriptions branch bookmark",
    ],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "review-guides",
    title: "Review guides (beta)",
    description:
      "Add a Guide tab to pull requests. An agent explains the changes and points out decisions that need review.",
    to: "/settings/source-control",
    searchTerms: ["pull request pr guided review guide tour beta experimental"],
    environmentOnly: true,
  },
  {
    id: "review-guide-model",
    title: "Review guide model",
    description:
      "Must be a coding agent: it reads the pull request over many steps. Off uses the writer model, or Codex or Claude if that model is a text generator.",
    to: "/settings/source-control",
    // Hidden until review guides are on, so a search lands on the switch that shows it.
    targetId: "review-guides",
    searchTerms: ["pull request pr guided review guide brief maintainer"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "review-guide-instructions",
    title: "Review guide instructions",
    description:
      "Your preferences for review guides: what to show first, dwell on, or skip. The guide's format and coverage stay the same.",
    to: "/settings/source-control",
    targetId: "review-guides",
    searchTerms: ["pull request pr guided review guide preferences taste prompt custom"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "project-actions",
    title: "Actions",
    description:
      "Commands that run in this project's checkout or its worktree, with optional shortcuts.",
    to: "/settings/projects",
    searchTerms: ["commands scripts setup run dev server checkout worktree t3.json import"],
  },
  {
    id: "environment-icon",
    title: "Environment icon",
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["machine glyph sidebar mac mini studio laptop desktop server cloud vm"],
  },
  {
    id: "local-environment",
    description:
      "Run agents on this computer. Turn off to use T3 Code only with remote environments.",
    title: "Local environment",
    to: "/settings/connections",
    searchTerms: [
      "turn off on disable enable local server agents remote only restart",
      GENERAL_SETTINGS_COPY.localEnvironmentOff,
    ],
    desktopOnly: true,
  },
  {
    id: "network-access",
    title: "Network access",
    description: "Limited to this machine.",
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: [
      "expose backend remote pairing local machine interfaces host restart",
      CONNECTION_SETTINGS_COPY.networkAccessNoControl,
      CONNECTION_SETTINGS_COPY.networkAccessRemoteConfigured,
      CONNECTION_SETTINGS_COPY.networkAccessLoopback,
      CONNECTION_SETTINGS_COPY.networkAccessUnavailable,
    ],
    localBackendManagementOnly: true,
  },
  {
    id: "tailscale-https",
    title: "Tailscale HTTPS",
    description: "Use Tailscale Serve to expose this backend through a MagicDNS HTTPS URL.",
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["serve magicdns endpoint remote secure network"],
    desktopOnly: true,
    localBackendManagementOnly: true,
  },
  {
    id: "wsl-backend",
    title: "WSL backend",
    description:
      "Run the selected WSL distro alongside Windows. Projects remain on their current filesystem.",
    to: "/settings/access",
    searchTerms: [
      "windows subsystem linux distro second server projects stop windows backend restart wsl only",
    ],
    desktopOnly: true,
    windowsOnly: true,
    localBackendManagementOnly: true,
    wslAvailableOnly: true,
  },
  {
    id: "t3-connect",
    localEnvironmentOnly: true,
    title: "T3 Connect",
    description: "Make this environment available to your other devices through T3 Connect.",
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: [
      "managed tunnel cloud other devices remote tunnels limit t3 chat",
      CONNECTION_SETTINGS_COPY.t3ConnectSignedOut,
      CONNECTION_SETTINGS_COPY.t3ConnectRevoked,
      CONNECTION_SETTINGS_COPY.t3ConnectUnreachable,
      CONNECTION_SETTINGS_COPY.t3ConnectReachable,
      CONNECTION_SETTINGS_COPY.t3ConnectNotChecked,
      CONNECTION_SETTINGS_COPY.t3ConnectOutOfSync,
      CONNECTION_SETTINGS_COPY.t3ConnectLinkAgain,
      CONNECTION_SETTINGS_COPY.t3ConnectLinkOnHost,
      CONNECTION_SETTINGS_COPY.t3ConnectPermissions,
    ],
    desktopOnly: true,
    cloudOnly: true,
  },
  {
    id: "hold-webhooks-while-offline",
    localEnvironmentOnly: true,
    title: "Hold webhooks while offline",
    description:
      "Keep webhook requests for up to 24 hours while this environment is offline, then deliver them. Off: T3 Connect only forwards requests and stores nothing.",
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["webhook automations offline queue mailbox t3 connect"],
    cloudOnly: true,
    managedTunnelOnly: true,
  },
  {
    id: "publish-agent-activity",
    localEnvironmentOnly: true,
    title: "Publish agent activity",
    description: "Send activity to mobile notifications and Live Activities without T3 Connect.",
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: [
      "mobile push notifications live activities cloud tunnel",
      CONNECTION_SETTINGS_COPY.publishSignedOut,
    ],
    cloudOnly: true,
  },
  {
    id: "connections-environment",
    title: "This machine",
    to: "/settings/access",
    searchTerms: [
      "connections server backend local remote access administrative permissions scope pairing links qr code authorized clients sessions revoke endpoint",
      CONNECTION_SETTINGS_COPY.primaryEnvironmentTitle,
    ],
  },
  {
    id: "linked-environments",
    peerLinksOnly: true,
    title: "Linked environments",
    to: "/settings/connections",
    targetId: "linked-environments",
    searchTerms: ["link peer another machine vps agents work there handoff pairing code"],
  },
  {
    id: "remote-environments",
    title: "Environments",
    to: "/settings/connections",
    searchTerms: ["add pair backend host code ssh config agent tunnel saved t3 connect"],
  },
  {
    id: "load-balancing",
    title: "Load balancing",
    to: "/settings/connections",
    searchTerms: [
      "automatic machine environment resources cpu memory capacity preference weight shared projects",
    ],
  },
  {
    id: "pull-request-routing",
    title: "Pull request sharing",
    to: "/settings/connections",
    searchTerms: [
      `pull request routing trusted environments shared credentials permissions read actions source control ${SOURCE_CONTROL_HOST_LABELS}`,
    ],
  },
  {
    id: "secret-providers",
    title: "Secret providers",
    to: "/settings/secrets",
    searchTerms: ["1password vault credentials api key"],
    secretsFeatureOnly: true,
  },
  {
    id: "secret-providers-add",
    title: "Add secret provider",
    to: "/settings/secrets",
    targetId: "secret-providers",
    searchTerms: ["new 1password vault op cli account"],
    secretsFeatureOnly: true,
  },
  {
    id: "archive",
    title: "Archived threads",
    to: "/settings/archived",
    searchTerms: ["restore reopen deleted history projects"],
  },
  ...PROVIDER_SETTINGS_SEARCH_ITEMS,
  ...GENERAL_SETTINGS_SEARCH_ITEMS,
  ...MEMORY_SETTINGS_SEARCH_ITEMS,
  ...ASSISTANT_SETTINGS_SEARCH_ITEMS,
  ...MAINTENANCE_SETTINGS_SEARCH_ITEMS,
  ...CONNECTION_SETTINGS_SEARCH_ITEMS,
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID: ReadonlyMap<string, SettingsSearchItem> = new Map(
  SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item] as const),
);

const SETTINGS_CATEGORY_SCOPES: Readonly<Record<SettingsPath, SettingsSearchScope | null>> = {
  "/settings/diagnostics": "environment",
  "/settings/projects": "project",
  "/settings/general": null,
  "/settings/voice": null,
  "/settings/appearance": null,
  "/settings/chat": null,
  "/settings/diffs": null,
  "/settings/snap-shot": null,
  "/settings/keybindings": null,
  "/settings/providers": null,
  "/settings/assistants": null,
  "/settings/integrations": null,
  "/settings/imessage": null,
  "/settings/telegram": null,
  "/settings/memory": null,
  "/settings/threads": null,
  "/settings/browser": null,
  "/settings/devices": null,
  "/settings/mac-permissions": null,
  "/settings/computer-use": null,
  "/settings/source-control": "environment-defaults",
  "/settings/worktrees": "project-defaults",
  "/settings/status-bar": null,
  "/settings/fork-updates": null,
  "/settings/connections": "connections",
  "/settings/access": "connections",
  "/settings/secrets": null,
  "/settings/scheduled-tasks": null,
  "/settings/kanban": null,
  "/settings/maintenance": null,
  "/settings/labs": null,
  "/settings/about": null,
  "/settings/archived": "project-defaults",
};

const RENAMED_SETTINGS_PATHS: Readonly<Record<string, SettingsPath>> = {
  "/settings/storage": "/settings/maintenance",
  "/settings/beta": "/settings/labs",
};
const SPLIT_SETTINGS_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/source-control",
  "/settings/connections",
  // Its old browser and device rows moved out before the path became Integrations.
  "/settings/integrations",
  ...Object.keys(RENAMED_SETTINGS_PATHS),
]);
// Section anchors that moved but are not search results themselves.
const MOVED_SECTION_ANCHORS: Readonly<Record<string, SettingsPath>> = {
  "authorized-clients": "/settings/access",
  "text-generation": "/settings/threads",
  about: "/settings/about",
};

/** Where an old settings link now lives. Its anchor finds the page its row moved to. */
export function movedSettingsPath(pathname: string, hash: string): SettingsPath | null {
  if (!SPLIT_SETTINGS_PATHS.has(pathname)) return null;
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const anchored = hash
    ? (items.find((item) => item.id === hash) ?? items.find((item) => item.targetId === hash))
    : undefined;
  const to =
    anchored?.to ?? MOVED_SECTION_ANCHORS[hash] ?? RENAMED_SETTINGS_PATHS[pathname] ?? null;
  return to === pathname ? null : to;
}

export function getSettingsSearchTargetScope(targetId: string) {
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const item =
    items.find((candidate) => candidate.id === targetId) ??
    items.find((candidate) => candidate.targetId === targetId);
  return item
    ? {
        title: item.title,
        scope: item.scope ?? SETTINGS_CATEGORY_SCOPES[item.to],
        ...(item.requiresThreadAutoSettlement ? { requiresThreadAutoSettlement: true } : {}),
      }
    : null;
}

interface AutoSettlementSearchEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: object | null;
}

export function getThreadAutoSettlementSearchAvailability(
  environments: readonly AutoSettlementSearchEnvironment[],
  scope?: Pick<ResolvedSettingsScope, "kind" | "environmentIds">,
) {
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const eligibleEnvironmentIds = connected.map((environment) => environment.environmentId);
  const selected = connected.filter((environment) =>
    scope?.environmentIds.includes(environment.environmentId),
  );
  return {
    eligibleEnvironmentIds,
    isTargetAvailable:
      scope !== undefined &&
      scope.kind !== "unavailable" &&
      selected.length > 0 &&
      selected.every((environment) => eligibleEnvironmentIds.includes(environment.environmentId)),
  };
}

export function isSettingsSearchScopeAvailable(
  requiredScope: SettingsSearchScope | null,
  scopeKind: ResolvedSettingsScope["kind"],
): boolean {
  switch (requiredScope) {
    case null:
    case "connections":
      return true;
    case "environment":
    case "checkout":
      return requiredScope === scopeKind;
    case "project":
      return scopeKind === "project" || scopeKind === "checkout";
    case "environment-defaults":
      return scopeKind === "environment" || scopeKind === "all";
    case "project-defaults":
      return (
        scopeKind === "environment" ||
        scopeKind === "all" ||
        scopeKind === "project" ||
        scopeKind === "checkout"
      );
  }
}

/** A row's anchor id and the title and description it draws, all read from its index entry. */
export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
} {
  const { id: anchorId } = SEARCH_ITEMS_BY_ID.get(id)!;
  return { id: anchorId, ...settingCopy(id) };
}

/** The text of a row that renders more than once, so it cannot own the anchor id. */
export function settingCopy(id: SettingsSearchItemId): {
  readonly title: string;
  readonly description?: string;
} {
  const { title, description } = SEARCH_ITEMS_BY_ID.get(id)!;
  return description === undefined ? { title } : { title, description };
}

// Pages that exist only on some machines: every row on them follows the page.
const SETTINGS_PAGE_AVAILABILITY: Partial<
  Record<SettingsPath, (availability: SettingsSearchAvailability) => boolean>
> = {
  "/settings/memory": (availability) => availability.hasMemory === true,
  "/settings/integrations": (availability) => availability.hasIntegrations === true,
  "/settings/imessage": (availability) => availability.hasImessage === true,
  "/settings/telegram": (availability) => availability.hasTelegram === true,
  "/settings/mac-permissions": (availability) =>
    availability.hasMacProviderSettingsEnvironment === true,
  "/settings/computer-use": (availability) => availability.hasComputerUseHostEnvironment === true,
};

export function filterAvailableSettingsSearchItems(
  availability: SettingsSearchAvailability,
): ReadonlyArray<SettingsSearchItem> {
  const items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS;
  return items.filter(
    (item) =>
      (SETTINGS_PAGE_AVAILABILITY[item.to]?.(availability) ?? true) &&
      (!item.requiresMemory || availability.hasMemory === true) &&
      (!item.requiresIntegrations || availability.hasIntegrations === true) &&
      (!item.requiresImessage || availability.hasImessage === true) &&
      (!item.requiresTelegram || availability.hasTelegram === true) &&
      (!item.cloudOnly || availability.hasCloudPublicConfig) &&
      (!item.environmentOnly || availability.hasEnvironment) &&
      (!item.providerSettingsOnly || availability.hasProviderSettingsEnvironment) &&
      (!item.macProviderSettingsOnly || availability.hasMacProviderSettingsEnvironment === true) &&
      (!item.computerUseHostOnly || availability.hasComputerUseHostEnvironment === true) &&
      (!item.localBackendManagementOnly || availability.canManageLocalBackend) &&
      (!item.localEnvironmentOnly || !availability.localEnvironmentDisabled) &&
      (!item.primaryEnvironmentOnly || availability.hasPrimaryEnvironment === true) &&
      (!item.wslAvailableOnly || availability.isWslSettingsRowVisible) &&
      (!item.requiresThreadAutoSettlement || availability.hasThreadAutoSettlement) &&
      (!item.managedTunnelOnly || availability.managedTunnelActive === true) &&
      (!item.peerLinksOnly || availability.hasPeerLinkHost === true) &&
      (!item.fastWorktreeCheckoutOnly ||
        availability.hasFastWorktreeCheckoutEnvironment === true) &&
      (!item.textGeneratorsOnly || availability.hasTextGeneratorsEnvironment === true),
  );
}

/** The settings that exist on this platform and app channel. */
export function settingsForThisPlatform(
  items: ReadonlyArray<SettingsSearchItem>,
): ReadonlyArray<SettingsSearchItem> {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return items.filter(
    (item) =>
      (isElectron || item.desktopOnly !== true) &&
      (!item.requiresDesktopWindowMaterial || hasDesktopWindowMaterialApi()) &&
      (!item.releaseChannelOnly || isElectron || HOSTED_APP_CHANNEL !== null) &&
      (!item.secretsFeatureOnly || isSecretsFeatureEnabled) &&
      (!item.macOnly || isMacPlatform(platform)) &&
      (!item.windowsOnly || isWindowsPlatform(platform)) &&
      (!item.loginItemsOnly || isMacPlatform(platform) || isWindowsPlatform(platform)),
  );
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");

  const seen = new Set<string>();
  return settingsForThisPlatform(items)
    .flatMap((item, index) => {
      const title = normalizeSearchText(item.title);
      const fields = [
        title,
        normalizeSearchText(SETTINGS_SECTION_LABELS[item.to]),
        ...(item.description === undefined ? [] : [normalizeSearchText(item.description)]),
        ...(item.machine === undefined ? [] : [normalizeSearchText(item.machine)]),
        ...(item.searchTerms ?? []).map(normalizeSearchText),
      ];
      if (!queryTokens.every((token) => fields.some((field) => field.includes(token)))) return [];

      const exactPhraseField = fields.findIndex((field) => field.includes(normalizedQuery));
      const rank =
        title === normalizedQuery
          ? 5
          : title.startsWith(normalizedQuery)
            ? 4
            : title.includes(normalizedQuery)
              ? 3
              : queryTokens.every((token) => title.includes(token))
                ? 2
                : exactPhraseField >= 0
                  ? 1
                  : 0;
      return [{ item, index, rank }];
    })
    .toSorted(
      (left, right) =>
        Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
        right.rank - left.rank ||
        left.index - right.index,
    )
    .flatMap(({ item }) => {
      // Rows drawn once per instance share a title and jump target; one result reaches them all.
      const key = `${item.title}\u0000${item.to}\u0000${item.targetId ?? item.id}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [item];
    });
}

// These rows only exist with separate fonts on, so a search jump to one turns them on.
const ADVANCED_TYPOGRAPHY_TARGET_IDS: ReadonlySet<string> = new Set([
  "prompt-font",
  "terminal-font",
]);

export function isAdvancedTypographyTarget(targetId: string): boolean {
  return ADVANCED_TYPOGRAPHY_TARGET_IDS.has(targetId);
}

/**
 * Opens the persisted section a search result lives in before jumping to it, so
 * its row is mounted to scroll to. The terminal reads the same flag, so it must
 * stay on after the jump.
 */
export function revealSettingsSearchTarget(targetId: string): void {
  if (isAdvancedTypographyTarget(targetId)) {
    writeLocalStorageValue(TYPOGRAPHY_ADVANCED_STORAGE_KEY, true, false, Schema.Boolean);
  }
}
