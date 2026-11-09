import {
  type Assistant,
  assistantIdFromThreadId,
  isAssistantGroupThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { resolveSidebarThreadStatus } from "./state/threadAttention.ts";
import type { EnvironmentThreadShell } from "./state/models.ts";

/** What the robot's face shows; it follows the assistant's thread. */
export type AssistantMood = "idle" | "working" | "needs" | "failed";

/** What the robot draws: the mood plus finer states derived from the same thread. */
export type AssistantFace =
  | "idle"
  | "reading"
  | "working"
  | "waiting"
  | "failed"
  | "done"
  | "sleeping";

/** How long "done" shows after the assistant's last reply, and how long idle before it sleeps. */
export const ASSISTANT_DONE_MS = 8_000;
const ASSISTANT_SLEEP_MS = 6 * 60 * 60 * 1000;

/** Moods map to faces one to one, "needs" being the face that waits on the user. */
export const faceOfMood = (face: AssistantMood | AssistantFace): AssistantFace =>
  face === "needs" ? "waiting" : face;

/**
 * `now` decides done (just replied) and sleeping (quiet for hours); without it the face is
 * time-free, which is what rows that never re-render on a clock should use.
 */
export function assistantFace(
  presence: Pick<AssistantPresence, "mood" | "reading" | "since">,
  now?: number,
): AssistantFace {
  if (presence.mood === "working") return presence.reading ? "reading" : "working";
  if (presence.mood !== "idle") return faceOfMood(presence.mood);
  if (now === undefined) return "idle";
  const age = presence.since === null ? Number.NaN : now - Date.parse(presence.since);
  if (Number.isNaN(age)) return "idle";
  if (age >= 0 && age <= ASSISTANT_DONE_MS) return "done";
  return age > ASSISTANT_SLEEP_MS ? "sleeping" : "idle";
}

export interface AssistantRobotLook {
  readonly hue: number;
  readonly variant: number;
}

/**
 * Everything a client needs to draw the robot on a 72×72 canvas, as data: web renders it with SVG
 * and mobile with react-native-svg, so both stay identical.
 */
export interface AssistantRobotSpec {
  readonly gradientFrom: string;
  readonly gradientTo: string;
  readonly visor: string;
  readonly eyes: "open" | "focused" | "alert" | "crossed" | "closed" | "happy";
  /** The one sparse motion this face may play; clients animate it only where it is big enough. */
  readonly motion: "blink" | "glance" | "think" | null;
  /** Amber dot for waiting, red ring for failed. */
  readonly badge: { readonly kind: "dot" | "ring"; readonly color: string } | null;
  readonly eyeColor: string;
  readonly tipColor: string;
  readonly antenna: "single" | "double" | "none" | "ring";
  readonly ears: boolean;
  /** The drawing's own light parts: shine, stems, ears and mouth read the same on every theme. */
  readonly light: string;
}

const ASSISTANT_ROBOT_VARIANTS = 8;
/** Hues offered in the picker: spread so neighbours never read as the same color. */
export const ASSISTANT_ROBOT_HUES = [210, 30, 150, 280, 340, 95, 190, 5] as const;

const ANTENNAS = ["single", "double", "none", "ring"] as const;

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/** What a new assistant starts with: the Nth one differs from the ones before it, stably. */
export const newAssistantLook = (index: number): AssistantRobotLook => ({
  hue: ASSISTANT_ROBOT_HUES[index % ASSISTANT_ROBOT_HUES.length]!,
  variant: (index * 3) % ASSISTANT_ROBOT_VARIANTS,
});

/** The robot an assistant wears: its own pick, or one derived from its id so it never changes. */
export function assistantRobotLook(assistant: {
  readonly id: string;
  readonly avatar: Assistant["avatar"];
}): AssistantRobotLook {
  if (assistant.avatar?.kind === "robot") {
    return { hue: assistant.avatar.hue, variant: assistant.avatar.variant ?? 0 };
  }
  const hash = hashString(assistant.id);
  return {
    hue: ASSISTANT_ROBOT_HUES[hash % ASSISTANT_ROBOT_HUES.length]!,
    variant: (hash >>> 8) % ASSISTANT_ROBOT_VARIANTS,
  };
}

export function assistantRobotSpec(
  look: AssistantRobotLook,
  mood: AssistantMood | AssistantFace,
): AssistantRobotSpec {
  const hue = ((Math.round(look.hue) % 360) + 360) % 360;
  const variant =
    ((Math.round(look.variant) % ASSISTANT_ROBOT_VARIANTS) + ASSISTANT_ROBOT_VARIANTS) %
    ASSISTANT_ROBOT_VARIANTS;
  const face = {
    idle: { eyes: "open", motion: "blink", eyeColor: "#d6f3ff", tipColor: `hsl(${hue} 90% 80%)` },
    reading: {
      eyes: "open",
      motion: "glance",
      eyeColor: "#d6f3ff",
      tipColor: `hsl(${hue} 90% 80%)`,
    },
    working: { eyes: "focused", motion: "think", eyeColor: "#8fe3ff", tipColor: "#8fe3ff" },
    waiting: { eyes: "alert", motion: null, eyeColor: "#ffd28a", tipColor: "#ffb454" },
    failed: { eyes: "crossed", motion: null, eyeColor: "#ff8a8a", tipColor: "#ff6b6b" },
    done: { eyes: "happy", motion: null, eyeColor: "#b8f5c8", tipColor: "#7ee2a0" },
    sleeping: { eyes: "closed", motion: null, eyeColor: "#9aa8c4", tipColor: "#9aa8c4" },
  } as const satisfies Record<
    AssistantFace,
    Pick<AssistantRobotSpec, "eyes" | "motion" | "eyeColor" | "tipColor">
  >;
  const key = faceOfMood(mood);
  return {
    gradientFrom: `hsl(${hue} 85% 66%)`,
    gradientTo: `hsl(${(hue + 40) % 360} 80% 46%)`,
    visor: "hsl(230 30% 12%)",
    ...face[key],
    badge:
      key === "waiting"
        ? { kind: "dot", color: "#ffb454" }
        : key === "failed"
          ? { kind: "ring", color: "#ff6b6b" }
          : null,
    antenna: ANTENNAS[variant % ANTENNAS.length]!,
    ears: variant >= ANTENNAS.length,
    light: "#ffffff",
  };
}

type PresenceThread = Pick<
  EnvironmentThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "queuedMessageCount"
  | "runtime"
  | "blockedOnThreadWait"
  | "latestRun"
> & {
  readonly source: Pick<EnvironmentThreadShell["source"], "latestVisibleMessage">;
};

export interface AssistantPresence {
  readonly mood: AssistantMood;
  /** One line for a row: what it is doing, what it needs, or when it last spoke. */
  readonly detail: string;
  /** When the detail's moment happened, for "12m ago" style labels; null when there is none. */
  readonly since: string | null;
  /** Working but nothing said yet: it is still reading the request. */
  readonly reading: boolean;
  /** Messages waiting behind its active run. */
  readonly queued: number;
}

/** "3 queued" beside the status; null when nothing waits. */
export const assistantQueuedLabel = (queued: number): string | null =>
  queued > 0 ? `${queued} queued` : null;

const PREVIEW_LENGTH = 80;

function firstLine(text: string): string {
  const line =
    text
      .trim()
      .split("\n")
      .find((candidate) => candidate.trim() !== "")
      ?.trim() ?? "";
  return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH - 1)}…` : line;
}

type GroupPresenceThread = PresenceThread & { readonly title: string };

/**
 * Mood and status line of an assistant from its thread; no thread yet means idle. When its own
 * conversation is idle, work in one of its group threads shows instead ("Working in Leadership").
 */
export function assistantPresence(
  thread: PresenceThread | null,
  groupThreads: ReadonlyArray<GroupPresenceThread> = [],
): AssistantPresence {
  const own = { ...presenceOf(thread), queued: thread?.queuedMessageCount ?? 0 };
  if (own.mood !== "idle") return own;
  for (const group of groupThreads) {
    const presence = presenceOf(group);
    // A failed group task shows on its card in the chat; the assistant itself is free.
    if (presence.mood === "idle" || presence.mood === "failed") continue;
    const where = group.title.split(" · ").at(-1) ?? "a group";
    return {
      ...own,
      mood: presence.mood,
      detail:
        presence.mood === "working" ? `Working in ${where}` : `${presence.detail} in ${where}`,
      since: presence.since,
      reading: presence.reading,
    };
  }
  return own;
}

/** The `assistantEntryKey` of the member a group thread belongs to; undefined for other threads. */
export function assistantGroupOwnerKey(shell: {
  readonly environmentId: string;
  readonly id: string;
}): string | undefined {
  if (!isAssistantGroupThreadId(shell.id)) return undefined;
  const assistantId = assistantIdFromThreadId(shell.id);
  return assistantId === null ? undefined : `${shell.environmentId}:${assistantId}`;
}

/** The assistant's hidden threads for its groups, out of every thread shell. */
export function assistantGroupThreadsOf<
  S extends { readonly environmentId: string; readonly id: string },
>(shells: ReadonlyArray<S>, environmentId: string, assistantId: string): ReadonlyArray<S> {
  const prefix = `assistant:${assistantId}:`;
  return shells.filter(
    (shell) =>
      shell.environmentId === environmentId &&
      shell.id.startsWith(prefix) &&
      isAssistantGroupThreadId(shell.id),
  );
}

function presenceOf(thread: PresenceThread | null): Omit<AssistantPresence, "queued"> {
  if (thread === null) return { mood: "idle", detail: "Idle", since: null, reading: false };
  const status = resolveSidebarThreadStatus(thread);
  const message = thread.source.latestVisibleMessage;
  const said = message !== null && message.role === "assistant" ? firstLine(message.text) : "";
  const spokeAt = message === null ? null : DateTime.formatIso(message.updatedAt);
  switch (status) {
    case "approval":
      return { mood: "needs", detail: "Needs your approval", since: null, reading: false };
    case "input":
      return { mood: "needs", detail: "Asked you a question", since: null, reading: false };
    case "request":
      return {
        mood: "needs",
        detail: "A guest message waits for you",
        since: null,
        reading: false,
      };
    case "working":
    case "waiting":
      return {
        mood: "working",
        reading: message === null || message.role === "user",
        detail: said === "" ? "Working" : said,
        since: thread.runtime?.activityStartedAt ?? thread.latestRun?.startedAt ?? null,
      };
    case "failed":
      return {
        mood: "failed",
        reading: false,
        detail: "Last run failed",
        since: thread.latestRun?.completedAt ?? null,
      };
    case "limited":
      return { mood: "failed", detail: "Hit a usage limit", since: null, reading: false };
    case "ready":
      return { mood: "idle", detail: said === "" ? "Idle" : said, since: spokeAt, reading: false };
  }
}
