import type { KanbanCard, KanbanCardId } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const MAX_RESULTS = 8;

function CardPicker(props: {
  readonly candidates: ReadonlyArray<KanbanCard>;
  readonly onPick: (card: KanbanCard) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const text = query.trim().toLowerCase();
  const matches = props.candidates
    .filter((card) => text === "" || `#${card.number} ${card.title}`.toLowerCase().includes(text))
    .slice(0, MAX_RESULTS);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button size="icon-xs" variant="ghost-muted" aria-label="Add relation" />}
      >
        <PlusIcon />
      </PopoverTrigger>
      <PopoverPopup align="start">
        <div className="grid w-64 gap-2">
          <Input
            size="sm"
            autoFocus
            aria-label="Search cards"
            placeholder="Search cards"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {matches.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">No cards found.</p>
          ) : (
            <ul className="grid gap-0.5">
              {matches.map((card) => (
                <li key={card.id}>
                  <button
                    type="button"
                    className="w-full truncate rounded-sm px-2 py-1 text-left text-sm hover:bg-accent"
                    onClick={() => {
                      props.onPick(card);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    #{card.number} {card.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function RelationList(props: {
  readonly title: string;
  readonly ids: ReadonlyArray<KanbanCardId>;
  readonly cards: ReadonlyMap<KanbanCardId, KanbanCard>;
  readonly candidates: ReadonlyArray<KanbanCard>;
  readonly disabled: boolean;
  readonly onChange: (ids: ReadonlyArray<KanbanCardId>) => void;
  readonly onOpenCard: (card: KanbanCard) => void;
}) {
  return (
    <div className="grid gap-1">
      <div className="flex min-h-7 items-center justify-between text-xs text-muted-foreground">
        {props.title}
        {props.disabled ? null : (
          <CardPicker
            candidates={props.candidates.filter((card) => !props.ids.includes(card.id))}
            onPick={(card) => props.onChange([...props.ids, card.id])}
          />
        )}
      </div>
      {props.ids.map((id) => {
        const card = props.cards.get(id);
        return (
          <div key={id} className="group flex items-center gap-1 text-sm">
            <button
              type="button"
              className="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline"
              disabled={card === undefined}
              onClick={() => card && props.onOpenCard(card)}
            >
              {card ? (
                <>
                  <span className="text-muted-foreground tabular-nums">#{card.number}</span>{" "}
                  {card.title}
                </>
              ) : (
                "Card not on the board"
              )}
            </button>
            {props.disabled ? null : (
              <span className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label="Remove relation"
                  onClick={() => props.onChange(props.ids.filter((entry) => entry !== id))}
                >
                  <XIcon />
                </Button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function KanbanCardRelations(props: {
  readonly card: KanbanCard;
  readonly boardCards: ReadonlyMap<KanbanCardId, KanbanCard>;
  readonly disabled: boolean;
  readonly onChange: (patch: {
    blocks?: ReadonlyArray<KanbanCardId>;
    blockedBy?: ReadonlyArray<KanbanCardId>;
  }) => void;
  readonly onOpenCard: (card: KanbanCard) => void;
}) {
  const candidates = [...props.boardCards.values()].filter((card) => card.id !== props.card.id);
  const shared = {
    cards: props.boardCards,
    candidates,
    disabled: props.disabled,
    onOpenCard: props.onOpenCard,
  };
  return (
    <section className="grid gap-2" aria-label="Relations">
      <RelationList
        {...shared}
        title="Blocked by"
        ids={props.card.blockedBy}
        onChange={(blockedBy) => props.onChange({ blockedBy })}
      />
      <RelationList
        {...shared}
        title="Blocks"
        ids={props.card.blocks}
        onChange={(blocks) => props.onChange({ blocks })}
      />
    </section>
  );
}
