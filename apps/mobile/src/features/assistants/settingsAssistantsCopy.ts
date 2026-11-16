import {
  AUTONOMY_CHANNEL_LABELS,
  AUTONOMY_RULE_OPTIONS,
  DETECT_PROBLEMS_DESCRIPTION,
  DETECT_PROBLEMS_LABEL,
} from "@t3tools/client-runtime/autonomy";
import {
  SANDBOX_CPU_DESCRIPTION,
  SANDBOX_GITHUB_DESCRIPTION,
  SANDBOX_WHEN_DONE_CHOICES,
  SANDBOX_WHEN_DONE_DESCRIPTION,
  sandboxCpuChoices,
} from "@t3tools/client-runtime/state/assistants";

/** The Assistants page's fixed labels; Settings search reads these same strings. */
export const ASSISTANT_SECTION_TITLE = {
  needs: "Needs you",
  unassigned: "Unassigned",
  archivedGroups: "Archived groups",
  archived: "Archived",
} as const;

export const RESTORE_JARVIS_DESCRIPTION = "The default assistant was deleted. Brings him back.";

export const SANDBOX_COPY = {
  title: "Sandbox",
  footer:
    "A Linux container (Docker) on the server's machine where assistants set to Sandbox run commands and edit files. To sign in to providers inside it, open T3 Code on that Mac, Settings, Assistants, Sandbox.",
  container: "Sandbox container",
  linkedEnvironments: "Linked environments",
  linkedEnvironmentsDescription: "The sandbox link needs it. Starting the sandbox turns it on.",
  github: "GitHub",
  githubTitle: "GitHub in the sandbox",
  cpuTitle: "CPU limit",
  whenDoneTitle: "When a task is done",
} as const;

export const AUTONOMY_COPY = {
  title: "Autonomy",
  footer:
    "Assistants set to notify wake on their own and tell you. Turn off the first switch to pause every rule and watch.",
  notifyEnabled: {
    title: "Assistants can notify you",
    description: "The pause switch for all assistants on this server.",
  },
  notifyWaiting: {
    title: "Notify me when something is waiting for me",
    description:
      "Approvals, questions, open decisions and paused group tasks reach you directly, with no model and no daily limit. Works for every assistant and thread.",
  },
  notifyAfter: {
    title: "Notify after",
    description: "Something answered sooner is not sent.",
  },
  waitingAfter: {
    title: "Waiting for you after",
    description:
      "How long a run may wait on your answer before an assistant wakes to look into it.",
  },
  stuckAfter: {
    title: "Stuck after",
    description: "How long a run may show no activity before it looks stuck.",
  },
  wakesPerDay: {
    title: "Notifications per day",
    description: "Assistants stop waking after this many in a day.",
  },
  messagesPerDay: {
    title: "Messages from assistants per day",
    description: "How many short messages each assistant can send you on its own.",
  },
  channelDescription: {
    telegram: "Send the answer to the first allowed Telegram user.",
    t3: "Show the answer in Activity, on every device.",
  },
  telegramNotSetUp: {
    title: "Telegram is not set up",
    description:
      "Notifications cannot reach Telegram until a bot is connected. Open Telegram settings.",
  },
  telegramUnavailable: {
    title: "Telegram is not available",
    description: "This server does not support Telegram.",
  },
} as const;

const titleAndDescription = (copy: { readonly title: string; readonly description: string }) => [
  copy.title,
  copy.description,
];

export const ASSISTANTS_PAGE_LABELS: readonly string[] = [
  ...Object.values(ASSISTANT_SECTION_TITLE),
  RESTORE_JARVIS_DESCRIPTION,
  ...Object.values(SANDBOX_COPY),
  SANDBOX_GITHUB_DESCRIPTION,
  SANDBOX_CPU_DESCRIPTION,
  SANDBOX_WHEN_DONE_DESCRIPTION,
  ...sandboxCpuChoices(null).map(({ label }) => label),
  ...SANDBOX_WHEN_DONE_CHOICES.map(({ label }) => label),
  AUTONOMY_COPY.title,
  AUTONOMY_COPY.footer,
  ...[
    AUTONOMY_COPY.notifyEnabled,
    AUTONOMY_COPY.notifyWaiting,
    AUTONOMY_COPY.notifyAfter,
    AUTONOMY_COPY.waitingAfter,
    AUTONOMY_COPY.stuckAfter,
    AUTONOMY_COPY.wakesPerDay,
    AUTONOMY_COPY.messagesPerDay,
    AUTONOMY_COPY.telegramNotSetUp,
    AUTONOMY_COPY.telegramUnavailable,
  ].flatMap(titleAndDescription),
  DETECT_PROBLEMS_LABEL,
  DETECT_PROBLEMS_DESCRIPTION,
  ...AUTONOMY_RULE_OPTIONS.flatMap(({ label, description }) => [label, description]),
  ...Object.entries(AUTONOMY_COPY.channelDescription).flatMap(([channel, description]) => [
    `Notify on ${AUTONOMY_CHANNEL_LABELS[channel as keyof typeof AUTONOMY_CHANNEL_LABELS]}`,
    description,
  ]),
];
