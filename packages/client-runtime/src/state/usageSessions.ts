import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "./shell.ts";
import { formatWorkingDurationLabel, resolveThreadWorkingStartedAt } from "./models.ts";
import { resolveSidebarThreadStatus } from "./threadAttention.ts";

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

function sessionState(
  thread: EnvironmentThreadShell,
  isWorking: (thread: EnvironmentThreadShell) => boolean,
  now: number,
): UsageSessionState | null {
  if (isWorking(thread)) return "working";
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input" || status === "request") return "waiting";
  const updated = Date.parse(thread.updatedAt);
  return Number.isFinite(updated) && now - updated <= RECENT_WINDOW_MS ? "recent" : null;
}

/** Live threads currently on `instanceId` in `environmentIds`: waiting for you, then working, then recent. */
export function collectUsageSessions(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly instanceId: ProviderInstanceId;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  /** `isWorkingShell`, so these sessions count what every Working list does. */
  readonly isWorking: (thread: EnvironmentThreadShell) => boolean;
  readonly now: number;
}): ReadonlyArray<UsageSession> {
  const { instanceId, environmentIds } = input;
  return collectSessionsWhere({
    threads: input.threads,
    isWorking: input.isWorking,
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
  /** `isWorkingShell`, so these sessions count what every Working list does. */
  readonly isWorking: (thread: EnvironmentThreadShell) => boolean;
  readonly now: number;
}): ReadonlyArray<UsageSession> {
  return collectSessionsWhere({
    threads: input.threads,
    isWorking: input.isWorking,
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
  readonly isWorking: (thread: EnvironmentThreadShell) => boolean;
  readonly now: number;
}): ReadonlyArray<UsageSession> {
  const { now } = input;
  return input.threads
    .flatMap((thread) => {
      if (
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        thread.sideChatOf != null ||
        !input.matches(thread)
      ) {
        return [];
      }
      const state = sessionState(thread, input.isWorking, now);
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

/** Working and waiting-for-you threads are open; recent ones are finished. */
export function splitSessions(sessions: ReadonlyArray<UsageSession>) {
  return {
    open: sessions.filter((session) => session.state !== "recent"),
    finished: sessions.filter((session) => session.state === "recent"),
  };
}

/** "Sessions · 2 working · 1 need you", worded as Activity words its sections. */
export function usageSessionsHeading(sessions: ReadonlyArray<UsageSession>): string {
  const count = (state: UsageSessionState) =>
    sessions.filter((session) => session.state === state).length;
  const working = count("working");
  const waiting = count("waiting");
  return [
    "Sessions",
    working > 0 ? `${working} working` : null,
    waiting > 0 ? `${waiting} need you` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
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
