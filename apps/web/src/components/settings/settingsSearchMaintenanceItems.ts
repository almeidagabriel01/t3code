import type { SettingsSearchItem } from "./settingsSearch";

const GUEST_LINKS_INTRO =
  "Share a thread with a guest who watches it live in a browser and sends messages you approve.";

/** Fragments a row draws around data or links, shared by the row and its index entry. */
export const MAINTENANCE_SETTINGS_COPY = {
  sharedDictionaryTitle: "Shared dictionary",
  projectDictionaryBefore: "Saved with ",
  projectDictionaryAfter:
    " on its environment. Everyone who dictates in this project gets these spellings, along with their own dictionary. Project spellings win when the two overlap.",
  languageCloud: "The cloud provider can detect your language automatically.",
  languageDetects: "detects the language automatically",
  languageFixed: "uses one fixed language",
  silenceOpenAi: "OpenAI handles silence automatically.",
  guestLinksBefore: `${GUEST_LINKS_INTRO} Needs T3 Connect: sign in and link this machine in `,
  guestLinksAfter: ". Turning it off stops every guest link.",
  guestLinksSignedOut: `${GUEST_LINKS_INTRO} Sign in to T3 Connect to use guest links.`,
  sharingLink: "Sharing & access",
  linkedEnvironmentsBefore:
    "Let agents here work on your other machines, and theirs here. Turn it on for each machine, then link them in ",
  connectionsLink: "Connections",
  linkedEnvironmentsAfter: ". While off, nothing new starts over a link; running tasks finish.",
  simlockBefore: "Let the Device panel lease simulators and emulators from your own ",
  simlockName: "Simlock",
  simlockMiddle: " pool, added in ",
  devicesLink: "Devices",
  simlockAfter: ". An alpha that may change or break. T3 Code never installs Simlock.",
  worktreeCleanupOff: "Keep this project's worktrees until you delete them manually.",
  worktreeCleanupCustom: "Use these rules for this project.",
  keepWhenTracked: "Deletes untracked and ignored files, including .env.",
  keepWhenUncommitted: "Keeps edits and untracked files. Deletes ignored files, including .env.",
  databaseReclaimCommand:
    " Run the command on each machine to reclaim it. It restarts the background service. Quit the desktop app first if it hosts the environment.",
  heavyRulesEmpty:
    "No project has a fixed priority. Set one from a queued job's menu in the Resource Manager.",
  forkChecking: "Checking upstream...",
  forkNoCheckout: "No fork checkout with an upstream remote at ",
  forkAddProject: " Add the fork folder as a project so an agent can run the update.",
  snapShotPicker: "Choose a window to capture from any app.",
  skillsFolderHelp:
    "Put a skill folder with a SKILL.md in this environment's skills folder, then rescan. Call it in a message with $t3:<folder-name>.",
  skillsFolderRescan: "Rescan to show the folder path.",
} as const;

const COPY = MAINTENANCE_SETTINGS_COPY;

