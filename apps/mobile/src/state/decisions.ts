import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  collectDecisionEntries,
  createDecisionsEnvironmentAtoms,
  decisionErrorMessage,
  openDecisionThreadKeys,
  type DecisionEntry,
  type DecisionsState,
} from "@t3tools/client-runtime/state/decisions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type DecisionId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";
import { environmentSession, sessionHasScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

const decisionsEnvironment = createDecisionsEnvironmentAtoms(connectionAtomRuntime);

/** Environments whose server has decisions, from the cached server config. Opens no stream. */
const decisionsEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.decisions === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("mobile-decisions-environment-ids"));

const decisionsFeedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): AsyncResult.AsyncResult<DecisionsState, unknown> =>
    sessionHasScope(
      get(environmentSession.sessionStateAtom(environmentId)),
      AuthOrchestrationReadScope,
    )
      ? get(decisionsEnvironment.live({ environmentId, input: null }))
      : AsyncResult.initial(),
  ).pipe(Atom.withLabel(`mobile-decisions-feed:${environmentId}`)),
);

const decisionStatesAtom = Atom.make((get) =>
  get(decisionsEnvironmentIdsAtom).flatMap((environmentId) => {
    const state = Option.getOrNull(AsyncResult.value(get(decisionsFeedAtom(environmentId))));
    return state === null ? [] : [[environmentId, state] as const];
  }),
).pipe(Atom.withLabel("mobile-decision-states"));

const decisionEntriesAtom = Atom.make((get) =>
  collectDecisionEntries(get(decisionStatesAtom)),
).pipe(Atom.withLabel("mobile-decision-entries"));

const openDecisionThreadKeysAtom = Atom.make((get) =>
  openDecisionThreadKeys(get(decisionStatesAtom)),
).pipe(Atom.withLabel("mobile-open-decision-thread-keys"));

/** Open decisions by urgency and recent settled ones, across the environments that have them. */
export function useDecisionEntries() {
  return useAtomValue(decisionEntriesAtom);
}

/** Scoped thread keys with an open decision, for the attention badge. */
export function useOpenDecisionThreadKeys(): ReadonlySet<string> {
  return useAtomValue(openDecisionThreadKeysAtom);
}

/** The thread's open decisions, most urgent first. Provider approvals are left out: the thread already shows them natively. */
export function useThreadOpenDecisions(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<DecisionEntry> {
  return useDecisionEntries().open.filter(
    (entry) =>
      entry.environmentId === environmentId &&
      entry.decision.fromThreadId === threadId &&
      entry.decision.approvalRequestId === undefined,
  );
}

export function decisionThreadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

export type DecisionReply =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** Answering and dismissing settle into a reply; the card shows a refusal where it happened. */
export function useDecisionActions(environmentId: EnvironmentId) {
  const canAct = useAtomValue(decisionsEnvironment.answer.permissionAtom(environmentId));
  const answer = useAtomCommand(decisionsEnvironment.answer, { reportFailure: true });
  const dismiss = useAtomCommand(decisionsEnvironment.dismiss, { reportFailure: true });
  const reply = (result: Awaited<ReturnType<typeof answer>>): DecisionReply =>
    result._tag === "Success"
      ? { ok: true }
      : { ok: false, message: decisionErrorMessage(squashAtomCommandFailure(result)) };
  return {
    canAct,
    answer: async (decisionId: DecisionId, input: { optionId?: string; text?: string }) =>
      reply(await answer({ environmentId, input: { decisionId, ...input } })),
    dismiss: async (decisionId: DecisionId) =>
      reply(await dismiss({ environmentId, input: { decisionId } })),
  };
}
