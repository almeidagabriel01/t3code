import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import {
  definitionOfDoneWarning,
  describeCardEvent,
  dueAtToInput,
  formatCardDuration,
  inputToDueAt,
  KANBAN_PRIORITIES,
} from "@t3tools/client-runtime/state/kanbanLogic";
import type {
  EnvironmentId,
  KanbanCard,
  KanbanCardEvent,
  KanbanColumnId,
  KanbanLabelId,
  KanbanPriority,
  KanbanTemplateId,
} from "@t3tools/contracts";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BotIcon,
  EllipsisIcon,
  PlusIcon,
  Trash2Icon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useProject } from "../../state/entities";
import { kanbanEnvironment } from "../../state/kanban";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { KanbanCardRelations } from "./KanbanCardRelations";
import { KanbanChecklist } from "./KanbanChecklist";
import { KanbanLinkedAgents } from "./KanbanLinkedAgents";
import { PromptDialog } from "./kanbanDialogs";
import {
  ColorDot,
  KANBAN_COLOR_NAMES,
  LabelChip,
  PRIORITY_LABELS,
  PriorityIcon,
  PropertyRow,
  QuietInput,
  TemplateIcon,
} from "./kanbanPresentation";
import { useKanbanActions } from "./useKanban";

const NO_TYPE = "__none__";

/** A property value that reads as text and opens its choices on click. */
function PropertyMenu(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly trigger: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled}
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label={props.label}
            className="-ms-2 max-w-full justify-start"
          />
        }
      >
        {props.trigger}
      </MenuTrigger>
      <MenuPopup align="start">{props.children}</MenuPopup>
    </Menu>
  );
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="grid gap-2" aria-label={props.title}>
      <h3 className="text-sm font-semibold">{props.title}</h3>
      {props.children}
    </section>
  );
}

