import {
  BUILT_IN_KANBAN_TEMPLATE,
  type KanbanColumnRole,
  type KanbanDefaultTemplate,
  type KanbanPriority,
  type KanbanTemplate,
} from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import {
  KANBAN_PRIORITIES,
  KANBAN_ROLE_LABELS,
  KANBAN_ROLES,
  moveChecklistItem,
  validateDefaultTemplate,
} from "@t3tools/client-runtime/state/kanbanLogic";
import { OptionSelect } from "../kanban/kanbanDialogs";
import { KANBAN_COLOR_NAMES, PRIORITY_LABELS } from "../kanban/kanbanPresentation";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const TEMPLATE_ICONS = ["bug", "sparkles", "wrench", "broom", "tag"].map((value) => ({
  value,
  label: value,
}));

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export function TemplateDialog(props: {
  readonly template: Omit<KanbanTemplate, "id" | "labelIds"> | null;
  readonly onSubmit: (template: Omit<KanbanTemplate, "id" | "labelIds">) => void;
  readonly onClose: () => void;
}) {
  const { template } = props;
  const [name, setName] = useState(template?.name ?? "");
  const [icon, setIcon] = useState(template?.icon ?? "tag");
  const [color, setColor] = useState(template?.color ?? "slate");
  const [priority, setPriority] = useState<KanbanPriority>(template?.priority ?? "none");
  const [checklist, setChecklist] = useState((template?.checklist ?? []).join("\n"));
  const [criteria, setCriteria] = useState((template?.acceptanceCriteria ?? []).join("\n"));
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{template ? "Edit template" : "New template"}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="kanban-template-name">Name</Label>
              <Input
                id="kanban-template-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <OptionSelect label="Icon" value={icon} options={TEMPLATE_ICONS} onChange={setIcon} />
              <OptionSelect
                label="Color"
                value={color}
                options={KANBAN_COLOR_NAMES.map((value) => ({ value, label: value }))}
                onChange={setColor}
              />
              <OptionSelect
                label="Priority"
                value={priority}
                options={KANBAN_PRIORITIES.map((value) => ({
                  value,
                  label: PRIORITY_LABELS[value],
                }))}
                onChange={setPriority}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kanban-template-checklist">Checklist (one item per line)</Label>
              <Textarea
                id="kanban-template-checklist"
                rows={4}
                value={checklist}
                onChange={(event) => setChecklist(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kanban-template-criteria">Acceptance criteria (one per line)</Label>
              <Textarea
                id="kanban-template-criteria"
                rows={3}
                value={criteria}
                onChange={(event) => setCriteria(event.target.value)}
              />
            </div>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={name.trim().length === 0}
            onClick={() => {
              props.onSubmit({
                name: name.trim(),
                icon,
                color,
                priority,
                checklist: lines(checklist),
                acceptanceCriteria: lines(criteria),
              });
              props.onClose();
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

type Column = KanbanDefaultTemplate["columns"][number];
type CardTemplate = KanbanDefaultTemplate["cardTemplates"][number];

/** Rows get a local key so editing or reordering one does not remount its neighbours. */
type Keyed<T> = { readonly key: number; readonly value: T };
let nextRowKey = 0;
const keyed = <T,>(items: ReadonlyArray<T>): ReadonlyArray<Keyed<T>> =>
  items.map((value) => ({ key: ++nextRowKey, value }));
const values = <T,>(rows: ReadonlyArray<Keyed<T>>) => rows.map((row) => row.value);

const replaceAt = <T,>(items: ReadonlyArray<T>, index: number, next: T) =>
  items.map((item, position) => (position === index ? next : item));
const removeAt = <T,>(items: ReadonlyArray<T>, index: number) =>
  items.filter((_, position) => position !== index);

/** Edits the columns and card templates new boards start with; boards already created keep theirs. */
export function KanbanDefaultTemplateEditor(props: {
  readonly saved: KanbanDefaultTemplate | null;
  readonly disabled: boolean;
  readonly onSave: (template: KanbanDefaultTemplate | null) => void;
}) {
  const initial = props.saved ?? BUILT_IN_KANBAN_TEMPLATE;
  const [columnRows, setColumnRows] = useState(() => keyed(initial.columns));
  const [templateRows, setTemplateRows] = useState(() => keyed(initial.cardTemplates));
  const draft: KanbanDefaultTemplate = {
    columns: values(columnRows),
    cardTemplates: values(templateRows),
  };
  const [templateDialog, setTemplateDialog] = useState<{ readonly index: number | null } | null>(
    null,
  );
  const problem = validateDefaultTemplate(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(props.saved ?? BUILT_IN_KANBAN_TEMPLATE);
  const setColumnAt = (index: number, column: Column) =>
    setColumnRows(replaceAt(columnRows, index, { ...columnRows[index]!, value: column }));
  const setTemplateAt = (index: number, template: CardTemplate) =>
    setTemplateRows(replaceAt(templateRows, index, { ...templateRows[index]!, value: template }));

  return (
    <>
      <SettingsSection
        id="kanban-default-template"
        title="Default for new boards"
        headerAction={
          <span className="flex gap-1">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={props.disabled || (props.saved === null && !dirty)}
              onClick={() => {
                setColumnRows(keyed(BUILT_IN_KANBAN_TEMPLATE.columns));
                setTemplateRows(keyed(BUILT_IN_KANBAN_TEMPLATE.cardTemplates));
                props.onSave(null);
              }}
            >
              Reset to built-in
            </Button>
            <Button
              size="xs"
              disabled={props.disabled || !dirty || problem !== null}
              onClick={() => props.onSave(draft)}
            >
              Save
            </Button>
          </span>
        }
      >
        <SettingsRow
          {...searchableSetting("kanban-default-template")}
          description={
            problem ??
            "Columns and card templates a board starts with. Boards that already exist keep theirs."
          }
        />
        {columnRows.map(({ key, value: column }, index) => (
          <SettingsRow
            key={key}
            title={
              <Input
                aria-label={`Column ${index + 1} name`}
                value={column.name}
                disabled={props.disabled}
                onChange={(event) => setColumnAt(index, { ...column, name: event.target.value })}
              />
            }
            control={
              <span className="flex flex-wrap items-center justify-end gap-1">
                <OptionSelect
                  label={`Column ${index + 1} role`}
                  value={column.role}
                  disabled={props.disabled}
                  options={KANBAN_ROLES.map((role) => ({
                    value: role,
                    label: KANBAN_ROLE_LABELS[role],
                  }))}
                  onChange={(role: KanbanColumnRole) => setColumnAt(index, { ...column, role })}
                />
                <OptionSelect
                  label={`Column ${index + 1} color`}
                  value={column.color}
                  disabled={props.disabled}
                  options={KANBAN_COLOR_NAMES.map((value) => ({ value, label: value }))}
                  onChange={(color) => setColumnAt(index, { ...column, color })}
                />
                <Input
                  className="w-20"
                  type="number"
                  min={1}
                  placeholder="WIP"
                  aria-label={`Column ${index + 1} work in progress limit`}
                  value={column.wipLimit ?? ""}
                  disabled={props.disabled}
                  onChange={(event) => {
                    const limit = Math.floor(Number(event.target.value));
                    setColumnAt(index, {
                      ...column,
                      wipLimit: event.target.value === "" || !(limit >= 1) ? null : limit,
                    });
                  }}
                />
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Move column ${column.name} up`}
                  disabled={props.disabled || index === 0}
                  onClick={() => setColumnRows(moveChecklistItem(columnRows, index, -1))}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Move column ${column.name} down`}
                  disabled={props.disabled || index === draft.columns.length - 1}
                  onClick={() => setColumnRows(moveChecklistItem(columnRows, index, 1))}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label={`Remove column ${column.name}`}
                  disabled={props.disabled || draft.columns.length === 1}
                  onClick={() => setColumnRows(removeAt(columnRows, index))}
                >
                  <Trash2Icon />
                </Button>
              </span>
            }
          />
        ))}
        <SettingsRow
          title="Add a column"
          control={
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={props.disabled}
              onClick={() =>
                setColumnRows([
                  ...columnRows,
                  ...keyed<Column>([
                    { name: "New column", color: "slate", role: "none", wipLimit: null },
                  ]),
                ])
              }
            >
              <PlusIcon />
              Add column
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection
        id="kanban-default-card-templates"
        title="Default card templates"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={props.disabled}
            onClick={() => setTemplateDialog({ index: null })}
          >
            <PlusIcon />
            Add template
          </Button>
        }
      >
        {draft.cardTemplates.length === 0 ? (
          <SettingsRow
            title="No templates"
            description="New boards start without card templates."
          />
        ) : (
          templateRows.map(({ key, value: template }, index) => (
            <SettingsRow
              key={key}
              title={template.name}
              description={`${template.checklist.length} checklist item${template.checklist.length === 1 ? "" : "s"} · ${PRIORITY_LABELS[template.priority]}`}
              control={
                <span className="flex gap-1">
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Edit ${template.name}`}
                    disabled={props.disabled}
                    onClick={() => setTemplateDialog({ index })}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-destructive"
                    aria-label={`Remove ${template.name}`}
                    disabled={props.disabled}
                    onClick={() => setTemplateRows(removeAt(templateRows, index))}
                  >
                    <Trash2Icon />
                  </Button>
                </span>
              }
            />
          ))
        )}
      </SettingsSection>
      {templateDialog ? (
        <TemplateDialog
          template={
            templateDialog.index === null ? null : draft.cardTemplates[templateDialog.index]!
          }
          onClose={() => setTemplateDialog(null)}
          onSubmit={(next) =>
            templateDialog.index === null
              ? setTemplateRows([...templateRows, ...keyed([next])])
              : setTemplateAt(templateDialog.index, next)
          }
        />
      ) : null}
    </>
  );
}
