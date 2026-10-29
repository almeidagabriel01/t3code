import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import { dueAtToInput, inputToDueAt } from "@t3tools/client-runtime/state/kanbanLogic";
import type { EnvironmentId, KanbanCard, KanbanCardId, KanbanColumnId } from "@t3tools/contracts";
import { ArchiveIcon, ArrowRightIcon, PanelRightOpenIcon, TagIcon, Trash2Icon } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup } from "../ui/popover";
import { LabelMenuItems } from "./KanbanCardDetail";
import { ColorDot } from "./kanbanPresentation";
import { useKanbanCardCommands } from "./useKanbanCardCommands";

export interface QuickEditTarget {
  readonly cardId: KanbanCardId;
  readonly anchor: HTMLElement;
}

/** Trello's quick card editor: rename and the common actions without opening the card. */
export function KanbanQuickEdit(props: {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly card: KanbanCard;
  readonly anchor: HTMLElement;
  readonly onOpenCard: (card: KanbanCard) => void;
  readonly onClose: () => void;
}) {
  const { board, card } = props;
  const { patch, moveTo, remove, archive, toggleLabel } = useKanbanCardCommands(
    props.environmentId,
    board,
    card,
  );
  const after = (done: Promise<boolean>) => void done.then((closed) => closed && props.onClose());

  return (
    <Popover open onOpenChange={(open) => !open && props.onClose()}>
      <PopoverPopup
        anchor={props.anchor}
        side="right"
        align="start"
        width="sm"
        padding="compact"
        aria-label={`Quick edit #${card.number}`}
      >
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const title = new FormData(event.currentTarget).get("title")?.toString().trim() ?? "";
            if (title.length > 0 && title !== card.title) void patch({ title });
            props.onClose();
          }}
        >
          <Input
            name="title"
            size="sm"
            autoFocus
            aria-label="Card title"
            defaultValue={card.title}
          />
          <Button type="submit" size="xs">
            Save
          </Button>
        </form>
        <div role="group" aria-label="Card actions" className="mt-2 grid gap-0.5">
          <Button
            size="xs"
            variant="ghost"
            className="justify-start"
            onClick={() => {
              props.onClose();
              props.onOpenCard(card);
            }}
          >
            <PanelRightOpenIcon />
            Open card
          </Button>
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="ghost" className="justify-start" />}>
              <ArrowRightIcon />
              Move
            </MenuTrigger>
            <MenuPopup align="start" side="right">
              <MenuRadioGroup
                value={card.columnId}
                onValueChange={(value) => void moveTo(value as KanbanColumnId)}
              >
                {board.columns.map((column) => (
                  <MenuRadioItem key={column.id} value={column.id}>
                    <ColorDot color={column.color} />
                    {column.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="ghost" className="justify-start" />}>
              <TagIcon />
              Labels
            </MenuTrigger>
            <MenuPopup align="start" side="right">
              <LabelMenuItems board={board} card={card} onToggle={toggleLabel} />
            </MenuPopup>
          </Menu>
          <div className="my-1.5 grid gap-1.5 px-2">
            <Label htmlFor="kanban-quick-edit-due">Due date</Label>
            <Input
              id="kanban-quick-edit-due"
              type="date"
              size="sm"
              value={dueAtToInput(card.dueAt)}
              onChange={(event) => void patch({ dueAt: inputToDueAt(event.target.value) })}
            />
          </div>
          <Button
            size="xs"
            variant="ghost"
            className="justify-start"
            onClick={() => after(archive())}
          >
            <ArchiveIcon />
            Archive
          </Button>
          <Button
            size="xs"
            variant="ghost-destructive"
            className="justify-start"
            onClick={() => after(remove())}
          >
            <Trash2Icon />
            Delete…
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
