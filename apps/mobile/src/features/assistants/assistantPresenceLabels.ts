import type { AssistantSender } from "@t3tools/client-runtime/assistantPresence";
import type { AssistantMood } from "@t3tools/client-runtime/assistantRobot";

export const PRESENCE_STACK_LIMIT = 3;

/** The avatars the header stack draws, and how many more assistants hide behind "+N". */
export function splitPresenceStack<T>(senders: ReadonlyArray<T>) {
  return {
    shown: senders.slice(0, PRESENCE_STACK_LIMIT),
    hidden: Math.max(0, senders.length - PRESENCE_STACK_LIMIT),
  };
}

/** A translucent wash of the assistant's accent, for its message bubble and border. */
export function accentWash(accent: string, alpha: number): string {
  return `${accent}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

export function presenceStatusLabel(working: boolean) {
  return working ? "Working" : "Idle";
}

export function presenceMessageCount(sender: Pick<AssistantSender, "count">) {
  return `${sender.count} message${sender.count === 1 ? "" : "s"} here`;
}

/** The small chip beside an assistant's name: its role here, access level and whether it asks first. */
export function presenceBadgeLabel(access: string | null, asksFirst: boolean) {
  return ["assistant", ...(access ? [access] : []), ...(asksFirst ? ["asks first"] : [])].join(
    " · ",
  );
}

/** Text color of a status line: what it is doing, in the theme's own tokens. */
export function moodTextClass(mood: AssistantMood, sidebar = false): string {
  switch (mood) {
    case "working":
      return "text-adaptive-sky-600-400";
    case "needs":
      return "text-warning-foreground";
    case "failed":
      return "text-danger-foreground";
    case "idle":
      return sidebar ? "text-drawer-foreground-muted" : "text-foreground-tertiary";
  }
}
