import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SquareKanbanIcon } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";

import { useThreadKanbanCard } from "../../state/kanban";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** `#N` for a thread linked to a board card; opens that card. Renders nothing for other threads. */
export function KanbanThreadCardBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectKey?: string | undefined;
  readonly showTitle?: boolean;
}) {
  const card = useThreadKanbanCard(props.environmentId, props.threadId);
  const navigate = useNavigate();
  if (card === null) return null;
  const open = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void navigate({
      to: "/kanban",
      search: { card: card.id, ...(props.projectKey ? { projectKey: props.projectKey } : {}) },
    });
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <InlineButton
            aria-label={`Board card #${card.number}, ${card.title}`}
            onClick={open}
            onPointerDown={(event: PointerEvent) => event.stopPropagation()}
          />
        }
      >
        <span className="inline-flex items-center gap-1">
          <SquareKanbanIcon aria-hidden className="size-3" />
          <span>#{card.number}</span>
          {props.showTitle ? <span className="max-w-48 truncate">{card.title}</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">Open card</TooltipPopup>
    </Tooltip>
  );
}
