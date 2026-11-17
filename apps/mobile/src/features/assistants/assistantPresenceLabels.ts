import {
  assistantQueuedLabel,
  type AssistantMood,
  type AssistantPresence,
} from "@t3tools/client-runtime/assistantRobot";

import { relativeTime } from "../../lib/time";

/** A translucent wash of the assistant's accent, for its message bubble and border. */
export function accentWash(accent: string, alpha: number): string {
  return `${accent}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

/** The line beside an assistant's name: its role, access level and whether it asks first. */
export function presenceBadgeLabel(access: string | null, asksFirst: boolean, role?: string) {
  return [
    role || "assistant",
    ...(access ? [access] : []),
    ...(asksFirst ? ["asks first"] : []),
  ].join(" · ");
}

/** Text color of a status line: what it is doing, in the theme's own tokens. */
export function moodTextClass(mood: AssistantMood, sidebar = false): string {
  switch (mood) {
    case "working":
      return "text-adaptive-sky-600-400";
    case "needs":
    case "limited":
      return "text-warning-foreground";
    case "failed":
      return "text-danger-foreground";
    case "idle":
      return sidebar ? "text-drawer-foreground-muted" : "text-foreground-tertiary";
  }
}

/** "Working in Leadership · 3m ago · 2 queued": the one status line a card or info hero shows. */
export function assistantStatusText(presence: AssistantPresence, nowMs: number): string {
  return [
    presence.detail,
    presence.since === null ? null : relativeTime(presence.since, nowMs),
    assistantQueuedLabel(presence.queued),
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
