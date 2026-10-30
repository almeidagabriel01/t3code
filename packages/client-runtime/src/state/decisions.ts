import {
  WS_METHODS,
  type Decision,
  type DecisionId,
  type DecisionsEvent,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import { subscribe } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

export interface DecisionsState {
  readonly decisions: ReadonlyMap<DecisionId, Decision>;
}

/** Folds one event; the first is always a snapshot, so state starts from it. */
export function applyDecisionsEvent(
  state: DecisionsState | null,
  event: DecisionsEvent,
): DecisionsState | null {
  if (event.type === "snapshot") {
    return { decisions: new Map(event.decisions.map((decision) => [decision.id, decision])) };
  }
  if (state === null) return null;
  return { decisions: new Map(state.decisions).set(event.decision.id, event.decision) };
}

/** Open decisions, oldest first: the one waiting longest is the first to answer. */
export function selectOpenDecisions(state: DecisionsState): ReadonlyArray<Decision> {
  return [...state.decisions.values()]
    .filter((decision) => decision.status === "open")
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
}

/** Settled decisions, most recently settled first. */
export function selectSettledDecisions(state: DecisionsState): ReadonlyArray<Decision> {
  const settledAt = (decision: Decision) => decision.answeredAt ?? decision.createdAt;
  return [...state.decisions.values()]
    .filter((decision) => decision.status !== "open")
    .sort(
      (left, right) =>
        settledAt(right).localeCompare(settledAt(left)) || left.id.localeCompare(right.id),
    );
}

/** Soonest expiry first, then oldest: what to answer before it lapses. */
function compareUrgency(left: Decision, right: Decision): number {
  if (left.expiresAt !== right.expiresAt) {
    if (left.expiresAt === undefined) return 1;
    if (right.expiresAt === undefined) return -1;
    return left.expiresAt.localeCompare(right.expiresAt);
  }
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export interface DecisionEntry {
  readonly environmentId: EnvironmentId;
  readonly decision: Decision;
}

/** Every environment's decisions in one list: open by urgency, settled most recent first. */
export function collectDecisionEntries(
  states: Iterable<readonly [EnvironmentId, DecisionsState]>,
): { readonly open: ReadonlyArray<DecisionEntry>; readonly settled: ReadonlyArray<DecisionEntry> } {
  const open: DecisionEntry[] = [];
  const settled: DecisionEntry[] = [];
  for (const [environmentId, state] of states) {
    for (const decision of selectOpenDecisions(state)) open.push({ environmentId, decision });
    for (const decision of selectSettledDecisions(state)) settled.push({ environmentId, decision });
  }
  const settledAt = ({ decision }: DecisionEntry) => decision.answeredAt ?? decision.createdAt;
  return {
    open: open.sort((left, right) => compareUrgency(left.decision, right.decision)),
    settled: settled.sort((left, right) => settledAt(right).localeCompare(settledAt(left))),
  };
}

/** "Expires in 2h" for an open decision with a deadline; "Expired" once it has passed. */
export function formatDecisionExpiry(expiresAt: string, nowMs: number): string {
  const left = Date.parse(expiresAt) - nowMs;
  if (Number.isNaN(left)) return "";
  if (left <= 0) return "Expired";
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `Expires in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `Expires in ${hours}h` : `Expires in ${Math.floor(hours / 24)}d`;
}

/** What a settled decision reads as: its outcome, and the chosen option or note when there is one. */
export function describeSettledDecision(decision: Decision): {
  readonly outcome: string;
  readonly detail: string | null;
} {
  if (decision.status === "expired") return { outcome: "Expired", detail: "No answer was given." };
  if (decision.status === "withdrawn") {
    return decision.answeredAt === undefined
      ? { outcome: "Withdrawn", detail: "The agent took the question back." }
      : { outcome: "Dismissed", detail: "Nothing was approved." };
  }
  const label = decision.options.find((option) => option.id === decision.answer?.optionId)?.label;
  const note = decision.answer?.text;
  return {
    outcome: "Answered",
    detail: [label, note].filter((part) => part !== undefined && part !== "").join(" · ") || null,
  };
}

/** The message a refused answer shows inline; the card then reads the refreshed decision. */
export function decisionErrorMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message
    ? error.message
    : "The decision request failed. Try again.";
}

/** How many open decisions each thread is waiting on, for badges. */
export function openDecisionCountByThread(state: DecisionsState): ReadonlyMap<ThreadId, number> {
  const counts = new Map<ThreadId, number>();
  for (const decision of selectOpenDecisions(state)) {
    counts.set(decision.fromThreadId, (counts.get(decision.fromThreadId) ?? 0) + 1);
  }
  return counts;
}

/** Scoped thread keys with an open decision across environments, as the Activity ranking reads them. */
export function openDecisionThreadKeys(
  states: Iterable<readonly [EnvironmentId, DecisionsState]>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [environmentId, state] of states) {
    for (const threadId of openDecisionCountByThread(state).keys()) {
      keys.add(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
    }
  }
  return keys;
}

export function decisionsStateStream<E, R>(
  events: Stream.Stream<DecisionsEvent, E, R>,
): Stream.Stream<DecisionsState, E, R> {
  return events.pipe(
    Stream.scan((): DecisionsState | null => null, applyDecisionsEvent),
    Stream.filter((state): state is DecisionsState => state !== null),
  );
}

export function createDecisionsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // One lane per environment keeps a person's answers applied in the order they gave them.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial",
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  } as const;
  const command = <
    TTag extends typeof WS_METHODS.decisionsAnswer | typeof WS_METHODS.decisionsDismiss,
  >(
    tag: TTag,
    name: string,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:decisions:${name}`,
      tag,
      scheduler,
      concurrency,
    });
  return {
    live: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:decisions:live",
      subscribe: (_input: null) =>
        decisionsStateStream(subscribe(WS_METHODS.decisionsSubscribe, {})),
    }),
    answer: command(WS_METHODS.decisionsAnswer, "answer"),
    dismiss: command(WS_METHODS.decisionsDismiss, "dismiss"),
  };
}
