import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, NoteSummary } from "@t3tools/contracts";
import {
  EllipsisIcon,
  FolderInputIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useState, type MouseEvent, type ReactNode } from "react";

import { readLocalApi } from "../../localApi";
import { useKanbanEnvironmentIds } from "../../state/kanban";
import { notesEnvironment } from "../../state/notes";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { NoteFileDialog } from "./NoteFileDialog";
import { NoteStartWorkDialog } from "./NoteStartWorkDialog";
import { noteErrorMessage } from "./noteState";
import { useNoteCommand } from "./useNoteCommand";

type RowActionId = "pin" | "start" | "move" | "delete";

interface RowAction {
  readonly id: RowActionId;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Name the desktop and fallback context menus draw. */
  readonly menuIcon: string;
  readonly destructive?: true;
}

export interface NoteRowActions {
  /** Empty when this connection may do none of them. */
  actions: (note: NoteSummary) => ReadonlyArray<RowAction>;
  run: (note: NoteSummary, id: RowActionId) => void;
  showContextMenu: (event: MouseEvent, note: NoteSummary) => void;
  dialogs: ReactNode;
}

/** The inline actions of a note row, with their permissions and dialogs, shared by the ⋯ menu and right-click. */
export function useNoteRowActions(
  environmentId: EnvironmentId,
  selectedPath: string | undefined,
  onSelect: (path: string) => void,
): NoteRowActions {
  const update = useNoteCommand(notesEnvironment.update);
  const canUpdate = useAtomValue(notesEnvironment.update.permissionAtom(environmentId));
  const canMove = useAtomValue(notesEnvironment.move.permissionAtom(environmentId));
  const canDelete = useAtomValue(notesEnvironment.delete.permissionAtom(environmentId));
  const canStartWork = useAtomValue(notesEnvironment.startWork.permissionAtom(environmentId));
  const hasBoards = useKanbanEnvironmentIds().includes(environmentId);
  const canStart = canStartWork && hasBoards;
  const [dialog, setDialog] = useState<{
    note: NoteSummary;
    kind: "move" | "delete" | "first" | "another";
  } | null>(null);

  const actions = (note: NoteSummary) => {
    const list: RowAction[] = [];
    if (canUpdate && !note.issue)
      list.push(
        note.pinned
          ? { id: "pin", label: "Unpin", icon: PinOffIcon, menuIcon: "pin-off" }
          : { id: "pin", label: "Pin to the top", icon: PinIcon, menuIcon: "pin" },
      );
    if (canStart && !note.issue)
      list.push({
        id: "start",
        label: note.card === null ? "Start work" : "Start another card…",
        icon: PlayIcon,
        menuIcon: "play",
      });
    if (canMove)
      list.push({
        id: "move",
        label: "Rename or move…",
        icon: FolderInputIcon,
        menuIcon: "folder",
      });
    if (canDelete)
      list.push({
        id: "delete",
        label: "Delete…",
        icon: Trash2Icon,
        menuIcon: "trash",
        destructive: true,
      });
    return list;
  };
  const run = (note: NoteSummary, id: RowActionId) => {
    if (id === "pin") {
      void update({ environmentId, input: { path: note.path, pinned: !note.pinned } }).then(
        (result) => {
          if (!result.ok)
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Couldn’t update the note",
                description: noteErrorMessage(result.error),
              }),
            );
        },
      );
    } else {
      setDialog({
        note,
        kind: id === "start" ? (note.card === null ? "first" : "another") : id,
      });
    }
  };
  const showContextMenu = (event: MouseEvent, note: NoteSummary) => {
    const api = readLocalApi();
    const list = actions(note);
    if (!api || list.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void api.contextMenu
      .show(
        list.map((action, index) => ({
          id: action.id,
          label: action.label,
          icon: action.menuIcon,
          ...(action.destructive ? { destructive: true, separatorBefore: index > 0 } : {}),
        })),
        { x: event.clientX, y: event.clientY },
      )
      .then((id) => {
        if (id) run(note, id);
      });
  };
  return {
    actions,
    run,
    showContextMenu,
    dialogs: dialog ? (
      dialog.kind === "move" || dialog.kind === "delete" ? (
        <NoteFileDialog
          environmentId={environmentId}
          action={dialog.kind}
          document={dialog.note}
          onClose={() => setDialog(null)}
          onDone={(path) => {
            setDialog(null);
            if (path && dialog.note.path === selectedPath) onSelect(path);
          }}
        />
      ) : (
        <NoteStartWorkDialog
          environmentId={environmentId}
          document={dialog.note}
          another={dialog.kind === "another"}
          onStarted={() => undefined}
          onClose={() => setDialog(null)}
        />
      )
    ) : null,
  };
}

/** The ⋯ button at a row's top-right; its parent is the `group/row` that reveals it. */
export function NoteRowMenu(props: { note: NoteSummary; rows: NoteRowActions; tabbable: boolean }) {
  const list = props.rows.actions(props.note);
  if (list.length === 0) return null;
  return (
    <div className="absolute end-1.5 top-1.5 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-[[data-popup-open]]:opacity-100 pointer-coarse:hidden">
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Actions for ${props.note.title}`}
              tabIndex={props.tabbable ? 0 : -1}
            />
          }
        >
          <EllipsisIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end">
          {list.map((action) => (
            <Fragment key={action.id}>
              {action.destructive ? <MenuSeparator /> : null}
              <MenuItem
                variant={action.destructive ? "destructive" : "default"}
                onClick={() => props.rows.run(props.note, action.id)}
              >
                <action.icon aria-hidden />
                {action.label}
              </MenuItem>
            </Fragment>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}