export const MAINTENANCE_SETTINGS_SEARCH_ITEMS = [
  {
    id: "voice-input",
    title: "Input",
    to: "/settings/voice",
  },
  {
    id: "voice-transcription",
    title: "Transcription",
    to: "/settings/voice",
  },
  {
    id: "voice-recognition",
    title: "Transcription options",
    to: "/settings/voice",
  },
  {
    id: "speech-cleanup",
    title: "Cleanup",
    to: "/settings/voice",
    targetId: "speech-post-processing",
  },
  {
    id: "speech-unload-model",
    title: "Unload model",
    description: "Release the model’s memory on the environment after it sits idle.",
    to: "/settings/voice",
    searchTerms: ["speech voice stt advanced memory idle timeout"],
  },
  {
    id: "speech-translate-english",
    title: "Translate to English",
    description: "Speak any language and get English text.",
    to: "/settings/voice",
    searchTerms: ["speech voice transcription translation"],
  },
  {
    id: "speech-cleanup-instructions",
    title: "Cleanup instructions",
    description: "Use the built-in instructions or write your own.",
    to: "/settings/voice",
    searchTerms: ["speech voice transcript cleanup prompt custom default"],
  },
  {
    id: "storage-cleanup",
    title: "Cleanup",
    to: "/settings/maintenance",
    scope: "environment-defaults",
  },
  {
    id: "storage-worktree-mode",
    targetId: "storage-worktrees",
    title: "Automatic worktree cleanup",
    description: "Use each machine's worktree cleanup settings.",
    to: "/settings/worktrees",
    scope: "project",
    searchTerms: [COPY.worktreeCleanupOff, COPY.worktreeCleanupCustom, "inherit off custom"],
  },
  {
    id: "storage-worktree-on-delete",
    targetId: "storage-worktrees",
    title: "Delete worktrees with deleted threads",
    description:
      "Remove unused worktrees when active or archived threads are deleted. Worktrees with local changes are kept.",
    to: "/settings/worktrees",
    scope: "project-defaults",
  },
  {
    id: "storage-worktree-merged",
    targetId: "storage-worktrees",
    title: "Delete merged worktrees",
    description:
      "Remove worktrees whose commits are already in the default branch, merged locally or through a pull request.",
    to: "/settings/worktrees",
    scope: "project-defaults",
  },
  {
    id: "storage-worktree-inactive",
    targetId: "storage-worktrees",
    title: "Delete inactive worktrees",
    description:
      "Remove worktrees after their threads have been inactive for this many days. Branches and thread history are kept.",
    to: "/settings/worktrees",
    scope: "project-defaults",
  },
  {
    id: "storage-worktree-runner-copy",
    targetId: "storage-worktrees",
    title: "Delete the Linux copy too",
    description:
      "When cleanup deletes a worktree, also delete its copy on the Runner's Linux machine.",
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: ["runner remote"],
  },
  {
    id: "storage-worktree-settled",
    targetId: "storage-worktrees",
    title: "Delete settled worktrees",
    description:
      "Remove worktrees this many days after their thread settles. Set 0 days to remove them at the next cleanup. Branches and thread history are kept.",
    to: "/settings/worktrees",
    scope: "project-defaults",
  },
  {
    id: "storage-browser-artifacts",
    targetId: "storage-artifacts",
    title: "Delete old browser artifacts",
    description:
      "Delete saved browser captures after this many days. Older capture links will no longer open.",
    to: "/settings/maintenance",
    scope: "environment-defaults",
  },
  {
    id: "storage-rotated-logs",
    targetId: "storage-artifacts",
    title: "Delete old rotated logs",
    description: "Delete inactive rotated log files after this many days. Current logs are kept.",
    to: "/settings/maintenance",
    scope: "environment-defaults",
  },
  {
    id: "storage-worktree-snapshots",
    targetId: "storage-artifacts",
    title: "Delete old worktree snapshots",
    description:
      "Delete the changes saved before cleanup removed a worktree after this many days. Older ones can no longer be restored; the thread still recreates its worktree from the branch.",
    to: "/settings/maintenance",
    scope: "environment-defaults",
  },
  {
    id: "storage-tool-output",
    targetId: "storage-artifacts",
    title: "Summarize old tool output",
    description:
      "Replace detailed tool output in thread history, such as screenshots, file contents and command output, with a short summary after this many days. Off keeps everything.",
    to: "/settings/maintenance",
    scope: "environment-defaults",
  },
  {
    id: "storage-database",
    targetId: "storage-artifacts",
    title: "Database",
    to: "/settings/maintenance",
    scope: "environment-defaults",
  },
  {
    id: "storage-database-reclaim",
    targetId: "storage-artifacts",
    title: "Reclaim freed database space",
    description: "These databases still hold space freed by history cleanup.",
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: [COPY.databaseReclaimCommand, "compact vacuum disk"],
  },
  {
    id: "heavy-work",
    title: "Heavy work",
    to: "/settings/maintenance",
  },
  {
    id: "runner",
    title: "Runner",
    to: "/settings/maintenance",
  },
  {
    id: "diagnostics-resource-monitor",
    title: "Resource monitor",
    to: "/settings/diagnostics",
  },
  {
    id: "diagnostics-host-collection",
    title: "Host & collection",
    to: "/settings/diagnostics",
  },
  {
    id: "diagnostics-resource-timeline",
    title: "Resource timeline",
    to: "/settings/diagnostics",
  },
  {
    id: "diagnostics-process-tree",
    title: "Live process tree",
    to: "/settings/diagnostics",
  },
  {
    id: "diagnostics-application-io",
    title: "Instrumented application I/O",
    to: "/settings/diagnostics",
  },
  {
    id: "diagnostics-live-processes",
    title: "Live Processes",
    to: "/settings/diagnostics",
  },
  {
    id: "diagnostics-resource-history",
    title: "Resource History",
    to: "/settings/diagnostics",
  },
  {
    id: "diagnostics-trace",
    title: "Trace Diagnostics",
    to: "/settings/diagnostics",
  },
  {
    id: "diagnostics-latest-failures",
    title: "Latest Failures",
    to: "/settings/diagnostics",
  },
  {
    id: "diagnostics-common-failures",
    title: "Most Common Failures",
    to: "/settings/diagnostics",
  },
  {
    id: "diagnostics-slowest-spans",
    title: "Slowest Spans",
    to: "/settings/diagnostics",
  },
  {
    id: "diagnostics-span-logs",
    title: "Span Logs",
    to: "/settings/diagnostics",
  },
  {
    id: "diagnostics-top-spans",
    title: "Top Span Names",
    to: "/settings/diagnostics",
  },
  {
    id: "beta",
    title: "Beta",
    to: "/settings/labs",
  },
  {
    id: "archived-projects",
    targetId: "archive",
    title: "Archived projects",
    description: "Hidden from the sidebar. Threads and files are kept.",
    to: "/settings/archived",
    searchTerms: ["unarchive project restore"],
  },
  {
    id: "source-control-server-environment",
    targetId: "source-control",
    title: "Server environment",
    to: "/settings/source-control",
    scope: "environment-defaults",
  },
  {
    id: "source-control-version-control",
    targetId: "source-control",
    title: "Version Control",
    to: "/settings/source-control",
    scope: "environment-defaults",
  },
  {
    id: "source-control-providers",
    targetId: "source-control",
    title: "Source control providers",
    to: "/settings/source-control",
    scope: "environment-defaults",
  },
  {
    id: "source-control-text-generation",
    title: "Commits & pull requests",
    to: "/settings/source-control",
    environmentOnly: true,
  },
  {
    id: "worktree-creation",
    title: "Creation",
    to: "/settings/worktrees",
    scope: "project-defaults",
  },
  {
    id: "worktree-branches",
    title: "Branches",
    to: "/settings/worktrees",
    scope: "project-defaults",
  },
  {
    id: "worktree-branch-prefix",
    targetId: "worktree-branch-naming",
    title: "Branch prefix",
    description: "For example, t3 or t3/ produces t3/add-search. Leave empty for no prefix.",
    to: "/settings/worktrees",
    environmentOnly: true,
    scope: "project-defaults",
    searchTerms: ["static worktree branch name"],
  },
  {
    id: "worktree-branch-instructions",
    targetId: "worktree-branch-naming",
    title: "Branch naming instructions",
    description:
      "Appended to the naming prompt. The model returns the complete branch name; no prefix or suffix is added.",
    to: "/settings/worktrees",
    environmentOnly: true,
    scope: "project-defaults",
    searchTerms: ["custom worktree branch name prompt"],
  },
  {
    id: "t3-skills-folder",
    targetId: "t3-skills",
    title: "Skills folder",
    description: COPY.skillsFolderHelp,
    to: "/settings/providers",
    providerSettingsOnly: true,
    searchTerms: [COPY.skillsFolderRescan, "copy path"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
