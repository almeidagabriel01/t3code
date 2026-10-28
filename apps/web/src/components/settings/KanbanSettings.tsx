import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import type {
  KanbanAutomations,
  KanbanPriority,
  KanbanTemplate,
  KanbanTemplateId,
} from "@t3tools/contracts";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { requestConfirmDialog } from "../../confirmDialog";
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
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { boardScopeKey, collectGlobalBoards, KANBAN_PRIORITIES } from "../kanban/kanban.logic";
import { OptionSelect, PromptDialog } from "../kanban/kanbanDialogs";
import { useKanbanGlobalLayout } from "../kanban/kanbanPreferences";
import {
  KANBAN_COLOR_NAMES,
  LabelChip,
  PRIORITY_LABELS,
  TemplateIcon,
} from "../kanban/kanbanPresentation";
import { useKanbanActions, useKanbanCanEdit, useKanbanStates } from "../kanban/useKanban";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ScopedSwitch } from "./ScopedSwitch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const AUTOMATION_ROWS: ReadonlyArray<{
  readonly key: keyof KanbanAutomations;
  readonly label: string;
  readonly description: string;
}> = [
  {
    key: "threadStarted",
    label: "Thread started",
    description: "Move a card to In progress when a linked thread starts.",
  },
  {
    key: "runCompleted",
    label: "Run completed",
    description: "Move a card to Review when a linked thread's run finishes.",
  },
  {
    key: "prMerged",
    label: "Pull request merged",
    description: "Move a card to Done when a linked thread's pull request merges.",
  },
  {
    key: "definitionOfDone",
    label: "Definition of done",
    description:
      "Agents and automations can only move a card into Review or Done once its checklist is complete and a summary comment exists. Dragging by hand still works, with a warning.",
  },
];

const TEMPLATE_ICONS = ["bug", "sparkles", "wrench", "broom", "tag"].map((value) => ({
  value,
  label: value,
}));

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

