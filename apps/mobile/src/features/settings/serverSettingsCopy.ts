import {
  DETECT_PROBLEMS_DESCRIPTION,
  DETECT_PROBLEMS_IN_PROJECT_LABEL,
  DETECT_PROBLEMS_LABEL,
} from "@t3tools/client-runtime/autonomy";
import {
  RUNNER_DEADLINE_LABEL,
  RUNNER_FAILED_POLICY_LABEL,
  RUNNER_LINUX_FULL_DESCRIPTION,
  RUNNER_LINUX_FULL_LABEL,
  RUNNER_POLICY_LABEL,
  RUNNER_SETTING_COPY,
  RUNNER_WHERE_LABEL,
} from "@t3tools/client-runtime/state/runnerModel";
import type { ResponseStreamingMode, ThreadEnvMode, WorktreeSubmodules } from "@t3tools/contracts";

import { MAINTENANCE_PAGE_LABELS } from "./components/heavyQueueCopy";
import {
  FALLBACK_MODELS_COPY,
  FOLDER_MODELS_COPY,
  PROJECT_MODEL_COPY,
} from "./components/modelDefaultsCopy";
import {
  DATABASE_STORAGE_COPY,
  IDLE_AGENTS_COPY,
  KEEP_AWAKE_COPY,
  TOOL_OUTPUT_HISTORY_COPY,
  WORKTREE_SNAPSHOTS_COPY,
} from "./components/maintenanceSectionsCopy";
import { RUNNER_SECTION_COPY } from "./components/runnerSectionCopy";
import { APP_SIGN_IN_COPY, APP_SIGN_IN_HOSTS } from "./components/sourceControlSignInCopy";
import { BRANCH_NAMING_COPY, WORKTREE_CLEANUP_COPY } from "./components/worktreeSettingsCopy";
import { RESOURCE_MANAGER_LABELS } from "../resources/resourceManagerCopy";
import { RUNTIME_MODE_CHOICES } from "../threads/thread-settings-options";
import { AUTO_SETTLE_COPY, LABS_COPY } from "./threadSettingsCopy";

interface Choice<Mode> {
  readonly mode: Mode;
  readonly label: string;
  readonly description: string;
}

export const SUBMODULE_CHOICES: ReadonlyArray<Choice<WorktreeSubmodules | null>> = [
  {
    mode: null,
    label: "Inherit",
    description: "Use the repository's t3.json, or initialize recursively.",
  },
  { mode: "recursive", label: "Recursive", description: "Initialize nested submodules too." },
  {
    mode: "top-level",
    label: "Top level only",
    description: "Skip submodules declared inside other submodules.",
  },
  { mode: "none", label: "Skip", description: "Leave submodules empty for a setup script." },
];

export const WORKSPACE_CHOICES: ReadonlyArray<Choice<ThreadEnvMode | null>> = [
  {
    mode: null,
    label: "Inherit",
    description: "Use the repository's t3.json, or the current checkout.",
  },
  {
    mode: "local",
    label: "Current checkout",
    description: "Start new threads in the existing workspace.",
  },
  {
    mode: "worktree",
    label: "New worktree",
    description: "Give each new thread a separate checkout.",
  },
];

export const STREAMING_CHOICES: ReadonlyArray<Choice<ResponseStreamingMode>> = [
  {
    mode: "turn",
    label: "After the turn",
    description: "Show the answer when the agent finishes.",
  },
  {
    mode: "paragraph",
    label: "Finished paragraphs",
    description: "Show each paragraph or code block as it completes.",
  },
];

/** The fixed text the Threads, Source control, Worktrees and Maintenance pages draw. */
export const SERVER_SETTINGS_COPY = {
  projectOverrides: { title: "Project" },
  defaultWorkspace: { title: "Default workspace" },
  defaultPermissions: { title: "Default permissions" },
  responseStreaming: { title: "Response streaming" },
  previewBrowser: { title: "Preview browser" },
  agentBrowserAccess: {
    title: "Agent browser access",
    description: "Allow agents to use the in-app preview browser.",
  },
  pullRequests: { title: "Pull requests" },
  removeAgentCredits: {
    title: "Remove agent credits when merging",
    description:
      "Remove recognized agent credits from merge and squash messages on hosts that support it, keeping human co-authors. Includes auto-merge. Excludes merge queues, stack merges, and existing commits.",
  },
  defaultBranch: { title: "Default branch" },
  autoPull: {
    title: "Automatically pull",
    description: "Keep the default branch current when there are no local changes.",
  },
  clones: { title: "Clones" },
  hostFolders: {
    title: "Clone into host folders",
    description: "Clones go to github.com/owner/repo under the Add project folder, like ghq.",
  },
  newWorktrees: { title: "New worktrees" },
  startFromRemote: {
    title: "Start from remote",
    description:
      "Uses the latest commit of the base branch’s tracked remote branch, even if its name differs. Otherwise uses the same-named branch on origin. Uses your local branch if that remote branch is missing.",
  },
  worktreeSubmodules: { title: "Worktree submodules" },
  manageEnvironments: { title: "Manage environments", description: "Server and provider updates" },
  resourceManager: { title: "Resource Manager" },
  updates: { title: "Updates" },
  providerUpdates: {
    title: "Check provider updates",
    description:
      "Check installed provider CLIs for newer versions and fetch model catalog updates. When off, new models may not appear.",
    projectDescription: "Environment-wide setting. Select All projects to change it.",
  },
  continueAfterRestart: {
    title: "Continue after restart",
    description: "Resume interrupted threads after an update or restart.",
  },
  diagnostics: { title: "Diagnostics" },
  detectProblems: {
    title: DETECT_PROBLEMS_LABEL,
    projectTitle: DETECT_PROBLEMS_IN_PROJECT_LABEL,
    description: DETECT_PROBLEMS_DESCRIPTION,
  },
} as const;

