import type {
  EnvironmentId,
  KanbanColumn,
  KanbanColumnId,
  KanbanColumnRole,
} from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { isWipExceeded, KANBAN_ROLE_LABELS, KANBAN_ROLES } from "./kanban.logic";
import { ChoiceDialog, PromptDialog } from "./kanbanDialogs";
import { ColorDot, KANBAN_COLOR_NAMES } from "./kanbanPresentation";
import { useKanbanActions } from "./useKanban";

type Dialog = "rename" | "wip" | "delete" | null;

export function KanbanColumnHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly column: KanbanColumn;
  readonly siblings: ReadonlyArray<KanbanColumn>;
  readonly count: number;
  readonly canEdit: boolean;
}) {
  const { column, siblings } = props;
  const actions = useKanbanActions(props.environmentId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const index = siblings.findIndex((entry) => entry.id === column.id);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  const exceeded = isWipExceeded(column, props.count);
  const takenRoles = new Set(
    siblings.filter((entry) => entry.id !== column.id && entry.role !== "none").map((e) => e.role),
  );
  const closeDialog = () => setDialog(null);
  return (
    <>
      <ColorDot color={column.color} />
      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{column.name}</h3>
      {column.role !== "none" ? (
        <Badge variant="outline" size="sm">
          {KANBAN_ROLE_LABELS[column.role]}
        </Badge>
      ) : null}
      <Badge
        variant={exceeded ? "warning" : "secondary"}
        size="sm"
        aria-label={exceeded ? "WIP limit exceeded" : undefined}
      >
        {column.wipLimit === null ? props.count : `${props.count}/${column.wipLimit}`}
      </Badge>
      {props.canEdit ? (
        <Menu>
          <MenuTrigger
            render={
              <Button size="icon-xs" variant="ghost-muted" aria-label={`${column.name} options`} />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => setDialog("rename")}>Rename</MenuItem>
            <MenuSub>
              <MenuSubTrigger>Color</MenuSubTrigger>
              <MenuSubPopup>
                <MenuRadioGroup
                  value={column.color}
                  onValueChange={(color) =>
                    void actions.updateColumn({ columnId: column.id, color })
                  }
                >
                  {KANBAN_COLOR_NAMES.map((color) => (
                    <MenuRadioItem key={color} value={color}>
                      <ColorDot color={color} /> {color}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuSubPopup>
            </MenuSub>
            <MenuItem onClick={() => setDialog("wip")}>WIP limit</MenuItem>
            <MenuSub>
              <MenuSubTrigger>Role</MenuSubTrigger>
              <MenuSubPopup>
                <MenuRadioGroup
                  value={column.role}
                  onValueChange={(role) =>
                    void actions.updateColumn({
                      columnId: column.id,
                      role: role as KanbanColumnRole,
                    })
                  }
                >
                  {KANBAN_ROLES.map((role) => (
                    <MenuRadioItem key={role} value={role} disabled={takenRoles.has(role)}>
                      {KANBAN_ROLE_LABELS[role]}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuSubPopup>
            </MenuSub>
            <MenuSeparator />
            <MenuItem
              disabled={previous === undefined}
              onClick={() =>
                previous &&
                void actions.moveColumn({ columnId: column.id, beforeColumnId: previous.id })
              }
            >
              Move left
            </MenuItem>
            <MenuItem
              disabled={next === undefined}
              onClick={() =>
                next && void actions.moveColumn({ columnId: column.id, afterColumnId: next.id })
              }
            >
              Move right
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={siblings.length < 2}
              onClick={() => setDialog("delete")}
            >
              Delete…
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
      {dialog === "rename" ? (
        <PromptDialog
          title="Rename column"
          label="Name"
          initial={column.name}
          onClose={closeDialog}
          onSubmit={(name) => void actions.updateColumn({ columnId: column.id, name })}
        />
      ) : null}
      {dialog === "wip" ? (
        <PromptDialog
          title="WIP limit"
          label="Maximum cards (empty for no limit)"
          inputType="number"
          allowEmpty
          initial={column.wipLimit === null ? "" : String(column.wipLimit)}
          onClose={closeDialog}
          onSubmit={(value) => {
            const limit = Math.floor(Number(value));
            void actions.updateColumn({
              columnId: column.id,
              wipLimit: value === "" || !(limit > 0) ? null : limit,
            } as Parameters<typeof actions.updateColumn>[0]);
          }}
        />
      ) : null}
      {dialog === "delete" ? (
        <ChoiceDialog
          title={`Delete ${column.name}`}
          description={`Its ${props.count} card${props.count === 1 ? "" : "s"} (and any archived ones) move to the column you choose.`}
          options={siblings
            .filter((entry) => entry.id !== column.id)
            .map((entry) => ({ value: entry.id, label: entry.name }))}
          submitLabel="Delete column"
          destructive
          onClose={closeDialog}
          onSubmit={(targetColumnId) =>
            void actions.deleteColumn({
              columnId: column.id,
              targetColumnId: targetColumnId as KanbanColumnId,
            })
          }
        />
      ) : null}
    </>
  );
}
