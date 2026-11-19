/**
 * Problem detection without a model: what counts as a problem, which cause it belongs to, who
 * handles it, and the text on its card and in its notice. Pure, so it is tested as tables.
 */
import {
  PROBLEM_KIND_TITLES,
  type AssistantScope,
  type AssistantToolAccess,
  type ProblemKind,
  type ProblemLevel,
  type ProjectId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as DateTime from "effect/DateTime";

import { redactChannelText } from "../channels/channelRedaction.ts";

export type ProblemSource = "runner" | "run" | "ci" | "scheduled" | "session" | "link";

export type ProblemReason =
  | "command-not-found"
  | "sign-in-expired"
  | "network"
  | "disk-full"
  | "out-of-memory"
  | "linux-sync"
  | "linux-install"
  | "linux-lost"
  | "session-failed"
  | "run-failed"
  | "checks-failing"
  | "scheduled-failed"
  | "link-unreachable"
  | "repeated";

/** One failure a source saw. `key` names the occurrence, so a repeated delivery is the same one. */
export interface ProblemReport {
  readonly key: string;
  readonly source: ProblemSource;
  /** Null resolves from the thread, then `projectFolder`, else the No-project board. */
  readonly projectId: string | null;
  readonly projectFolder?: string | null | undefined;
  readonly threadId: string | null;
  readonly threadTitle?: string | null;
  /** A raw identity that is part of the cause: a PR number, task, environment or provider. */
  readonly subject: string | null;
  readonly command: string | null;
  readonly error: string;
  /** Set by a source that already knows why, such as a Runner fault. */
  readonly reason?: ProblemReason | undefined;
  /** A cause key from a source that already knows it; it alone identifies the card. */
  readonly cause?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly where: string | null;
  readonly at: number;
}

const ENVIRONMENT: ReadonlyArray<readonly [ProblemReason, RegExp]> = [
  [
    "command-not-found",
    /command not found|not recognized as an internal or external command|spawn \S+ ENOENT|ENOENT[^\n]*spawn|executable file not found|exit(?: code)? 12[67]\b/i,
  ],
  [
    "sign-in-expired",
    /\b401\b|unauthori[sz]ed|authentication (?:failed|required|expired)|(?:token|session|credentials?|login) (?:has |have )?expired|not logged in|please (?:log ?in|sign ?in)|invalid api key|re-?authenticate/i,
  ],
  [
    "network",
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|getaddrinfo|could not resolve host|network is unreachable|socket hang up|name or service not known/i,
  ],
  ["disk-full", /ENOSPC|no space left on device|disk (?:is )?full/i],
  [
    "out-of-memory",
    /out of memory|ENOMEM|heap out of memory|OOMKilled|cannot allocate memory|exit(?: code)? 137\b/i,
  ],
];

const SOURCE_REASON: Record<ProblemSource, ProblemReason | null> = {
  runner: null,
  run: "run-failed",
  ci: "checks-failing",
  scheduled: "scheduled-failed",
  session: "session-failed",
  link: "link-unreachable",
};

const KIND_OF: Record<ProblemReason, ProblemKind> = {
  "command-not-found": "environment",
  "sign-in-expired": "environment",
  network: "environment",
  "disk-full": "environment",
  "out-of-memory": "environment",
  "linux-sync": "environment",
  "linux-install": "environment",
  "linux-lost": "environment",
  "session-failed": "provider",
  "run-failed": "provider",
  "checks-failing": "ci",
  "scheduled-failed": "scheduled-task",
  "link-unreachable": "connection",
  repeated: "repeated",
};

export interface Classified {
  readonly kind: ProblemKind;
  readonly reason: ProblemReason;
}

/** Null means not a problem by itself; the repeat rule may still make it one. */
export function classify(report: ProblemReport): Classified | null {
  const reason =
    report.reason ??
    ENVIRONMENT.find(([, pattern]) => pattern.test(report.error))?.[0] ??
    SOURCE_REASON[report.source];
  return reason === null ? null : { kind: KIND_OF[reason], reason };
}

/** The same cause on different runs reads the same: volatile parts become fixed tokens. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}[t ][\d:.]+(?:z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g, "<time>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<id>")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/g, "<hash>")
    .replace(/(?:~|\.{1,2})?(?:\/[\w.@%+-]+)+\/?/g, "<path>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/** Which root holds `folder`, by id; the longest root wins. */
export function folderOwner<Id extends string>(
  folder: string,
  roots: ReadonlyArray<{ readonly id: Id; readonly root: string }>,
): Id | null {
  let best: { readonly id: Id; readonly length: number } | null = null;
  for (const { id, root } of roots) {
    const base = root.replace(/\/+$/, "");
    const holds = folder === base || folder.startsWith(`${base}/`);
    if (holds && (best === null || base.length > best.length)) best = { id, length: base.length };
  }
  return best?.id ?? null;
}

/** Source, project, subject, command shape and error signature: one cause, one card. */
export function fingerprint(
  report: ProblemReport,
  projectId: string,
  reason: ProblemReason | null,
): string {
  if (report.cause !== undefined)
    return [report.source, projectId, `cause:${report.cause}`].join("|");
  return [
    report.source,
    projectId,
    report.subject ?? "",
    normalize(report.command ?? ""),
    reason ?? "unclassified",
    normalize(firstLine(report.error)).slice(0, 200),
  ].join("|");
}

export interface OwnerCandidate {
  readonly id: string;
  readonly name: string;
  readonly scope: AssistantScope;
  readonly projectIds: ReadonlyArray<string>;
  /** In reply-and-notify mode. */
  readonly notifies: boolean;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly threadId: string | null;
}

/**
 * The one assistant that handles a project's problem: a project assistant with the project, else
 * one with every project. It agrees with `projectScopeRefusal`, so the owner may act there.
 */
export function selectOwner<A extends OwnerCandidate>(
  candidates: ReadonlyArray<A>,
  projectId: string,
): A | null {
  const active = candidates.filter((a) => a.archivedAt === null && a.threadId !== null);
  const scoped = active.filter((a) => a.scope === "project" && a.projectIds.includes(projectId));
  const pool = scoped.length > 0 ? scoped : active.filter((a) => a.scope === "all");
  return (
    pool.toSorted(
      (a, b) =>
        Number(b.notifies) - Number(a.notifies) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    )[0] ?? null
  );
}

/** "Detect problems", where a project's own setting wins over the global one. */
export const detectionEnabled = (
  settings: Pick<ServerSettings, "detectProblems" | "projectSettingsOverrides">,
  projectId: string | null,
): boolean =>
  ((projectId === null
    ? undefined
    : settings.projectSettingsOverrides?.[projectId as ProjectId]?.detectProblems) ??
    settings.detectProblems) === true;

/** A read-only assistant can only tell. */
export const effectiveLevel = (level: ProblemLevel, toolAccess: AssistantToolAccess) =>
  toolAccess === "read-only" ? ("tell" as const) : level;

const SOURCE_LABELS: Record<ProblemSource, string> = {
  runner: "Runner",
  run: "Agent run",
  ci: "Pull request checks",
  scheduled: "Scheduled task",
  session: "Provider session",
  link: "Environment link",
};

export function reasonLabel(reason: ProblemReason, prNumber?: number | undefined): string {
  switch (reason) {
    case "command-not-found":
      return "Command not found";
    case "sign-in-expired":
      return "Sign-in expired";
    case "network":
      return "Network or DNS failure";
    case "disk-full":
      return "Disk full";
    case "out-of-memory":
      return "Out of memory";
    case "linux-sync":
      return "Linux sync failed";
    case "linux-install":
      return "Dependency install on Linux failed";
    case "linux-lost":
      return "Linux dropped the job";
    case "session-failed":
      return "Provider session failed";
    case "run-failed":
      return "Run failed";
    case "checks-failing":
      return `Checks failing on PR #${prNumber ?? "?"}`;
    case "scheduled-failed":
      return "Scheduled run failed";
    case "link-unreachable":
      return "Link unreachable";
    case "repeated":
      return "Seen 3 times in 24 hours";
  }
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** What a card and a notice may show of an error: secrets out, kept short. */
export const excerpt = (error: string) => clip(redactChannelText(error.trim()), 1_000);

export const summaryOf = (error: string) =>
  clip(redactChannelText(firstLine(error)), 120).replace(/\.+$/, "") || "Failed";

export const cardTitle = (kind: ProblemKind, error: string) =>
  clip(`${PROBLEM_KIND_TITLES[kind]}: ${summaryOf(error)}`, 200);

/** Everything a card shows about its cause. Only ever built from that cause's own occurrences. */
export interface ProblemEvidence {
  readonly source: ProblemSource;
  readonly reason: ProblemReason;
  readonly prNumber?: number | undefined;
  readonly command: string | null;
  readonly error: string;
  readonly where: string | null;
  readonly firstSeen: number;
  readonly lastSeen: number;
  /** The source threads, newest last. */
  readonly threads: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}

const seenAt = (ms: number) =>
  `${DateTime.formatIso(DateTime.makeUnsafe(ms)).slice(0, 16).replace("T", " ")} UTC`;

export function evidenceDescription(evidence: ProblemEvidence): string {
  const error = evidence.error.includes("\n")
    ? `\n\n\`\`\`\n${evidence.error.replaceAll("```", "'''")}\n\`\`\``
    : ` ${evidence.error}`;
  return [
    `- **Source:** ${SOURCE_LABELS[evidence.source]}`,
    ...(evidence.command === null
      ? []
      : [`- **${evidence.source === "ci" ? "Check" : "Command"}:** \`${evidence.command}\``]),
    `- **Reason:** ${reasonLabel(evidence.reason, evidence.prNumber)}`,
    ...(evidence.where === null ? [] : [`- **Where:** ${evidence.where}`]),
    `- **First seen:** ${seenAt(evidence.firstSeen)}`,
    `- **Last seen:** ${seenAt(evidence.lastSeen)}`,
    ...(evidence.threads.length === 0
      ? []
      : [
          `- **Threads:** ${evidence.threads
            .map((thread) =>
              formatThreadLink(
                { environmentId: null, threadId: thread.id as ThreadId },
                thread.title,
              ),
            )
            .join(", ")}`,
        ]),
    `- **Error:**${error}`,
  ].join("\n");
}

export const noticeHeader = (projectName: string, summary: string, cardNumber: number) =>
  `Problem in ${projectName}: ${summary}. Card #${cardNumber}.`;

export const noOwnerNotice = (projectName: string) =>
  `No assistant can work on ${projectName}. Give one access in Assistants.`;

export interface WakeCase {
  readonly header: string;
  readonly cardId: string;
  readonly projectId: string;
  readonly description: string;
  readonly count: number;
  /** It reached this assistant because the previous one can no longer work on the project. */
  readonly reassigned: boolean;
}

const LEVEL_NAMES: Record<ProblemLevel, string> = {
  tell: "Tell me",
  offer: "Offer to fix",
  "fix-small": "Fix small things",
};

const SMALL =
  "Small means: retrying or re-running, re-authenticating a provider, reinstalling dependencies, clearing a cache with the tool's own command (such as `npm cache clean`), or a change of a few lines in a new worktree. Anything else, including removing files yourself, is bigger.";

const START =
  "To start a fix: launch a new thread in the card's project (a new worktree for code changes), link it to the card with t3_kanban link_thread, and create a one-shot t3_watch on that thread's run_finished whose instruction is to move the card to review with a summary and tell the user.";

const LEVEL_STEPS: Record<ProblemLevel, string> = {
  tell: "Read the card and its threads. Start nothing and change nothing. In your answer, say in a few sentences what went wrong and what would fix it.",
  offer: `Read the card and its threads and work out a fix, but start nothing yet. In your answer, propose the fix in a few sentences and ask whether to start. Start only after the user agrees. ${START}`,
  "fix-small": `${SMALL} If the fix is small, start it now. ${START} In your answer, say what you started. If the fix is bigger or risky, start nothing: propose it, ask whether to start, and start only after the user agrees.`,
};

/** The message the owner wakes on; its final answer becomes the user's notice. */
export function wakeText(cases: ReadonlyArray<WakeCase>, level: ProblemLevel): string {
  return [
    "[Autonomy] Problem detected",
    cases.length === 1
      ? "T3 Code found a problem and filed a card for it on its project's board. You handle it."
      : `T3 Code found ${cases.length} problems and filed a card for each on its project's board. You handle them.`,
    ...cases.map((item, index) =>
      [
        `${index + 1}. ${item.header} (card id ${item.cardId}, projectId ${item.projectId}; seen ${item.count} time${item.count === 1 ? "" : "s"})`,
        ...(item.reassigned
          ? ["It moved to you: the assistant that had it can no longer work on that project."]
          : []),
        item.description,
      ].join("\n"),
    ),
    `Your level is "${LEVEL_NAMES[level]}". ${LEVEL_STEPS[level]}`,
    "Never push, merge, deploy, delete files, branches or data, or open a pull request without the user's explicit OK, at any level. Your tool access, your projects and Ask before acting apply as always.",
    "Your final answer is sent to the user right after the line naming each card, so write only what comes next. Do not call notify_user for these cards. If the user later asks to stop reporting one, call t3_kanban ignore_problem on its card.",
  ].join("\n\n");
}
