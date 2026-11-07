import type { Assistant } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { resolveSidebarThreadStatus } from "./state/threadAttention.ts";
import type { EnvironmentThreadShell } from "./state/models.ts";

/** What the robot's face shows; it follows the assistant's thread. */
export type AssistantMood = "idle" | "working" | "needs" | "failed";

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
  readonly eyes: "open" | "focused" | "alert" | "crossed";
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
  mood: AssistantMood,
): AssistantRobotSpec {
  const hue = ((Math.round(look.hue) % 360) + 360) % 360;
  const variant =
    ((Math.round(look.variant) % ASSISTANT_ROBOT_VARIANTS) + ASSISTANT_ROBOT_VARIANTS) %
    ASSISTANT_ROBOT_VARIANTS;
  const face = {
    idle: { eyes: "open", eyeColor: "#d6f3ff", tipColor: `hsl(${hue} 90% 80%)` },
    working: { eyes: "focused", eyeColor: "#8fe3ff", tipColor: "#8fe3ff" },
    needs: { eyes: "alert", eyeColor: "#ffd28a", tipColor: "#ffb454" },
    failed: { eyes: "crossed", eyeColor: "#ff8a8a", tipColor: "#ff6b6b" },
  } as const satisfies Record<
    AssistantMood,
    Pick<AssistantRobotSpec, "eyes" | "eyeColor" | "tipColor">
  >;
  return {
    gradientFrom: `hsl(${hue} 85% 66%)`,
    gradientTo: `hsl(${(hue + 40) % 360} 80% 46%)`,
    visor: "hsl(230 30% 12%)",
    ...face[mood],
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

/** Mood and status line of an assistant from its thread; no thread yet means idle. */
export function assistantPresence(thread: PresenceThread | null): AssistantPresence {
  return { ...presenceOf(thread), queued: thread?.queuedMessageCount ?? 0 };
}

function presenceOf(thread: PresenceThread | null): Omit<AssistantPresence, "queued"> {
  if (thread === null) return { mood: "idle", detail: "Idle", since: null };
  const status = resolveSidebarThreadStatus(thread);
  const message = thread.source.latestVisibleMessage;
  const said = message !== null && message.role === "assistant" ? firstLine(message.text) : "";
  const spokeAt = message === null ? null : DateTime.formatIso(message.updatedAt);
  switch (status) {
    case "approval":
      return { mood: "needs", detail: "Needs your approval", since: null };
    case "input":
      return { mood: "needs", detail: "Asked you a question", since: null };
    case "request":
      return { mood: "needs", detail: "A guest message waits for you", since: null };
    case "working":
    case "waiting":
      return {
        mood: "working",
        detail: said === "" ? "Working" : said,
        since: thread.runtime?.activityStartedAt ?? thread.latestRun?.startedAt ?? null,
      };
    case "failed":
      return {
        mood: "failed",
        detail: "Last run failed",
        since: thread.latestRun?.completedAt ?? null,
      };
    case "limited":
      return { mood: "failed", detail: "Hit a usage limit", since: null };
    case "ready":
      return { mood: "idle", detail: said === "" ? "Idle" : said, since: spokeAt };
  }
}
