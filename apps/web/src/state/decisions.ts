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
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { environmentServerConfigsAtom } from "./server";
import { useEnvironmentsWithScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

const decisionsEnvironment = createDecisionsEnvironmentAtoms(connectionAtomRuntime);

const decisionsLiveListAtom = environmentAtomList("web-decisions-live", (environmentId) =>
  decisionsEnvironment.live({ environmentId, input: null }),
);

const decisionsEnvironmentIdsAtom = Atom.make((get) => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.decisions === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("web-decisions-environment-ids"));

/** Connected environments whose server has decisions and whose session can read them. */
function useDecisionsEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const supported = useAtomValue(decisionsEnvironmentIdsAtom);
  const readable = useEnvironmentsWithScope(
    supported.map((environmentId) => ({ environmentId })),
    AuthOrchestrationReadScope,
  );
  return supported.filter((id) => readable.has(id));
}

const decisionStatesAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const ids = key === "" ? [] : (key.split("\n") as EnvironmentId[]);
    return get(decisionsLiveListAtom(key)).flatMap((result, index) => {
      const state = Option.getOrNull(AsyncResult.value(result));
      return state === null ? [] : [[ids[index]!, state] as const];
    }) satisfies ReadonlyArray<readonly [EnvironmentId, DecisionsState]>;
  }).pipe(Atom.withLabel(`web-decisions-states:${key}`)),
);

const decisionEntriesAtom = Atom.family((key: string) =>
  Atom.make((get) => collectDecisionEntries(get(decisionStatesAtom(key)))).pipe(
    Atom.withLabel(`web-decision-entries:${key}`),
  ),
);

const openDecisionThreadKeysAtom = Atom.family((key: string) =>
  Atom.make((get) => openDecisionThreadKeys(get(decisionStatesAtom(key)))).pipe(
    Atom.withLabel(`web-open-decision-thread-keys:${key}`),
  ),
);

/** Open decisions by urgency and recent settled ones, across the environments that have them. */
export function useDecisionEntries() {
  return useAtomValue(decisionEntriesAtom(environmentIdsKey(useDecisionsEnvironmentIds())));
}

/** Scoped thread keys with an open decision, for attention and Activity ranking. */
export function useOpenDecisionThreadKeys(): ReadonlySet<string> {
  return useAtomValue(openDecisionThreadKeysAtom(environmentIdsKey(useDecisionsEnvironmentIds())));
}

/** The thread's open decisions, most urgent first. */
export function useThreadOpenDecisions(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<DecisionEntry> {
  return useDecisionEntries().open.filter(
    (entry) => entry.environmentId === environmentId && entry.decision.fromThreadId === threadId,
  );
}

export function useHasOpenDecision(environmentId: EnvironmentId, threadId: ThreadId): boolean {
  return useOpenDecisionThreadKeys().has(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
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
