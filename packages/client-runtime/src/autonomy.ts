import {
  AUTONOMY_WATCH_INSTRUCTION_MAX_LENGTH,
  type AssistantAutonomy,
  type AutonomyChannel,
  type AutonomyRule,
  type AutonomySettings,
  type AutonomyWatch,
  type AutonomyWatchEvent,
  type AutonomyWatchUpsertInput,
  type ProjectId,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";

import { squashAtomCommandFailure } from "./state/runtime.ts";

export const AUTONOMY_MINUTES_BOUNDS = { min: 1, max: 24 * 60 } as const;
export const AUTONOMY_WAKES_BOUNDS = { min: 1, max: 1000 } as const;
export const AUTONOMY_NOTIFY_AFTER_BOUNDS = { min: 0, max: 60 } as const;
export const AUTONOMY_USER_MESSAGES_BOUNDS = { min: 1, max: 1000 } as const;

export const AUTONOMY_RULE_OPTIONS: ReadonlyArray<{
  readonly rule: AutonomyRule;
  readonly label: string;
  readonly description: string;
}> = [
  {
    rule: "runFailed",
    label: "Run failed or was interrupted",
    description: "A run ended with an error or was stopped before it finished.",
  },
  {
    rule: "waitingTooLong",
    label: "Waiting for you too long",
    description: "A run is blocked on your answer or approval.",
  },
  {
    rule: "stuck",
    label: "Run looks stuck",
    description: "A run has shown no activity for a while.",
  },
  {
    rule: "ciFailed",
    label: "PR checks failed",
    description: "Checks failed on a pull request you follow.",
  },
  {
    rule: "reviewIncomplete",
    label: "Card in Review with open items",
    description: "A card reached Review with checklist items still unchecked.",
  },
];

export const AUTONOMY_CHANNEL_LABELS: Record<AutonomyChannel, string> = {
  telegram: "Telegram",
  t3: "T3 Activity",
};

export const AUTONOMY_WATCH_EVENT_LABELS: Record<AutonomyWatchEvent, string> = {
  run_finished: "A run finishes",
  run_failed: "A run fails",
  pr_checks_passed: "PR checks pass",
  pr_checks_failed: "PR checks fail",
  card_moved: "A kanban card moves",
};

export const AUTONOMY_WATCH_PR_EVENTS: ReadonlyArray<AutonomyWatchEvent> = [
  "pr_checks_passed",
  "pr_checks_failed",
];

/** Adds or removes one value, keeping the canonical order of `all`. */
export function toggleInList<T>(
  all: ReadonlyArray<T>,
  current: ReadonlyArray<T>,
  value: T,
  on: boolean,
): ReadonlyArray<T> {
  return all.filter((item) => (item === value ? on : current.includes(item)));
}

export function parseBoundedInt(
  text: string,
  bounds: { readonly min: number; readonly max: number },
): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= bounds.min && value <= bounds.max ? value : null;
}

export type AutonomySettingsPatch = { readonly autonomy: AutonomySettings };

export function withAutonomyRule(
  settings: AutonomySettings,
  rule: AutonomyRule,
  on: boolean,
): AutonomySettings {
  return { ...settings, rules: { ...settings.rules, [rule]: on } };
}

export function withAutonomyChannel(
  settings: AutonomySettings,
  channel: AutonomyChannel,
  on: boolean,
): AutonomySettings {
  return {
    ...settings,
    channels: toggleInList(
      Object.keys(AUTONOMY_CHANNEL_LABELS) as AutonomyChannel[],
      settings.channels,
      channel,
      on,
    ),
  };
}

export interface AutonomyWatchDraft {
  readonly id: AutonomyWatch["id"] | null;
  readonly title: string;
  readonly event: AutonomyWatchEvent;
  readonly projectId: ProjectId | null;
  readonly prNumber: string;
  readonly instruction: string;
  readonly oneShot: boolean;
  /** `YYYY-MM-DDTHH:mm` in local time, or empty. */
  readonly expiresAt: string;
}

