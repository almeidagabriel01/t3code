import { useAtomValue } from "@effect/atom-react";
import { selectNotesInOrder, type NotesState } from "@t3tools/client-runtime/state/notes";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { FileTextIcon, NotebookPenIcon, SearchIcon, SquarePenIcon } from "lucide-react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { notesEnvironment, useNotesEnvironmentIds } from "../../state/notes";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../CommandPalette.logic";

type NotesNavigate = (to: {
  to: "/notes";
  search: { environmentId?: EnvironmentId; path?: string; create?: true };
}) => Promise<void>;

const NO_NOTES: Atom.Atom<AsyncResult.AsyncResult<NotesState, unknown>> = Atom.make(
  AsyncResult.initial<NotesState, unknown>(false),
).pipe(Atom.withLabel("web-notes-palette:none"));

/**
 * Open notes, New note, and Search notes, whose rows are the notes of the primary notes
 * environment, so typing a title in the palette finds the note.
 */
export function useNotesPaletteItems(
  navigate: NotesNavigate,
): ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const ids = useNotesEnvironmentIds();
  const primary = usePrimaryEnvironmentId();
  const environmentId: EnvironmentId | null = ids.find((id) => id === primary) ?? ids[0] ?? null;
  const canCreate = useAtomValue(notesEnvironment.write.permissionAtom(environmentId));
  const liveAtom: Atom.Atom<AsyncResult.AsyncResult<NotesState, unknown>> =
    environmentId === null ? NO_NOTES : notesEnvironment.live({ environmentId, input: null });
  const state = Option.getOrNull(AsyncResult.value(useAtomValue(liveAtom)));
  const notes = state === null ? [] : selectNotesInOrder(state);
  if (environmentId === null) return [];
  const items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
    {
      kind: "action",
      value: "action:notes",
      searchTerms: ["notes", "markdown", "ideas", "notebook"],
      title: "Open notes",
      icon: <NotebookPenIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "notes.open",
      run: () => navigate({ to: "/notes", search: { environmentId } }),
    },
  ];
  if (canCreate) {
    items.push({
      kind: "action",
      value: "action:new-note",
      searchTerms: ["new note", "create note", "idea", "markdown"],
      title: "New note",
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      run: () => navigate({ to: "/notes", search: { environmentId, create: true } }),
    });
  }
  if (notes.length > 0) {
    items.push({
      kind: "submenu",
      value: "action:search-notes",
      searchTerms: ["search notes", "find note", "notes"],
      title: "Search notes...",
      icon: <SearchIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <FileTextIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: "notes",
          label: "Notes",
          items: notes.map((note) => ({
            kind: "action",
            value: `note:${note.path}`,
            searchTerms: [note.title, note.path, note.preview],
            title: note.title,
            ...(note.folder ? { description: note.folder } : {}),
            icon: <FileTextIcon className={ITEM_ICON_CLASS} />,
            run: () => navigate({ to: "/notes", search: { environmentId, path: note.path } }),
          })),
        },
      ],
    });
  }
  return items;
}
