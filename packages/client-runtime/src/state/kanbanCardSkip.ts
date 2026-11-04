import { Atom } from "effect/reactivity";

import { shouldDeliverKanbanCard } from "./kanbanLogic.ts";

/** Set when the user removes the card chip from the next message; the send consumes it. */
export const kanbanCardSkipAtom = Atom.family((threadKey: string) =>
  Atom.make(false).pipe(Atom.keepAlive, Atom.withLabel(`kanban-card-skip:${threadKey}`)),
);

export function kanbanCardSkipKey(environmentId: string, threadId: string): string {
  return `${environmentId}\n${threadId}`;
}

/** Whether to attach the card to this send, and the flag value to leave behind. */
export function consumeKanbanCardSkip(skipped: boolean): { attach: boolean; skipped: false } {
  return { attach: !skipped, skipped: false };
}

/** What the composer shows for a thread's linked card: nothing once delivered, else the chip or its removed form. */
export function composerKanbanCardChipState(
  cardId: string | null,
  messages: Parameters<typeof shouldDeliverKanbanCard>[1] | null,
  skipped: boolean,
): "hidden" | "attached" | "skipped" {
  if (cardId === null || messages === null || !shouldDeliverKanbanCard(cardId, messages)) {
    return "hidden";
  }
  return skipped ? "skipped" : "attached";
}
