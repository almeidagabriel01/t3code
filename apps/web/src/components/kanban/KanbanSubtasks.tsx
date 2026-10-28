import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import type { EnvironmentId, KanbanCard, KanbanTemplateId } from "@t3tools/contracts";
import { startableSubtasks, subtaskProgress, subtasksOf } from "@t3tools/shared/kanbanSubtasks";
import { BotIcon, CornerDownRightIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { KanbanStartAgentDialog } from "./KanbanStartAgent";
import { OptionSelect } from "./kanbanDialogs";
import { ColorDot, ProgressBar } from "./kanbanPresentation";
import { useKanbanActions } from "./useKanban";

const NO_TYPE = "__none__";

/** A subtask shows its parent; a top-level card lists, adds, and starts agents for its subtasks. */
export function KanbanSubtasks(props: {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly card: KanbanCard;
  readonly disabled: boolean;
  readonly onOpenCard: (card: KanbanCard) => void;
}) {
  const { environmentId, board, card, disabled } = props;
  const actions = useKanbanActions(environmentId);
  const [title, setTitle] = useState("");
  const [type, setType] = useState(NO_TYPE);
  const [startCards, setStartCards] = useState<ReadonlyArray<KanbanCard> | null>(null);

  const detach = (target: KanbanCard) =>
    void actions.updateCard({ cardId: target.id, parentCardId: null });

  if (card.parentCardId !== null) {
    const parent = board.cards.get(card.parentCardId);
    return (
      <section aria-label="Parent" className="flex items-center gap-2 text-sm">
        <CornerDownRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">Subtask of</span>
        <button
          type="button"
          className="min-w-0 cursor-pointer truncate hover:underline"
          disabled={parent === undefined}
          onClick={() => parent && props.onOpenCard(parent)}
        >
          {parent ? `#${parent.number} ${parent.title}` : "a card that is not on the board"}
        </button>
        {disabled ? null : (
          <Button size="xs" variant="ghost-muted" onClick={() => detach(card)}>
            Detach
          </Button>
        )}
      </section>
    );
  }

  const subtasks = subtasksOf(board.cards.values(), card.id);
  if (subtasks.length === 0 && disabled) return null;
  const progress = subtaskProgress(subtasks, board.columns);
  const startable = startableSubtasks(subtasks, board.columns);

  const add = async () => {
    const text = title.trim();
    if (text.length === 0) return;
    const created = await actions.createCard({
      boardId: board.id,
      title: text,
      parentCardId: card.id,
      ...(type === NO_TYPE ? {} : { type: type as KanbanTemplateId }),
    });
    if (created !== null) setTitle("");
  };

  return (
    <section className="grid gap-2" aria-label="Subtasks">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Subtasks</h3>
        {progress.total > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <ProgressBar done={progress.done} total={progress.total} />
            <span className="tabular-nums">
              {progress.done}/{progress.total} done
            </span>
          </span>
        ) : null}
        {!disabled && startable.length > 0 ? (
          <Button
            size="xs"
            variant="outline"
            className="ms-auto"
            onClick={() => setStartCards(startable)}
          >
            <BotIcon />
            Start agents ({startable.length})
          </Button>
        ) : null}
      </div>
      {subtasks.length > 0 ? (
        <ul className="grid gap-1">
          {subtasks.map((subtask) => {
            const column = board.columns.find((entry) => entry.id === subtask.columnId);
            return (
              <li key={subtask.id} className="group flex items-center gap-2 text-sm">
                <span className="inline-flex w-28 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  {column ? <ColorDot color={column.color} /> : null}
                  <span className="truncate">{column?.name ?? "Unknown"}</span>
                </span>
                <button
                  type="button"
                  className="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline"
                  onClick={() => props.onOpenCard(subtask)}
                >
                  <span className="text-muted-foreground tabular-nums">#{subtask.number}</span>{" "}
                  {subtask.title}
                </button>
                {disabled ? null : (
                  <span className="flex items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Start agent for #${subtask.number}`}
                      onClick={() => setStartCards([subtask])}
                    >
                      <BotIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost-destructive"
                      aria-label={`Detach #${subtask.number}`}
                      onClick={() => detach(subtask)}
                    >
                      <XIcon />
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {disabled ? null : (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Input
            size="sm"
            aria-label="New subtask"
            placeholder="Add a subtask"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          {board.templates.length > 0 ? (
            <OptionSelect
              label="Subtask type"
              value={type}
              options={[
                { value: NO_TYPE, label: "No type" },
                ...board.templates.map((template) => ({
                  value: template.id,
                  label: template.name,
                })),
              ]}
              onChange={setType}
            />
          ) : null}
          <Button size="xs" type="submit" disabled={title.trim().length === 0}>
            Add
          </Button>
        </form>
      )}
      {startCards ? (
        <KanbanStartAgentDialog
          environmentId={environmentId}
          board={board}
          cards={startCards}
          onClose={() => setStartCards(null)}
        />
      ) : null}
    </section>
  );
}