const copyText = (...keys: ReadonlyArray<keyof typeof SERVER_SETTINGS_COPY>) =>
  keys.flatMap((key) => Object.values(SERVER_SETTINGS_COPY[key]));
const choiceText = (choices: ReadonlyArray<Pick<Choice<unknown>, "label" | "description">>) =>
  choices.flatMap(({ label, description }) => [label, description]);

export const THREADS_PAGE_LABELS: readonly string[] = [
  ...copyText(
    "projectOverrides",
    "defaultWorkspace",
    "defaultPermissions",
    "responseStreaming",
    "previewBrowser",
    "agentBrowserAccess",
  ),
  ...choiceText(WORKSPACE_CHOICES),
  ...choiceText(RUNTIME_MODE_CHOICES),
  ...choiceText(STREAMING_CHOICES),
  ...Object.values(PROJECT_MODEL_COPY.sources),
  ...[
    PROJECT_MODEL_COPY.model,
    PROJECT_MODEL_COPY.byAssistant,
    PROJECT_MODEL_COPY.checkoutsDiffer,
    PROJECT_MODEL_COPY.selectedAutomatically,
  ].flatMap((entry) => Object.values(entry)),
  ...Object.values(FALLBACK_MODELS_COPY),
  ...Object.values(FOLDER_MODELS_COPY),
  ...Object.values(AUTO_SETTLE_COPY).flatMap((entry) => Object.values(entry)),
  // The page's old name for what its rows set.
  "thread behavior",
];

export const SOURCE_CONTROL_PAGE_LABELS: readonly string[] = [
  ...copyText("projectOverrides", "pullRequests", "removeAgentCredits", "defaultBranch"),
  ...copyText("autoPull", "clones", "hostFolders"),
  ...Object.values(APP_SIGN_IN_COPY),
  ...APP_SIGN_IN_HOSTS.flatMap(({ definition, appSignIn }) => [
    definition.label,
    appSignIn.appName,
  ]),
];

export const WORKTREES_PAGE_LABELS: readonly string[] = [
  ...copyText("projectOverrides", "newWorktrees", "startFromRemote", "worktreeSubmodules"),
  ...choiceText(SUBMODULE_CHOICES),
  BRANCH_NAMING_COPY.title,
  ...Object.values(BRANCH_NAMING_COPY.modes).flatMap((mode) => Object.values(mode)),
  BRANCH_NAMING_COPY.prefixHint,
  BRANCH_NAMING_COPY.instructionsHint,
  WORKTREE_CLEANUP_COPY.projectModes.title,
  ...choiceText(WORKTREE_CLEANUP_COPY.projectModes.choices),
  ...[
    WORKTREE_CLEANUP_COPY.onDelete,
    WORKTREE_CLEANUP_COPY.inactive,
    WORKTREE_CLEANUP_COPY.settled,
    WORKTREE_CLEANUP_COPY.runnerCopy,
  ].flatMap((entry) => Object.values(entry)),
  WORKTREE_CLEANUP_COPY.merged.title,
  WORKTREE_CLEANUP_COPY.merged.description,
  ...Object.values(WORKTREE_CLEANUP_COPY.merged.options),
  WORKTREE_CLEANUP_COPY.merged.daysUnused,
  WORKTREE_CLEANUP_COPY.days,
  WORKTREE_CLEANUP_COPY.keepWhen.title,
  ...choiceText(WORKTREE_CLEANUP_COPY.keepWhen.choices),
];

export const MAINTENANCE_SERVER_PAGE_LABELS: readonly string[] = [
  ...MAINTENANCE_PAGE_LABELS,
  ...copyText(
    "projectOverrides",
    "manageEnvironments",
    "resourceManager",
    "updates",
    "providerUpdates",
    "continueAfterRestart",
    "diagnostics",
    "detectProblems",
  ),
  ...Object.values(DATABASE_STORAGE_COPY),
  KEEP_AWAKE_COPY.title,
  ...Object.values(KEEP_AWAKE_COPY.modes),
  KEEP_AWAKE_COPY.note,
  KEEP_AWAKE_COPY.unsupported,
  ...Object.values(WORKTREE_SNAPSHOTS_COPY),
  ...Object.values(TOOL_OUTPUT_HISTORY_COPY),
  ...Object.values(IDLE_AGENTS_COPY),
  ...Object.values(RUNNER_SETTING_COPY).map(({ description }) => description),
  ...Object.values(RUNNER_WHERE_LABEL),
  ...Object.values(RUNNER_POLICY_LABEL),
  ...Object.values(RUNNER_LINUX_FULL_LABEL),
  ...Object.values(RUNNER_LINUX_FULL_DESCRIPTION),
  ...Object.values(RUNNER_FAILED_POLICY_LABEL),
  ...Object.values(RUNNER_DEADLINE_LABEL),
  ...Object.values(RUNNER_SECTION_COPY).flatMap((entry) => Object.values(entry)),
  ...RESOURCE_MANAGER_LABELS,
  // Its heavy queue slows agent jobs so other work on the machine keeps priority.
  "background priority",
];

export const LABS_PAGE_LABELS: readonly string[] = Object.values(LABS_COPY).flatMap((entry) =>
  Object.values(entry),
);
