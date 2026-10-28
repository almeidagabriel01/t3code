import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { LinkIcon, SquareKanbanIcon } from "lucide-react";
import { useState, type MouseEvent, type PointerEvent } from "react";

import { useQuietThreadShell } from "../../state/entities";
import { useKanbanEnvironmentIds, useThreadKanbanCard } from "../../state/kanban";
import { Button, InlineButton } from "../ui/button";
import { KanbanLinkCardDialog } from "./KanbanLinkDialogs";
import { useKanbanCanEdit } from "./useKanban";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** `#N` for a thread linked to a board card; opens that card. Renders nothing for other threads. */
export function KanbanThreadCardBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectKey?: string | undefined;
  readonly showTitle?: boolean;
  /** Offers "Link to card" when the thread has none. */
  readonly allowLink?: boolean;
}) {
  const card = useThreadKanbanCard(props.environmentId, props.threadId);
  const navigate = useNavigate();
  const [linking, setLinking] = useState(false);
  const shell = useQuietThreadShell({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const supported = useKanbanEnvironmentIds().includes(props.environmentId);
  const canEdit = useKanbanCanEdit(props.environmentId);
  if (card === null) {
    if (props.allowLink !== true || !supported || !canEdit || shell === null) return null;
    return (
      <>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="ghost-muted"
                aria-label="Link to board card"
                onClick={() => setLinking(true)}
              />
            }
          >
            <LinkIcon />
            Link to card
          </TooltipTrigger>
          <TooltipPopup side="bottom">Link this thread to a board card</TooltipPopup>
        </Tooltip>
        {linking ? (
          <KanbanLinkCardDialog
            environmentId={props.environmentId}
            threadId={props.threadId}
            projectId={shell.projectId}
            onClose={() => setLinking(false)}
          />
        ) : null}
      </>
    );
  }
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