function Activity(props: {
  readonly events: ReadonlyArray<KanbanCardEvent>;
  readonly columnName: (id: string) => string;
}) {
  if (props.events.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>;
  }
  return (
    <ol className="grid gap-3">
      {props.events.map((event) => {
        const agent = event.actor !== "user";
        const Icon = agent ? BotIcon : UserIcon;
        const who =
          event.actor === "user"
            ? "You"
            : event.actor.startsWith("agent:")
              ? "Agent"
              : "Automation";
        return (
          <li key={event.id} className="flex gap-2.5 text-sm">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Icon className="size-3" />
            </span>
            <div className="grid min-w-0 flex-1 gap-1">
              <span className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{who}</span>
                {" · "}
                {formatRelativeTimeLabel(event.createdAt)}
              </span>
              {event.kind === "comment" ? (
                <p className="rounded-lg border border-border bg-card px-3 py-2 whitespace-pre-wrap">
                  {describeCardEvent(event, props.columnName)}
                </p>
              ) : (
                <span className="text-muted-foreground">
                  {describeCardEvent(event, props.columnName)}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Description(props: {
  readonly text: string;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onSave: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.text);
  const edit = () => {
    setDraft(props.text);
    setEditing(true);
  };
  if (editing) {
    return (
      <div className="grid gap-2">
        <Textarea
          autoFocus
          rows={8}
          aria-label="Description"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button size="xs" variant="outline" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button
            size="xs"
            onClick={() => {
              props.onSave(draft);
              setEditing(false);
            }}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }
  const empty = props.text.trim().length === 0;
  return (
    <div className="group relative -mx-2 rounded-lg px-2 py-1 hover:bg-accent/30">
      {empty ? (
        <p className="text-sm text-muted-foreground">
          {props.disabled ? "No description." : "Add a description…"}
        </p>
      ) : (
        <ChatMarkdown text={props.text} cwd={props.cwd} environmentId={props.environmentId} />
      )}
      {props.disabled ? null : (
        <span className="absolute end-1 top-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <Button size="xs" variant="ghost-muted" aria-label="Edit description" onClick={edit}>
            Edit
          </Button>
        </span>
      )}
      {empty && !props.disabled ? (
        <button
          type="button"
          aria-label="Add a description"
          className="absolute inset-0 cursor-text rounded-lg"
          onClick={edit}
        />
      ) : null}
    </div>
  );
}

export function KanbanCardDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly card: KanbanCard;
  readonly canEdit: boolean;
  readonly onOpenCard: (card: KanbanCard) => void;
  readonly onClose: () => void;
}) {
  const { environmentId, board, card } = props;
  const actions = useKanbanActions(environmentId);
  const query = useEnvironmentQuery(
    kanbanEnvironment.card({ environmentId, input: { cardId: card.id } }),
  );
  const refreshedFor = useRef(card.updatedAt);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- activity and derived thread links come from getCard, so a card change must refetch it
  useEffect(() => {
    if (refreshedFor.current === card.updatedAt) return;
    refreshedFor.current = card.updatedAt;
    query.refresh();
  }, [card.updatedAt, query]);

  const project = useProject({ environmentId, projectId: board.projectId });
  const archived = card.archivedAt !== null;
  const disabled = !props.canEdit;
  const [newLabel, setNewLabel] = useState(false);
  const [comment, setComment] = useState("");
  const column = board.columns.find((entry) => entry.id === card.columnId);
  const template = board.templates.find((entry) => entry.id === card.type);
  const columnName = (id: string) =>
    board.columns.find((entry) => entry.id === id)?.name ?? "a column";
  const result = query.data;
  const patch = (input: Omit<Parameters<typeof actions.updateCard>[0], "cardId">) =>
    actions.updateCard({ cardId: card.id, ...input } as Parameters<typeof actions.updateCard>[0]);

  const moveTo = async (columnId: KanbanColumnId) => {
    const target = board.columns.find((entry) => entry.id === columnId);
    const moved = await actions.moveCard({ cardId: card.id, columnId });
    const warning = target === undefined ? null : definitionOfDoneWarning(board, card, target);
    if (moved !== null && warning !== null) {
      toastManager.add({
        type: "warning",
        title: "Moved without meeting the definition of done",
        description: warning,
      });
    }
  };

  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      `Delete #${card.number}?\nThe card, its comments and its activity are removed for good.`,
      { variant: "destructive" },
    );
    if (confirmed === false) return;
    if ((await actions.deleteCard({ cardId: card.id })) !== null) props.onClose();
  };

  const toggleLabel = (labelId: KanbanLabelId) =>
    patch({
      labelIds: card.labelIds.includes(labelId)
        ? card.labelIds.filter((id) => id !== labelId)
        : [...card.labelIds, labelId],
    });

  const cardLabels = card.labelIds.flatMap(
    (id) => board.labels.find((entry) => entry.id === id) ?? [],
  );

  return (
    <Sheet open onOpenChange={(open) => !open && props.onClose()}>
      <SheetPopup className="sm:max-w-4xl">
        <div className="flex min-h-0 flex-1 flex-col" data-testid="kanban-card-detail">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b ps-6 pe-14">
            <SheetTitle className="sr-only">Card #{card.number}</SheetTitle>
            <span className="text-sm text-muted-foreground">
              {project?.title ?? board.title} <span className="px-0.5">/</span>{" "}
              <span className="tabular-nums">#{card.number}</span>
            </span>
            {archived ? <Badge variant="secondary">Archived</Badge> : null}
            {query.isPending ? <Spinner className="size-3" /> : null}
            {disabled ? null : (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label="Card actions"
                      className="ms-auto"
                    />
                  }
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    onClick={() =>
                      void (archived
                        ? actions.unarchiveCard({ cardId: card.id })
                        : actions
                            .archiveCard({ cardId: card.id })
                            .then((r) => r && props.onClose()))
                    }
                  >
                    {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                    {archived ? "Restore" : "Archive"}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={() => void remove()}>
                    <Trash2Icon />
                    Delete…
                  </MenuItem>
                </MenuPopup>
              </Menu>
            )}
          </header>

          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_18rem] md:overflow-hidden">
            <div className="grid content-start gap-7 p-6 md:overflow-y-auto">
              <QuietInput
                key={card.title}
                aria-label="Title"
                defaultValue={card.title}
                disabled={disabled}
                className="w-full text-xl leading-tight font-semibold"
                onBlur={(event) => {
                  const title = event.target.value.trim();
                  if (title.length > 0 && title !== card.title) void patch({ title });
                }}
                onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
              />

              <Description
                key={card.updatedAt}
                text={card.description}
                cwd={project?.workspaceRoot}
                environmentId={environmentId}
                disabled={disabled}
                onSave={(description) => void patch({ description })}
              />

              <KanbanChecklist
                title="Checklist"
                items={card.checklist}
                disabled={disabled}
                onChange={(checklist) => void patch({ checklist })}
              />
              <KanbanChecklist
                title="Acceptance criteria"
                items={card.acceptanceCriteria}
                disabled={disabled}
                onChange={(acceptanceCriteria) => void patch({ acceptanceCriteria })}
              />

              <Section title="Activity">
                {query.error !== null ? (
                  <p className="text-sm text-destructive-foreground">Could not load activity.</p>
                ) : (
                  <Activity events={result?.activity ?? []} columnName={columnName} />
                )}
                {disabled ? null : (
                  <div className="grid gap-2">
                    <Textarea
                      rows={3}
                      aria-label="Comment"
                      placeholder="Write a comment"
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                    />
                    <div className="flex justify-end">
                      <Button
                        size="xs"
                        disabled={comment.trim().length === 0}
                        onClick={async () => {
                          const body = comment.trim();
                          if ((await actions.commentOnCard({ cardId: card.id, body })) !== null) {
                            setComment("");
                            query.refresh();
                          }
                        }}
                      >
                        Comment
                      </Button>
                    </div>
                  </div>
                )}
              </Section>
            </div>

            <aside
              aria-label="Properties"
              className="grid content-start gap-1 border-t bg-muted/20 p-4 md:overflow-y-auto md:border-s md:border-t-0"
            >
              {archived ? null : (
                <PropertyRow label="Status">
                  <PropertyMenu
                    label="Status"
                    disabled={disabled}
                    trigger={
                      <>
                        {column ? <ColorDot color={column.color} /> : null}
                        {column?.name ?? "Unknown"}
                      </>
                    }
                  >
                    <MenuRadioGroup
                      value={card.columnId}
                      onValueChange={(value) => void moveTo(value as KanbanColumnId)}
                    >
                      {board.columns.map((entry) => (
                        <MenuRadioItem key={entry.id} value={entry.id}>
                          <ColorDot color={entry.color} /> {entry.name}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </PropertyMenu>
                </PropertyRow>
              )}
              <PropertyRow label="Priority">
                <PropertyMenu
                  label="Priority"
                  disabled={disabled}
                  trigger={
                    <>
                      <PriorityIcon priority={card.priority} />
                      <span className={card.priority === "none" ? "text-muted-foreground" : ""}>
                        {PRIORITY_LABELS[card.priority]}
                      </span>
                    </>
                  }
                >
                  <MenuRadioGroup
                    value={card.priority}
                    onValueChange={(value) => void patch({ priority: value as KanbanPriority })}
                  >
                    {KANBAN_PRIORITIES.map((value) => (
                      <MenuRadioItem key={value} value={value}>
                        <PriorityIcon priority={value} /> {PRIORITY_LABELS[value]}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </PropertyMenu>
              </PropertyRow>
              <PropertyRow label="Type">
                <PropertyMenu
                  label="Type"
                  disabled={disabled}
                  trigger={
                    template ? (
                      <>
                        <TemplateIcon template={template} />
                        {template.name}
                      </>
                    ) : (
                      <span className="text-muted-foreground">No type</span>
                    )
                  }
                >
                  <MenuRadioGroup
                    value={card.type ?? NO_TYPE}
                    onValueChange={(value) =>
                      void patch({ type: value === NO_TYPE ? null : (value as KanbanTemplateId) })
                    }
                  >
                    <MenuRadioItem value={NO_TYPE}>No type</MenuRadioItem>
                    {board.templates.map((entry) => (
                      <MenuRadioItem key={entry.id} value={entry.id}>
                        <TemplateIcon template={entry} /> {entry.name}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </PropertyMenu>
              </PropertyRow>
              <PropertyRow label="Labels">
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                  {cardLabels.map((label) => (
                    <LabelChip key={label.name} label={label} />
                  ))}
                  {disabled ? (
                    cardLabels.length === 0 ? (
                      <span className="text-sm text-muted-foreground">None</span>
                    ) : null
                  ) : (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label={cardLabels.length === 0 ? "Add labels" : "Edit labels"}
                          />
                        }
                      >
                        <PlusIcon />
                      </MenuTrigger>
                      <MenuPopup align="start">
                        {board.labels.map((label) => (
                          <MenuCheckboxItem
                            key={label.id}
                            checked={card.labelIds.includes(label.id)}
                            onCheckedChange={() => void toggleLabel(label.id)}
                          >
                            <LabelChip label={label} />
                          </MenuCheckboxItem>
                        ))}
                        {board.labels.length > 0 ? <MenuSeparator /> : null}
                        <MenuItem onClick={() => setNewLabel(true)}>New label…</MenuItem>
                      </MenuPopup>
                    </Menu>
                  )}
                </div>
              </PropertyRow>
              <PropertyRow label="Due date">
                <div className="flex items-center gap-1">
                  <QuietInput
                    type="date"
                    aria-label="Due date"
                    disabled={disabled}
                    value={dueAtToInput(card.dueAt)}
                    onChange={(event) => void patch({ dueAt: inputToDueAt(event.target.value) })}
                  />
                  {card.dueAt !== null && !disabled ? (
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label="Clear due date"
                      onClick={() => void patch({ dueAt: null })}
                    >
                      <XIcon />
                    </Button>
                  ) : null}
                </div>
              </PropertyRow>
              <PropertyRow label="Estimate">
                <div className="flex items-center gap-1">
                  <QuietInput
                    key={card.estimate?.value ?? "none"}
                    type="number"
                    min={0}
                    aria-label="Estimate"
                    placeholder="None"
                    className="w-16"
                    disabled={disabled}
                    defaultValue={card.estimate?.value ?? ""}
                    onBlur={(event) => {
                      const value = event.target.value === "" ? null : Number(event.target.value);
                      if (
                        value === (card.estimate?.value ?? null) ||
                        (value !== null && !(value >= 0))
                      )
                        return;
                      void patch({
                        estimate:
                          value === null ? null : { value, unit: card.estimate?.unit ?? "points" },
                      });
                    }}
                  />
                  {card.estimate ? (
                    <PropertyMenu
                      label="Estimate unit"
                      disabled={disabled}
                      trigger={card.estimate.unit}
                    >
                      <MenuRadioGroup
                        value={card.estimate.unit}
                        onValueChange={(unit) =>
                          card.estimate &&
                          void patch({
                            estimate: {
                              value: card.estimate.value,
                              unit: unit as "points" | "hours",
                            },
                          })
                        }
                      >
                        <MenuRadioItem value="points">points</MenuRadioItem>
                        <MenuRadioItem value="hours">hours</MenuRadioItem>
                      </MenuRadioGroup>
                    </PropertyMenu>
                  ) : null}
                </div>
              </PropertyRow>

              <div className="my-2 border-t" />
              <KanbanCardRelations
                card={card}
                boardCards={board.cards}
                disabled={disabled}
                onChange={(relations) => void patch(relations)}
                onOpenCard={props.onOpenCard}
              />

              <div className="my-2 border-t" />
              <KanbanLinkedAgents
                environmentId={environmentId}
                board={board}
                card={card}
                derived={result?.threads ?? []}
                disabled={disabled || archived}
              />
              {result && (result.costUsd !== null || result.durationMs !== null) ? (
                <>
                  <div className="my-2 border-t" />
                  {result.costUsd !== null ? (
                    <PropertyRow label="Cost">
                      <span className="text-sm tabular-nums">${result.costUsd.toFixed(2)}</span>
                    </PropertyRow>
                  ) : null}
                  {result.durationMs !== null ? (
                    <PropertyRow label="Agent time">
                      <span className="text-sm tabular-nums">
                        {formatCardDuration(result.durationMs)}
                      </span>
                    </PropertyRow>
                  ) : null}
                </>
              ) : null}
            </aside>
          </div>
        </div>
      </SheetPopup>
      {newLabel ? (
        <PromptDialog
          title="New label"
          label="Name"
          submitLabel="Create"
          onClose={() => setNewLabel(false)}
          onSubmit={async (name) => {
            const color = KANBAN_COLOR_NAMES[board.labels.length % KANBAN_COLOR_NAMES.length]!;
            const created = await actions.upsertLabel({ boardId: board.id, name, color });
            if (created?.labelId !== undefined) {
              await patch({ labelIds: [...card.labelIds, created.labelId] });
            }
          }}
        />
      ) : null}
    </Sheet>
  );
}
