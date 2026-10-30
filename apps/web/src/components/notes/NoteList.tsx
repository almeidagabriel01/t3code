import type { EnvironmentId, NoteFolder, NoteSummary } from "@t3tools/contracts";
import { PinIcon, PlusIcon, SearchIcon, SquareKanbanIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { NoteRowMenu, useNoteRowActions, type NoteRowActions } from "./NoteRowMenu";
import { filterNotes, groupNotes, openablePath } from "./noteState";

function NoteRow(props: {
  note: NoteSummary;
  selected: boolean;
  tabbable: boolean;
  showFolder: boolean;
  projectName: string | undefined;
  rows: NoteRowActions;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { note } = props;
  return (
    <li className="group/row relative py-0.5">
      <button
        type="button"
        data-note-row={note.path}
        tabIndex={props.tabbable ? 0 : -1}
        aria-current={props.selected ? "page" : undefined}
        onClick={props.onSelect}
        onKeyDown={props.onKeyDown}
        onContextMenu={(event) => props.rows.showContextMenu(event, note)}
        className="grid w-full cursor-pointer gap-0.5 rounded-lg border border-foreground/12 bg-foreground/3 px-3 py-2 text-start outline-none transition-colors hover:border-foreground/24 hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=page]:border-primary/60 aria-[current=page]:bg-primary/12"
      >
        <span className="flex min-w-0 items-baseline gap-2 pe-7">
          {note.pinned ? (
            <PinIcon
              aria-label="Pinned"
              className="size-3 shrink-0 self-center text-muted-foreground"
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-sm font-medium [word-break:keep-all]">
            {note.title}
          </span>
          <time
            dateTime={note.updatedAt}
            className="shrink-0 text-xs text-muted-foreground tabular-nums"
          >
            {formatRelativeTimeLabel(note.updatedAt)}
          </time>
        </span>
        {note.preview ? (
          <span className="line-clamp-2 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            {note.preview}
          </span>
        ) : null}
        {(props.showFolder && note.folder) || note.card || props.projectName ? (
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {props.showFolder && note.folder ? (
              <span className="min-w-0 truncate">{note.folder}</span>
            ) : null}
            {props.projectName ? (
              <span className="min-w-0 truncate rounded bg-muted px-1.5">{props.projectName}</span>
            ) : null}
            {note.card ? (
              <span className="inline-flex shrink-0 items-center gap-1">
                <SquareKanbanIcon aria-hidden className="size-3" />
                On the board
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
      <NoteRowMenu note={note} rows={props.rows} tabbable={props.tabbable} />
    </li>
  );
}

/** Pinned notes, loose notes, and one collapsible group per folder, with search above them. */
export function NoteList(props: {
  environmentId: EnvironmentId;
  notes: ReadonlyArray<NoteSummary>;
  folders: ReadonlyArray<NoteFolder>;
  /** Project names by id, to label each note; absent on a project's own list. */
  projectNames?: ReadonlyMap<string, string> | undefined;
  selectedPath: string | undefined;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (path: string, options?: { replace?: boolean }) => void;
  onOpenEditor: (path: string) => void;
  onCreate: (() => void) | null;
  createShortcut: string | null;
  header?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const rows = useNoteRowActions(props.environmentId, props.selectedPath, props.onSelect);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const searching = props.query.trim().length > 0;
  const matches = filterNotes(props.notes, props.query);
  const groups = groupNotes(matches, searching ? [] : props.folders);
  const isOpen = (folder: string) => searching || !collapsed.has(folder);
  const ordered = [
    ...groups.pinned,
    ...groups.loose,
    ...groups.folders.flatMap((group) => (isOpen(group.folder) ? group.notes : [])),
  ];
  const position = new Map(ordered.map((note, index) => [note.path, index]));
  const pathToOpen = openablePath(props.notes, props.query);
  const focusRow = (index: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-note-row]");
    const row = rows?.[Math.max(0, Math.min(index, (rows?.length ?? 1) - 1))];
    if (!row) return;
    row.focus();
    const path = row.dataset.noteRow;
    if (path && path !== props.selectedPath) props.onSelect(path, { replace: true });
  };
  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Escape" || (event.key === "ArrowUp" && index === 0)) {
      event.preventDefault();
      searchRef.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(index + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter" || event.key === "ArrowRight") {
      event.preventDefault();
      const path = event.currentTarget.dataset.noteRow;
      if (path === undefined) return;
      props.onSelect(path);
      props.onOpenEditor(path);
    }
  };
  const selectedIndex = ordered.findIndex((note) => note.path === props.selectedPath);
  const row = (note: NoteSummary, showFolder: boolean) => {
    const index = position.get(note.path) ?? 0;
    return (
      <NoteRow
        key={note.path}
        note={note}
        showFolder={showFolder}
        projectName={note.project ? props.projectNames?.get(note.project) : undefined}
        rows={rows}
        selected={note.path === props.selectedPath}
        tabbable={index === Math.max(selectedIndex, 0)}
        onSelect={() => props.onSelect(note.path)}
        onKeyDown={(event) => onRowKeyDown(event, index)}
      />
    );
  };
  const toggleFolder = (folder: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(folder)) next.add(folder);
      return next;
    });

  return (
    <nav aria-label="Notes" className={cn("flex min-h-0 flex-col", props.className)}>
      {props.header}
      <div
        className="flex items-center gap-2 border-b border-border bg-background px-2 py-2.5"
        data-glass-layer
      >
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchRef}
            type="search"
            aria-label="Search notes"
            placeholder="Search notes"
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusRow(0);
              } else if (event.key === "Enter" && pathToOpen) {
                props.onSelect(pathToOpen);
              } else if (event.key === "Enter" && ordered[0]) {
                props.onSelect(ordered[0].path);
                props.onOpenEditor(ordered[0].path);
              } else if (event.key === "Escape" && props.query) {
                event.preventDefault();
                props.onQueryChange("");
              }
            }}
            data-notes-search
          />
        </InputGroup>
        {props.onCreate ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="New note"
                  onClick={props.onCreate}
                />
              }
            >
              <PlusIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              New note
              {props.createShortcut ? <Kbd className="ms-2">{props.createShortcut}</Kbd> : null}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {props.children}
        {pathToOpen ? (
          <button
            type="button"
            className="w-full cursor-pointer truncate rounded-lg px-3 py-2 text-start text-sm text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={() => props.onSelect(pathToOpen)}
          >
            Open {pathToOpen}
          </button>
        ) : null}
        {props.notes.length > 0 && matches.length === 0 && !pathToOpen ? (
          <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
            No notes match “{props.query.trim()}”.
          </p>
        ) : null}
        {groups.pinned.length > 0 ? (
          <section aria-label="Pinned" className="pb-2">
            <h2 className="flex h-8 items-center px-2 text-xs font-medium text-muted-foreground">
              Pinned
            </h2>
            <ul>{groups.pinned.map((note) => row(note, true))}</ul>
          </section>
        ) : null}
        {groups.loose.length > 0 ? (
          <ul className="pb-2" aria-label="Notes outside folders">
            {groups.loose.map((note) => row(note, false))}
          </ul>
        ) : null}
        {groups.folders.map((group) => (
          <section key={group.folder} aria-label={group.folder} className="pb-1">
            <CollapsibleSectionHeader
              expanded={isOpen(group.folder)}
              disabled={searching}
              onClick={() => toggleFolder(group.folder)}
              accessory={
                <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                  {group.notes.length}
                </span>
              }
            >
              {group.folder}
            </CollapsibleSectionHeader>
            {isOpen(group.folder) ? (
              group.notes.length > 0 ? (
                <ul>{group.notes.map((note) => row(note, false))}</ul>
              ) : (
                <p className="px-3 py-1.5 text-xs text-muted-foreground">No notes here yet.</p>
              )
            ) : null}
          </section>
        ))}
      </div>
      {rows.dialogs}
    </nav>
  );
}
