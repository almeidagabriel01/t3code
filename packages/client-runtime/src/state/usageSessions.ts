import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "./shell.ts";
import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
  threadRuntimeIsActive,
} from "./models.ts";

export type UsageSessionState = "waiting" | "working" | "recent";

export interface UsageSession {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectKey: string;
  readonly title: string;
  readonly state: UsageSessionState;
  readonly model: string;
  readonly elapsed: string;
}

const RECENT_WINDOW_MS = 60 * 60_000;
const STATE_ORDER: Record<UsageSessionState, number> = { waiting: 0, working: 1, recent: 2 };

function sessionState(thread: EnvironmentThreadShell, now: number): UsageSessionState | null {
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.runtime?.status === "waiting"
  ) {
    return "waiting";
  }
  if (threadRuntimeIsActive(thread.runtime)) return "working";
  const updated = Date.parse(thread.updatedAt);
  return Number.isFinite(updated) && now - updated <= RECENT_WINDOW_MS ? "recent" : null;
}

/** Live threads currently on `instanceId` in `environmentIds`: waiting for you, then working, then recent. */
export function collectUsageSessions(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly instanceId: ProviderInstanceId;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly now: number;
}): ReadonlyArray<UsageSession> {
  const { instanceId, environmentIds } = input;
  return collectSessionsWhere({
    threads: input.threads,
    now: input.now,
    matches: (thread) =>
      environmentIds.includes(thread.environmentId) &&
      (thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId) === instanceId,
  });
}

/** One account can sign in as several provider instances across environments. */
export function collectAccountSessions(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly instances: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly instanceId: ProviderInstanceId;
  }>;
  readonly now: number;
}): ReadonlyArray<UsageSession> {
  return collectSessionsWhere({
    threads: input.threads,
    now: input.now,
    matches: (thread) => {
      const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
      return input.instances.some(
        (entry) => entry.environmentId === thread.environmentId && entry.instanceId === instanceId,
      );
    },
  });
}

function collectSessionsWhere(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly matches: (thread: EnvironmentThreadShell) => boolean;
  readonly now: number;
}): ReadonlyArray<UsageSession> {
  const { now } = input;
  return input.threads
    .flatMap((thread) => {
      if (thread.deletedAt !== null || thread.archivedAt !== null || !input.matches(thread)) {
        return [];
      }
      const state = sessionState(thread, now);
      if (state === null) return [];
      const startedAt =
        state === "recent"
          ? thread.updatedAt
          : resolveThreadWorkingStartedAt({
              latestRun: thread.latestRun,
              runtime: thread.runtime,
            });
      const started = startedAt === null ? Number.NaN : Date.parse(startedAt);
      const session: UsageSession = {
        environmentId: thread.environmentId,
        threadId: thread.id,
        projectKey: `${thread.environmentId}:${thread.projectId}`,
        title: thread.title,
        state,
        model: thread.modelSelection.model,
        elapsed: Number.isFinite(started)
          ? `${formatWorkingDurationLabel(now - started)}${state === "recent" ? " ago" : ""}`
          : "",
      };
      return [{ session, order: Date.parse(thread.updatedAt) }];
    })
    .sort(
      (a, b) => STATE_ORDER[a.session.state] - STATE_ORDER[b.session.state] || b.order - a.order,
    )
    .map(({ session }) => session);
}

/** Groups keep the order of their first session, so the most urgent project leads. */
export function groupSessionsByProject(sessions: ReadonlyArray<UsageSession>) {
  const groups = new Map<string, UsageSession[]>();
  for (const session of sessions) {
    const group = groups.get(session.projectKey);
    if (group) group.push(session);
    else groups.set(session.projectKey, [session]);
  }
  return [...groups].map(([projectKey, items]) => ({ projectKey, sessions: items }));
}
