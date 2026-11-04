import { useRef, useState } from "react";

import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** An input that commits on Enter or blur and cancels on Escape; an empty or unchanged value is a no-op. */
export function NoteTitleInput(props: {
  title: string;
  label: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.title);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = value.trim();
    if (commit && next.length > 0 && next !== props.title) props.onCommit(next);
    else props.onCancel();
  };
  return (
    <Input
      autoFocus
      size="sm"
      aria-label={props.label}
      value={value}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
    />
  );
}

/** The note's title in its header: a button that becomes an input on click, Enter or F2. */
export function EditableNoteTitle(props: {
  title: string;
  folder: string | null;
  editable: boolean;
  onCommit: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const folder = props.folder ? (
    <span className="shrink-0 font-normal text-muted-foreground">{props.folder} / </span>
  ) : null;
  if (editing && props.editable)
    return (
      <div className="flex min-w-0 flex-1 items-center text-sm">
        {folder}
        <NoteTitleInput
          title={props.title}
          label="Note title"
          onCommit={(title) => {
            setEditing(false);
            props.onCommit(title);
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  const label = (
    <span className="min-w-0 truncate text-sm font-medium">
      {props.folder ? (
        <span className="font-normal text-muted-foreground">{props.folder} / </span>
      ) : null}
      {props.title}
    </span>
  );
  if (!props.editable) return <p className="flex min-w-0">{label}</p>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Rename ${props.title}`}
            className="flex min-w-0 cursor-text rounded-md px-1.5 py-1 text-start outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={() => setEditing(true)}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                setEditing(true);
              }
            }}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="bottom">Rename</TooltipPopup>
    </Tooltip>
  );
}
