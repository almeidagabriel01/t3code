import type {
  AssistantAutonomy,
  AutonomyChannel,
  AutonomyRule,
  AutonomySettings,
  AutonomyWatch,
} from "@t3tools/contracts";

import { DECISION_PHRASES } from "../channels/channelStrings.ts";

/** What the server saw. Pure data, so rules and watches are tested without a running server. */
export interface AutonomySignal {
  readonly event:
    | "run_failed"
    | "run_finished"
    | "pr_checks_failed"
    | "pr_checks_passed"
    | "card_moved"
    | "review_incomplete"
    | "waiting"
    | "stuck";
  /** Stable per (run or thread, event): the same occurrence always yields the same key. */
  readonly key: string;
  readonly threadId: string | null;
  /** What rule spacing groups by when there is no thread, such as a card id. */
  readonly subject?: string;
  readonly projectId: string | null;
  readonly prNumber: number | null;
  /** One line naming what happened, shown to the assistant and the user. */
  readonly summary: string;
}

const RULE_OF_EVENT: Partial<Record<AutonomySignal["event"], AutonomyRule>> = {
  run_failed: "runFailed",
  pr_checks_failed: "ciFailed",
  waiting: "waitingTooLong",
  stuck: "stuck",
  review_incomplete: "reviewIncomplete",
};

const ruleOfSignal = (signal: AutonomySignal): AutonomyRule | undefined =>
  RULE_OF_EVENT[signal.event];

/** The most specific setting wins: an assistant's explicit list replaces the global toggles. */
export function ruleEnabled(
  rule: AutonomyRule,
  autonomy: AssistantAutonomy,
  settings: AutonomySettings,
): boolean {
  return autonomy.rules === null ? settings.rules[rule] : autonomy.rules.includes(rule);
}

export function resolveChannels(
  autonomy: AssistantAutonomy,
  settings: AutonomySettings,
): ReadonlyArray<AutonomyChannel> {
  return autonomy.channels ?? settings.channels;
}

function inProjectScope(autonomy: AssistantAutonomy, projectId: string | null): boolean {
  return (
    autonomy.projectIds === null ||
    (projectId !== null && autonomy.projectIds.includes(projectId as never))
  );
}

export function watchMatches(watch: AutonomyWatch, signal: AutonomySignal, nowMs: number): boolean {
  const { filter } = watch;
  if (!watch.enabled || filter.event !== signal.event) return false;
  if (watch.expiresAt !== null && Date.parse(watch.expiresAt) <= nowMs) return false;
  return (
    (filter.projectId === undefined || filter.projectId === signal.projectId) &&
    (filter.threadId === undefined || filter.threadId === signal.threadId) &&
    (filter.prNumber === undefined || filter.prNumber === signal.prNumber)
  );
}

export interface AutonomyCandidate {
  readonly assistantId: string;
  /** The rule name or the watch id. */
  readonly source: { readonly rule: AutonomyRule } | { readonly watch: AutonomyWatch };
}

/** Who this signal wakes. Only assistants in reply-and-notify mode ever wake. */
export function candidatesFor(input: {
  readonly signal: AutonomySignal;
  readonly assistants: ReadonlyArray<{ readonly id: string; readonly autonomy: AssistantAutonomy }>;
  readonly watches: ReadonlyArray<AutonomyWatch>;
  readonly settings: AutonomySettings;
  readonly nowMs: number;
}): ReadonlyArray<AutonomyCandidate> {
  const { signal, settings } = input;
  const awake = new Map(
    input.assistants
      .filter(({ autonomy }) => autonomy.mode === "reply-and-notify")
      .map((assistant) => [assistant.id, assistant.autonomy] as const),
  );
  const rule = ruleOfSignal(signal);
  const byRule: AutonomyCandidate[] =
    rule === undefined
      ? []
      : [...awake]
          .filter(
            ([, autonomy]) =>
              inProjectScope(autonomy, signal.projectId) && ruleEnabled(rule, autonomy, settings),
          )
          .map(([assistantId]) => ({ assistantId, source: { rule } }));
  const byWatch = input.watches
    .filter((watch) => awake.has(watch.assistantId) && watchMatches(watch, signal, input.nowMs))
    .map((watch) => ({ assistantId: watch.assistantId, source: { watch } }));
  return [...byRule, ...byWatch];
}

const RULE_LABELS: Record<AutonomyRule, string> = {
  runFailed: DECISION_PHRASES.runFailed,
  waitingTooLong: DECISION_PHRASES.waitingTooLong,
  stuck: DECISION_PHRASES.stuck,
  ciFailed: DECISION_PHRASES.ciFailed,
  reviewIncomplete: DECISION_PHRASES.reviewIncomplete,
};

export const sourceLabel = (source: AutonomyCandidate["source"]): string =>
  "rule" in source ? RULE_LABELS[source.rule] : `${DECISION_PHRASES.watch} ${source.watch.title}`;

export const WAKE_MESSAGE_PREFIX = "autonomy-wake:";

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`);

export interface WakeContext {
  readonly threadTitle: string | null;
  readonly threadLink: string | null;
  readonly projectName: string | null;
  readonly lastAssistantMessage: string | null;
  readonly diffStat: string | null;
}

/** The compact message the assistant wakes on. */
export function wakeMessage(
  signal: AutonomySignal,
  source: AutonomyCandidate["source"],
  context: WakeContext,
): string {
  const lines = [
    `[Autonomy] ${sourceLabel(source)}`,
    signal.summary,
    ...(context.threadTitle === null
      ? []
      : [`Thread: ${context.threadLink ?? context.threadTitle}`]),
    ...(context.projectName === null ? [] : [`Project: ${context.projectName}`]),
    ...(context.diffStat === null ? [] : [`Diff: ${context.diffStat}`]),
    ...(context.lastAssistantMessage === null
      ? []
      : [`Last assistant message:\n${clip(context.lastAssistantMessage.trim(), 600)}`]),
    "watch" in source && source.watch.instruction.trim() !== ""
      ? `Instruction from the user: ${source.watch.instruction.trim()}`
      : "",
    "Investigate and tell the user what you found. Do not change anything.",
  ];
  return lines.filter((line) => line !== "").join("\n");
}
