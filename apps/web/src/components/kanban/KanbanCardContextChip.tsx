import type { KanbanCardContextRecord } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { SquareKanbanIcon } from "lucide-react";

import { ContextChip, ContextChipLabel } from "../ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function KanbanCardContextChip(props: {
  record: Pick<KanbanCardContextRecord, "cardId" | "number" | "title">;
  copyMarkdown?: string;
}) {
  const label = `#${props.record.number} ${props.record.title}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            render={<Link to="/kanban" search={{ card: props.record.cardId }} />}
            aria-label={`Board card, ${label}`}
            data-markdown-copy={props.copyMarkdown}
            className="no-underline"
          >
            <SquareKanbanIcon />
            <ContextChipLabel>{label}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">Open card</TooltipPopup>
    </Tooltip>
  );
}
