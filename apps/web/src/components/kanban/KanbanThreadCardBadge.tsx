import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, RefreshCwIcon, SquareKanbanIcon, UnlinkIcon } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";

import { cn } from "~/lib/utils";
import { useThreadKanbanCard } from "../../state/kanban";
import { InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useKanbanActions, useKanbanCanEdit } from "./useKanban";

/**
 * `#N` for a thread linked to a board card; opens that card. Renders nothing for other threads.
 * With `onLinkAnother` the badge is a menu: open, unlink, or switch to another card.
 */
export function KanbanThreadCardBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectKey?: string | undefined;
  readonly showTitle?: boolean;
  /** Classes for the card title, e.g. to hide it in narrow headers. */
  readonly titleClassName?: string;
  readonly onLinkAnother?: (() => void) | undefined;
}) {
  const card = useThreadKanbanCard(props.environmentId, props.threadId);
  const navigate = useNavigate();
  const actions = useKanbanActions(props.environmentId);
  const canEdit = useKanbanCanEdit(props.environmentId);
  if (card === null) return null;
  const open = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void navigate({
      to: "/kanban",
      search: { card: card.id, ...(props.projectKey ? { projectKey: props.projectKey } : {}) },
    });
  };
  const label = (
    <span className="inline-flex items-center gap-1">
      <SquareKanbanIcon aria-hidden className="size-3" />
      <span>#{card.number}</span>
      {props.showTitle ? (
        <span className={cn("max-w-48 truncate", props.titleClassName)}>{card.title}</span>
      ) : null}
    </span>
  );
  const ariaLabel = `Board card #${card.number}, ${card.title}`;
  if (props.onLinkAnother === undefined) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              aria-label={ariaLabel}
              onClick={open}
              onPointerDown={(event: PointerEvent) => event.stopPropagation()}
            />
          }
        >
          {label}
        </TooltipTrigger>
        <TooltipPopup side="top">Open card</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Menu>
      <MenuTrigger render={<InlineButton aria-label={ariaLabel} />}>{label}</MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={open}>
          <ExternalLinkIcon />
          Open card
        </MenuItem>
        {canEdit ? (
          <>
            <MenuItem onClick={props.onLinkAnother}>
              <RefreshCwIcon />
              Link to another card…
            </MenuItem>
            <MenuItem
              onClick={() =>
                void actions.unlinkCardThread({ cardId: card.id, threadId: props.threadId })
              }
            >
              <UnlinkIcon />
              Unlink from this thread
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
