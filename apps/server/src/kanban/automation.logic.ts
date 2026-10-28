import type { KanbanAutomations, KanbanColumn, KanbanColumnRole } from "@t3tools/contracts";

export type KanbanAutomationTrigger = "thread-started" | "run-completed" | "pr-merged";

const TARGET_ROLE = {
  "thread-started": "in-progress",
  "run-completed": "review",
  "pr-merged": "done",
} as const satisfies Record<KanbanAutomationTrigger, KanbanColumnRole>;

const FLAG = {
  "thread-started": "threadStarted",
  "run-completed": "runCompleted",
  "pr-merged": "prMerged",
} as const satisfies Record<KanbanAutomationTrigger, keyof KanbanAutomations>;

/** Forward order of the roles automation moves along; "none" columns have no place in it. */
const ROLE_RANK: Partial<Record<KanbanColumnRole, number>> = {
  backlog: 0,
  todo: 1,
  "in-progress": 2,
  review: 3,
  done: 4,
};

export type KanbanAutomationDecision =
  | { readonly type: "skip"; readonly reason: string }
  | {
      readonly type: "move";
      readonly columnId: KanbanColumn["id"];
      /** Moves into review go through the definition of done; a merged pull request does not. */
      readonly checkDefinitionOfDone: boolean;
    };

const skip = (reason: string): KanbanAutomationDecision => ({ type: "skip", reason });

/**
 * Never moves archived cards, backwards, or out of a column without a role (the user parked
 * the card there on purpose), and never targets a role the board has no column for.
 */
export function decideKanbanAutomation(
  trigger: KanbanAutomationTrigger,
  card: { readonly columnId: string; readonly archivedAt: string | null },
  board: {
    readonly columns: ReadonlyArray<Pick<KanbanColumn, "id" | "role">>;
    readonly automations: KanbanAutomations;
  },
): KanbanAutomationDecision {
  if (!board.automations[FLAG[trigger]]) return skip("automation off");
  if (card.archivedAt !== null) return skip("card archived");
  const targetRole = TARGET_ROLE[trigger];
  const target = board.columns.find((column) => column.role === targetRole);
  if (target === undefined) return skip(`no ${targetRole} column`);
  const current = board.columns.find((column) => column.id === card.columnId);
  const currentRank = current === undefined ? undefined : ROLE_RANK[current.role];
  if (currentRank === undefined) return skip("card is in a column without a role");
  if (currentRank >= ROLE_RANK[targetRole]!) return skip("card is already there or further");
  return { type: "move", columnId: target.id, checkDefinitionOfDone: trigger === "run-completed" };
}

export interface ThreadAutomationFacts {
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly status: string;
  }>;
  readonly pullRequests: ReadonlyArray<{ readonly key: string; readonly state: string | null }>;
}

export interface TriggerWithKey {
  readonly trigger: KanbanAutomationTrigger;
  /** What the trigger fired for; part of the command id so live events and sweeps coincide. */
  readonly key: string;
}

/** Triggers a thread's current state implies, in the order they apply. */
export function triggersForThread(facts: ThreadAutomationFacts): ReadonlyArray<TriggerWithKey> {
  const newest = (runs: ThreadAutomationFacts["runs"]) =>
    runs.reduce<(typeof runs)[number] | undefined>(
      (best, run) => (best === undefined || run.ordinal > best.ordinal ? run : best),
      undefined,
    );
  const triggers: TriggerWithKey[] = [];
  // A run still preparing or queued has not started the agent yet.
  const began = newest(
    facts.runs.filter((run) => run.status !== "preparing" && run.status !== "queued"),
  );
  if (began !== undefined) triggers.push({ trigger: "thread-started", key: began.id });
  // Failed, cancelled and interrupted runs are not completed work, so they leave the card be.
  const latest = newest(facts.runs);
  if (latest?.status === "completed") triggers.push({ trigger: "run-completed", key: latest.id });
  const merged = facts.pullRequests.filter((pr) => pr.state === "merged").map((pr) => pr.key);
  if (merged.length > 0) triggers.push({ trigger: "pr-merged", key: [...merged].sort()[0]! });
  return triggers;
}

/** The triggers one run event implies. */
export function triggersForRun(run: {
  readonly id: string;
  readonly status: string;
}): ReadonlyArray<TriggerWithKey> {
  return triggersForThread({
    runs: [{ id: run.id, ordinal: 1, status: run.status }],
    pullRequests: [],
  });
}