function TemplateDialog(props: {
  readonly template: KanbanTemplate | null;
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

function BoardSettings(props: {
  readonly environmentId: Parameters<typeof useKanbanActions>[0];
  readonly board: KanbanBoardState;
}) {
  const { board } = props;
  const canEdit = useKanbanCanEdit(props.environmentId);
  const actions = useKanbanActions(props.environmentId);
  const [templateDialog, setTemplateDialog] = useState<{
    readonly template: KanbanTemplate | null;
  } | null>(null);
  const [newLabel, setNewLabel] = useState(false);

  const deleteTemplate = async (template: KanbanTemplate) => {
    const confirmed = await requestConfirmDialog(
      `Delete the ${template.name} template?\nCards keep their type text but lose the template.`,
      { variant: "destructive" },
    );
    if (confirmed === false) return;
    await actions.deleteTemplate({
      boardId: board.id,
      templateId: template.id as KanbanTemplateId,
    });
  };

  return (
    <>
      <SettingsSection id="kanban-automations" title="Automations">
        {AUTOMATION_ROWS.map((row) => (
          <SettingsRow
            key={row.key}
            {...(row.key === "definitionOfDone"
              ? searchableSetting("kanban-definition-of-done")
              : row.key === "threadStarted"
                ? searchableSetting("kanban-automations")
                : {})}
            title={row.label}
            description={row.description}
            control={
              <Switch
                checked={board.automations[row.key]}
                disabled={!canEdit}
                aria-label={row.label}
                onCheckedChange={(checked) =>
                  void actions.updateBoard({
                    boardId: board.id,
                    automations: { [row.key]: Boolean(checked) },
                  })
                }
              />
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection
        id="kanban-templates"
        title="Card templates"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canEdit}
            onClick={() => setTemplateDialog({ template: null })}
          >
            <PlusIcon />
            Add template
          </Button>
        }
      >
        {board.templates.length === 0 ? (
          <SettingsRow
            {...searchableSetting("kanban-templates")}
            description="No templates on this board."
          />
        ) : (
          board.templates.map((template, index) => (
            <SettingsRow
              key={template.id}
              {...(index === 0 ? searchableSetting("kanban-templates") : {})}
              title={
                <span className="inline-flex items-center gap-2">
                  <TemplateIcon template={template} />
                  {template.name}
                </span>
              }
              description={`${template.checklist.length} checklist item${template.checklist.length === 1 ? "" : "s"} · ${PRIORITY_LABELS[template.priority]}`}
              control={
                <span className="flex gap-1">
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Edit ${template.name}`}
                    disabled={!canEdit}
                    onClick={() => setTemplateDialog({ template })}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-destructive"
                    aria-label={`Delete ${template.name}`}
                    disabled={!canEdit}
                    onClick={() => void deleteTemplate(template)}
                  >
                    <Trash2Icon />
                  </Button>
                </span>
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection
        id="kanban-labels"
        title="Labels"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canEdit}
            onClick={() => setNewLabel(true)}
          >
            <PlusIcon />
            Add label
          </Button>
        }
      >
        {board.labels.length === 0 ? (
          <SettingsRow
            {...searchableSetting("kanban-labels")}
            description="No labels on this board."
          />
        ) : (
          board.labels.map((label, index) => (
            <SettingsRow
              key={label.id}
              {...(index === 0 ? searchableSetting("kanban-labels") : {})}
              title={<LabelChip label={label} />}
              control={
                <span className="flex items-center gap-1">
                  <OptionSelect
                    label={`${label.name} color`}
                    value={label.color}
                    disabled={!canEdit}
                    options={KANBAN_COLOR_NAMES.map((value) => ({ value, label: value }))}
                    onChange={(color) =>
                      void actions.upsertLabel({
                        boardId: board.id,
                        labelId: label.id,
                        name: label.name,
                        color,
                      })
                    }
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost-destructive"
                    aria-label={`Delete ${label.name}`}
                    disabled={!canEdit}
                    onClick={() =>
                      void actions.deleteLabel({ boardId: board.id, labelId: label.id })
                    }
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
          template={templateDialog.template}
          onClose={() => setTemplateDialog(null)}
          onSubmit={(next) =>
            void actions.upsertTemplate({
              boardId: board.id,
              ...(templateDialog.template ? { templateId: templateDialog.template.id } : {}),
              ...next,
              labelIds: templateDialog.template?.labelIds ?? [],
            })
          }
        />
      ) : null}
      {newLabel ? (
        <PromptDialog
          title="New label"
          label="Name"
          submitLabel="Create"
          onClose={() => setNewLabel(false)}
          onSubmit={(name) =>
            void actions.upsertLabel({
              boardId: board.id,
              name,
              color: KANBAN_COLOR_NAMES[board.labels.length % KANBAN_COLOR_NAMES.length]!,
            })
          }
        />
      ) : null}
    </>
  );
}

export function KanbanSettingsPanel() {
  const states = useKanbanStates();
  const groups = useSidebarProjectGroups();
  const [layout, setLayout] = useKanbanGlobalLayout();
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const boards = collectGlobalBoards(states);
  const names = new Map(
    groups.flatMap((group) =>
      group.memberProjects.map(
        (m) => [boardScopeKey(m.environmentId, m.id), group.displayName] as const,
      ),
    ),
  );
  const nameOf = (entry: (typeof boards)[number]) =>
    names.get(boardScopeKey(entry.environmentId, entry.board.projectId)) ?? entry.board.title;
  const selected = boards.find((entry) => entry.board.id === selectedBoardId) ?? boards[0];

  return (
    <SettingsPageContainer>
      <SettingsSection id="kanban-view" title="Boards">
        <SettingsRow
          {...searchableSetting("kanban-default-layout")}
          description="How the all-boards page groups cards when it opens. Each project's own board is always by column."
          control={
            <OptionSelect
              label="Global board layout"
              value={layout}
              options={[
                { value: "merged", label: "By status" },
                { value: "lanes", label: "By project" },
              ]}
              onChange={setLayout}
            />
          }
        />
        <SettingsRow
          title="Default columns and templates"
          description="New boards start with Backlog, To do, In progress, Review and Done, plus Bug, Feature, Refactor and Chore templates. Edit a board's columns on the board itself and its templates below."
        />
        {boards.length === 0 ? (
          <SettingsRow
            title="No boards yet"
            description="Open a project's board from the sidebar to create it, then configure it here."
          />
        ) : (
          <SettingsRow
            title="Board to configure"
            description="Automations, templates and labels belong to a single board."
            control={
              <OptionSelect
                label="Board"
                value={selected?.board.id ?? ""}
                options={boards.map((entry) => ({
                  value: entry.board.id as string,
                  label: nameOf(entry),
                }))}
                onChange={setSelectedBoardId}
              />
            }
          />
        )}
      </SettingsSection>
      <SettingsSection id="kanban-agents" title="Agent integration">
        <SettingsRow
          serverScoped
          {...searchableSetting("kanban-agent-tool")}
          settingKeys={["kanbanAgentToolEnabled"]}
          title="Let agents use the board"
          description="When off, agents don't see the kanban tool at all."
          control={
            <ScopedSwitch
              settingKeys={["kanbanAgentToolEnabled"]}
              checked={settings.kanbanAgentToolEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ kanbanAgentToolEnabled: Boolean(checked) })
              }
              aria-label="Let agents use the board"
            />
          }
        />
        <SettingsRow
          serverScoped
          {...searchableSetting("kanban-agent-default-board")}
          settingKeys={["kanbanAgentDefaultBoard"]}
          title="Default board for agents"
          description="Which board an agent uses when it names no project and no card."
          control={
            <OptionSelect
              label="Default board for agents"
              value={settings.kanbanAgentDefaultBoard}
              disabled={!settings.kanbanAgentToolEnabled}
              options={[
                { value: "thread-project", label: "Thread's project" },
                { value: "ask", label: "Ask which project" },
              ]}
              onChange={(kanbanAgentDefaultBoard) => updateSettings({ kanbanAgentDefaultBoard })}
            />
          }
        />
      </SettingsSection>
      {selected ? (
        <BoardSettings
          key={selected.board.id}
          environmentId={selected.environmentId}
          board={selected.board}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
