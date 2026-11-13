/**
 * Each source's failure as a problem report, or null when it is none. The key names the
 * occurrence (a run, an outage, a check result), never the delivery, so repeats collapse.
 */
import {
  assistantIdFromThreadId,
  isDelegatedAppThread,
  isSideChatThread,
} from "@t3tools/contracts";

import type { HeavyEventRecord } from "../heavyQueue/heavyNotices.ts";
import { normalize, type ProblemReport } from "./problemRules.ts";

const SCHEDULED_MESSAGE_PREFIX = "scheduled-task-message:";

/** Assistants, subagents, delegated children and side chats are an agent's own loop (PRO-32). */
export const isOwnLoop = (
  threadId: string,
  shell: Parameters<typeof isDelegatedAppThread>[0] & Parameters<typeof isSideChatThread>[0],
) =>
  assistantIdFromThreadId(threadId) !== null ||
  isDelegatedAppThread(shell) ||
  isSideChatThread(shell);

/** Only a run that failed: an interrupt or a cancel is the user's own doing. */
export function runReport(
  run: {
    readonly id: string;
    readonly threadId: string;
    readonly status: string;
    readonly userMessageId: string;
    readonly providerInstanceId: string;
  },
  error: string | null,
  at: number,
): ProblemReport | null {
  if (run.status !== "failed") return null;
  const scheduled = run.userMessageId.startsWith(SCHEDULED_MESSAGE_PREFIX);
  return {
    key: `run:${run.id}`,
    source: scheduled ? "scheduled" : "run",
    projectId: null,
    threadId: run.threadId,
    subject: `provider:${run.providerInstanceId}`,
    command: null,
    error: error?.trim() || "Run failed",
    where: null,
    at,
  };
}

export function sessionReport(
  threadId: string,
  session: {
    readonly id: string;
    readonly status: string;
    readonly providerInstanceId: string;
    readonly lastError: string | null;
  },
  at: number,
): ProblemReport | null {
  if (session.status !== "error") return null;
  const error = session.lastError?.trim() || "Provider session failed";
  return {
    key: `session:${session.id}:${normalize(error).slice(0, 200)}`,
    source: "session",
    projectId: null,
    threadId,
    subject: `provider:${session.providerInstanceId}`,
    command: null,
    error,
    where: null,
    at,
  };
}

// ponytail: only PR snapshots carry checksState today; default-branch CI reports with
// `subject: branch:<name>` here once a signal for it exists.
export const checksReport = (
  threadId: string,
  link: { readonly number: number; readonly url: string; readonly stamp: string },
  at: number,
): ProblemReport => ({
  key: `ci:${threadId}:${link.number}:${link.stamp}`,
  source: "ci",
  projectId: null,
  threadId,
  subject: `pr:${link.number}`,
  command: link.url,
  error: `Checks failing on PR #${link.number}`,
  prNumber: link.number,
  where: null,
  at,
});

export interface ScheduledRow {
  readonly task_id: string;
  readonly title: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly assistant_team_id: string | null;
  readonly last_run_at: string;
  readonly last_run_error: string | null;
}

/** A schedule that failed, including before its run started. An assistant's own routine is skipped. */
export const scheduledReport = (row: ScheduledRow): ProblemReport | null =>
  row.assistant_team_id !== null ||
  (row.thread_id !== null && assistantIdFromThreadId(row.thread_id) !== null)
    ? null
    : {
        key: `scheduled:${row.task_id}:${row.last_run_at}`,
        source: "scheduled",
        projectId: row.project_id,
        threadId: null,
        subject: `task:${row.task_id}`,
        command: row.title,
        error: row.last_run_error?.trim() || "Scheduled run failed",
        where: null,
        at: Date.parse(row.last_run_at),
      };

export interface LinkRow {
  readonly environment_id: string;
  readonly label: string;
  readonly last_error: string;
  readonly last_reached_at: string | null;
  readonly linked_at: string;
}

/** One occurrence per outage: until the link answers again, its last success stays the same. */
export const linkReport = (row: LinkRow, at: number): ProblemReport => ({
  key: `link:${row.environment_id}:${row.last_reached_at ?? row.linked_at}`,
  source: "link",
  projectId: null,
  threadId: null,
  subject: `env:${row.environment_id}`,
  command: null,
  error: row.last_error,
  where: row.label,
  at,
});

/**
 * A Runner job's failure. Linux environment failures are problems by themselves; a plain failure
 * of a thread's job is that agent's own work, and one run from a terminal counts for the repeat rule.
 */
export function runnerReport(record: HeavyEventRecord): ProblemReport | null {
  const base = {
    key: `runner:${record.id}`,
    source: "runner" as const,
    projectId: null,
    threadId: record.job.threadId,
    subject: null,
    command: record.job.name,
    where: record.job.runner === "linux" ? "Linux" : "this Mac",
    at: record.at,
  };
  switch (record.kind) {
    case "ended": {
      if (record.code === 126 || record.code === 127)
        return { ...base, error: `Exit code ${record.code}` };
      if (record.phase === "syncing")
        return { ...base, error: `Exit code ${record.code}`, reason: "linux-sync" };
      if (record.phase === "installing")
        return { ...base, error: `Exit code ${record.code}`, reason: "linux-install" };
      return record.job.threadId === null ? { ...base, error: `Exit code ${record.code}` } : null;
    }
    case "linux-lost":
      return { ...base, error: "Linux dropped the job", reason: "linux-lost" };
    // Linux environment failures land here as new record kinds with their own reason.
    default:
      return null;
  }
}
