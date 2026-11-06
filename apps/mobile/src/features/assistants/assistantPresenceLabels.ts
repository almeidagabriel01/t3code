import type { AssistantSender } from "@t3tools/client-runtime/assistantPresence";

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
