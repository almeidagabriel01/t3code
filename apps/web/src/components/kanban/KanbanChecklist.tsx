import { checklistProgress, moveChecklistItem } from "@t3tools/client-runtime/state/kanbanLogic";
import type { KanbanChecklistItem } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ProgressBar, QuietInput } from "./kanbanPresentation";

type Item = Pick<KanbanChecklistItem, "id" | "text" | "done">;

export function KanbanChecklist(props: {
  readonly title: string;
  readonly items: ReadonlyArray<Item>;
  readonly disabled: boolean;
  readonly onChange: (
    items: ReadonlyArray<{ id?: Item["id"]; text: string; done: boolean }>,
  ) => void;
}) {
  const [draft, setDraft] = useState("");
  const { done, total } = checklistProgress(props.items);
  const { items, onChange } = props;
  return (
    <section className="grid gap-2" aria-label={props.title}>
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {props.title}
        {total > 0 ? (
          <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
            <ProgressBar done={done} total={total} />
            <span className="tabular-nums">
              {done}/{total}
            </span>
          </span>
        ) : null}
      </h3>
      <ul className="grid">
        {items.map((item, index) => (
          <li key={item.id} className="group flex items-center gap-2 rounded-md py-0.5">
            <Checkbox
              checked={item.done}
              disabled={props.disabled}
              aria-label={`Done: ${item.text}`}
              onCheckedChange={(checked) =>
                onChange(
                  items.map((entry) =>
                    entry === item ? { ...entry, done: Boolean(checked) } : entry,
                  ),
                )
              }
            />
            <QuietInput
              key={item.text}
              defaultValue={item.text}
              disabled={props.disabled}
              aria-label="Item text"
              className={cn("flex-1", item.done && "text-muted-foreground line-through")}
              onBlur={(event) => {
                const text = event.target.value.trim();
                if (text.length > 0 && text !== item.text) {
                  onChange(items.map((entry) => (entry === item ? { ...entry, text } : entry)));
                }
              }}
            />
            {props.disabled ? null : (
              <span className="flex shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => onChange(moveChecklistItem(items, index, -1))}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Move down"
                  disabled={index === items.length - 1}
                  onClick={() => onChange(moveChecklistItem(items, index, 1))}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label="Delete item"
                  onClick={() => onChange(items.filter((entry) => entry !== item))}
                >
                  <XIcon />
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {props.disabled ? null : (
        <div className="flex items-center gap-2 text-muted-foreground">
          <PlusIcon className="size-4 shrink-0" />
          <QuietInput
            value={draft}
            aria-label={`Add to ${props.title.toLowerCase()}`}
            placeholder="Add an item"
            className="flex-1"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              const text = draft.trim();
              if (text.length === 0) return;
              onChange([...items, { text, done: false }]);
              setDraft("");
            }}
          />
        </div>
      )}
    </section>
  );
}
