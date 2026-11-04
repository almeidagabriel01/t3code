import { useAtom } from "@effect/atom-react";
import {
  composerKanbanCardChipState,
  kanbanCardSkipAtom,
  kanbanCardSkipKey,
} from "@t3tools/client-runtime/state/kanbanCardSkip";
import type { EnvironmentId, OrchestrationMessageContext, ThreadId } from "@t3tools/contracts";
import { PlusIcon, SquareKanbanIcon, XIcon } from "lucide-react";

import { useThreadKanbanCard } from "../../state/kanban";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";

/**
 * The linked card rides on the next message until one holds it. Removing the chip sends that
 * message without it, and the card stays linked; "Add back" undoes the removal.
 */
export function ComposerKanbanCardChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<{
    readonly context?: OrchestrationMessageContext | undefined;
  }> | null;
}) {
  const card = useThreadKanbanCard(props.environmentId, props.threadId);
  const skipAtom = kanbanCardSkipAtom(kanbanCardSkipKey(props.environmentId, props.threadId));
  const [skipped, setSkipped] = useAtom(skipAtom);
  const state = composerKanbanCardChipState(card?.id ?? null, props.messages, skipped);
  if (card === null || state === "hidden") return null;
  const label = `#${card.number} ${card.title}`;
  return (
    <div className="flex items-center gap-1.5 px-3 pt-2 text-xs" data-testid="composer-kanban-card">
      {state === "attached" ? (
        <>
          <ContextChip kind="thread" className="text-xs">
            <SquareKanbanIcon />
            <ContextChipLabel>{label}</ContextChipLabel>
            <ContextChipAction aria-label="Send without the card" onClick={() => setSkipped(true)}>
              <XIcon />
            </ContextChipAction>
          </ContextChip>
          <span className="text-muted-foreground">goes with this message</span>
        </>
      ) : (
        <>
          <span className="min-w-0 truncate text-muted-foreground">{label} left out</span>
          <ContextChip kind="thread" className="text-xs">
            <ContextChipAction className="w-auto gap-1 px-1" onClick={() => setSkipped(false)}>
              <PlusIcon />
              Add back
            </ContextChipAction>
          </ContextChip>
        </>
      )}
    </div>
  );
}