export const EMPTY_WATCH_DRAFT: AutonomyWatchDraft = {
  id: null,
  title: "",
  event: "pr_checks_failed",
  projectId: null,
  prNumber: "",
  instruction: "",
  oneShot: false,
  expiresAt: "",
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `YYYY-MM-DDTHH:mm` in local time, the shape a watch draft keeps its expiry in. */
export function localDateTimeString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function watchDraftFromWatch(watch: AutonomyWatch): AutonomyWatchDraft {
  return {
    id: watch.id,
    title: watch.title,
    event: watch.filter.event,
    projectId: watch.filter.projectId ?? null,
    prNumber: watch.filter.prNumber === undefined ? "" : String(watch.filter.prNumber),
    instruction: watch.instruction,
    oneShot: watch.oneShot,
    // @effect-diagnostics-next-line globalDate:off
    expiresAt: watch.expiresAt === null ? "" : localDateTimeString(new Date(watch.expiresAt)),
  };
}

export type WatchReply = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** A watch change's result as a reply the form can show where it happened. */
export function watchReply(
  result:
    | { readonly _tag: "Success" }
    | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> },
): WatchReply {
  if (result._tag === "Success") return { ok: true };
  const error = squashAtomCommandFailure(result);
  return {
    ok: false,
    message: error instanceof Error ? error.message : "The request failed. Try again.",
  };
}

export type AutonomyWatchInputResult =
  | { readonly ok: true; readonly input: AutonomyWatchUpsertInput }
  | { readonly ok: false; readonly message: string };

export function watchInputFromDraft(
  assistantId: string,
  draft: AutonomyWatchDraft,
): AutonomyWatchInputResult {
  const title = draft.title.trim();
  if (title === "") return { ok: false, message: "Give the watch a title." };
  if (title.length > 120) return { ok: false, message: "The title is at most 120 characters." };
  if (draft.instruction.length > AUTONOMY_WATCH_INSTRUCTION_MAX_LENGTH) {
    return {
      ok: false,
      message: `The instruction is at most ${AUTONOMY_WATCH_INSTRUCTION_MAX_LENGTH} characters.`,
    };
  }
  const usesPr = AUTONOMY_WATCH_PR_EVENTS.includes(draft.event);
  const prText = usesPr ? draft.prNumber.trim() : "";
  const prNumber = prText === "" ? null : parseBoundedInt(prText, { min: 1, max: 2 ** 31 - 1 });
  if (prText !== "" && prNumber === null) {
    return { ok: false, message: "The PR number must be a positive whole number." };
  }
  let expiresAt: string | null = null;
  if (draft.expiresAt !== "") {
    // @effect-diagnostics-next-line globalDate:off
    const date = new Date(draft.expiresAt);
    if (Number.isNaN(date.getTime())) return { ok: false, message: "The expiry is not a date." };
    expiresAt = date.toISOString();
  }
  return {
    ok: true,
    input: {
      ...(draft.id ? { id: draft.id } : {}),
      assistantId,
      title,
      filter: {
        event: draft.event,
        ...(draft.projectId ? { projectId: draft.projectId } : {}),
        ...(prNumber === null ? {} : { prNumber }),
      },
      instruction: draft.instruction,
      oneShot: draft.oneShot,
      expiresAt,
    },
  };
}

/** "PR checks fail · Acme · PR #42". */
export function watchSummary(
  watch: Pick<AutonomyWatch, "filter">,
  projectTitle: (projectId: ProjectId) => string | null,
): string {
  const { event, projectId, prNumber } = watch.filter;
  return [
    AUTONOMY_WATCH_EVENT_LABELS[event],
    projectId === undefined ? null : projectTitle(projectId),
    prNumber === undefined ? null : `PR #${prNumber}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function sameAssistantAutonomy(a: AssistantAutonomy, b: AssistantAutonomy): boolean {
  const same = (x: ReadonlyArray<string> | null, y: ReadonlyArray<string> | null) =>
    x === null || y === null ? x === y : x.length === y.length && x.every((v) => y.includes(v));
  return (
    a.mode === b.mode &&
    same(a.rules, b.rules) &&
    same(a.projectIds, b.projectIds) &&
    same(a.channels, b.channels)
  );
}
