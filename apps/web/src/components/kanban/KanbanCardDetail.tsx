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
  ActivityIcon,
  AlignLeftIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  BotIcon,
  CalendarDaysIcon,
  CircleCheckBigIcon,
  EllipsisIcon,
  ImagePlusIcon,
  ListChecksIcon,
  PaperclipIcon,
  PlusIcon,
  TagIcon,
  Trash2Icon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { attachmentImageMarkdown } from "@t3tools/shared/attachmentImageRefs";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { uploadStandaloneAttachment } from "../../lib/attachmentUploadQueue";
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
import {
  KanbanAttachmentDropOverlay,
  KanbanCardAttachments,
  KanbanCardCover,
  useCardAttachmentUploads,
} from "./KanbanCardAttachments";
import { KanbanCardRelations } from "./KanbanCardRelations";
import { KanbanChecklist } from "./KanbanChecklist";
import { KanbanLinkedAgents } from "./KanbanLinkedAgents";
import { KanbanStartAgentDialog } from "./KanbanStartAgent";
import { KanbanSubtasks } from "./KanbanSubtasks";
import { PromptDialog } from "./kanbanDialogs";
import {
  ColorDot,
  KANBAN_COLOR_NAMES,
  LabelChip,
  PRIORITY_LABELS,
  PriorityIcon,
  PropertyRow,
  QuietInput,
  SectionHeading,
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

function Avatar(props: { readonly icon: typeof UserIcon }) {
  const Icon = props.icon;
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}

function Activity(props: {
  readonly events: ReadonlyArray<KanbanCardEvent>;
  readonly columnName: (id: string) => string;
}) {
  if (props.events.length === 0) {
    return <p className="ps-10 text-sm text-muted-foreground">Nothing has happened yet.</p>;
  }
  return (
    <ol className="grid gap-4">
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
          <li key={event.id} className="flex gap-3 text-sm">
            <Avatar icon={Icon} />
            <div className="grid min-w-0 flex-1 gap-1 pt-0.5">
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

const imageFiles = (files: FileList | null) =>
  Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));

function Description(props: {
  readonly text: string;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onSave: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.text);
  const [uploading, setUploading] = useState(0);
  const cursor = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachImages = async (files: ReadonlyArray<File>) => {
    setUploading((count) => count + files.length);
    for (const file of files) {
      try {
        const { attachmentId } = await uploadStandaloneAttachment(props.environmentId, file);
        const ref = attachmentImageMarkdown(file.name || "image", attachmentId);
        setDraft((text) => {
          const at = Math.min(cursor.current, text.length);
          cursor.current = at + ref.length + 1;
          return `${text.slice(0, at)}${ref}\n${text.slice(at)}`;
        });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Could not attach image",
          description: cause instanceof Error ? cause.message : "Upload failed",
        });
      } finally {
        setUploading((count) => count - 1);
      }
    }
  };
  const edit = () => {
    setDraft(props.text);
    setEditing(true);
  };
  const save = () => {
    if (uploading > 0) return;
    if (draft !== props.text) props.onSave(draft);
    setEditing(false);
  };
  const empty = props.text.trim().length === 0;
  return (
    <section className="grid gap-2" aria-label="Description">
      <SectionHeading
        icon={AlignLeftIcon}
        title="Description"
        action={
          editing || props.disabled || empty ? null : (
            <Button size="xs" variant="ghost-muted" aria-label="Edit description" onClick={edit}>
              Edit
            </Button>
          )
        }
      />
      {editing ? (
        <div className="grid gap-2">
          <Textarea
            autoFocus
            rows={8}
            aria-label="Description"
            placeholder="Add more detail. Markdown works, and pasted screenshots land inline."
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onSelect={(event) => {
              cursor.current = event.currentTarget.selectionStart;
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setEditing(false);
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                save();
              }
            }}
            onPaste={(event) => {
              const images = imageFiles(event.clipboardData.files);
              if (images.length === 0) return;
              event.preventDefault();
              void attachImages(images);
            }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) event.preventDefault();
            }}
            onDrop={(event) => {
              const images = imageFiles(event.dataTransfer.files);
              if (images.length === 0) return;
              event.preventDefault();
              void attachImages(images);
            }}
          />
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              const images = imageFiles(event.currentTarget.files);
              event.currentTarget.value = "";
              void attachImages(images);
            }}
          />
          <div className="flex items-center justify-end gap-2">
            <span className="me-auto">
              <Button size="xs" variant="ghost-muted" onClick={() => fileInput.current?.click()}>
                {uploading > 0 ? <Spinner /> : <ImagePlusIcon />}
                Insert image
              </Button>
            </span>
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="xs" disabled={uploading > 0} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      ) : empty ? (
        props.disabled ? (
          <p className="text-sm text-muted-foreground">No description.</p>
        ) : (
          <button
            type="button"
            aria-label="Add a description"
            onClick={edit}
            className="min-h-16 cursor-text rounded-lg bg-muted/50 px-3 py-2.5 text-start text-sm text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            Add a more detailed description…
          </button>
        )
      ) : (
        <div
          className="-mx-2 rounded-lg px-2 py-1 hover:bg-accent/30"
          onDoubleClick={props.disabled ? undefined : edit}
        >
          <ChatMarkdown text={props.text} cwd={props.cwd} environmentId={props.environmentId} />
        </div>
      )}
    </section>
  );
}

function LabelMenuItems(props: {
  readonly board: KanbanBoardState;
  readonly card: KanbanCard;
  readonly onToggle: (labelId: KanbanLabelId) => void;
  readonly onNew: () => void;
}) {
  return (
    <>
      {props.board.labels.map((label) => (
        <MenuCheckboxItem
          key={label.id}
          checked={props.card.labelIds.includes(label.id)}
          onCheckedChange={() => props.onToggle(label.id)}
        >
          <LabelChip label={label} />
        </MenuCheckboxItem>
      ))}
      {props.board.labels.length > 0 ? <MenuSeparator /> : null}
      <MenuItem onClick={props.onNew}>New label…</MenuItem>
    </>
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
  const [startAgent, setStartAgent] = useState(false);
  const [comment, setComment] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const dueInput = useRef<HTMLInputElement>(null);
  const checklistInput = useRef<HTMLInputElement>(null);
  const column = board.columns.find((entry) => entry.id === card.columnId);
  const template = board.templates.find((entry) => entry.id === card.type);
  const columnName = (id: string) =>
    board.columns.find((entry) => entry.id === id)?.name ?? "a column";
  const result = query.data;
  const patch = (input: Omit<Parameters<typeof actions.updateCard>[0], "cardId">) =>
    actions.updateCard({ cardId: card.id, ...input } as Parameters<typeof actions.updateCard>[0]);
  const attachments = useCardAttachmentUploads({ environmentId, disabled, patch });

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
      `Delete #${card.number}?\nThe card, its comments, attachments and activity are removed for good.`,
      { variant: "destructive" },
    );
    if (confirmed === false) return;
    if ((await actions.deleteCard({ cardId: card.id })) !== null) props.onClose();
  };

  const toggleLabel = (labelId: KanbanLabelId) =>
    void patch({
      labelIds: card.labelIds.includes(labelId)
        ? card.labelIds.filter((id) => id !== labelId)
        : [...card.labelIds, labelId],
    });

  const cardLabels = card.labelIds.flatMap(
    (id) => board.labels.find((entry) => entry.id === id) ?? [],
  );

  const openDueDate = () => {
    const input = dueInput.current;
    if (input === null) return;
    input.focus();
    try {
      input.showPicker();
    } catch {
      // Some engines refuse showPicker outside a direct gesture; focus is enough there.
    }
  };

  const postComment = async () => {
    const body = comment.trim();
    if (body.length === 0) return;
    if ((await actions.commentOnCard({ cardId: card.id, body })) !== null) {
      setComment("");
      query.refresh();
    }
  };

  return (
    <Sheet open onOpenChange={(open) => !open && props.onClose()}>
      <SheetPopup className="sm:max-w-4xl" {...attachments.dropHandlers}>
        {attachments.dragging ? <KanbanAttachmentDropOverlay /> : null}
        <div className="flex min-h-0 flex-1 flex-col" data-testid="kanban-card-detail">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b ps-6 pe-14">
            <SheetTitle className="sr-only">Card #{card.number}</SheetTitle>
            <nav
              aria-label="Breadcrumb"
              className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground"
            >
              <span className="truncate">{project?.title ?? board.title}</span>
              <span aria-hidden className="text-muted-foreground/50">
                /
              </span>
              {column ? (
                <span className="inline-flex shrink-0 items-center gap-1.5">
                  <ColorDot color={column.color} />
                  {column.name}
                </span>
              ) : null}
              <span aria-hidden className="text-muted-foreground/50">
                ·
              </span>
              <span className="shrink-0 tabular-nums">#{card.number}</span>
            </nav>
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
            <div className="grid content-start gap-8 px-6 pt-5 pb-10 md:overflow-y-auto">
              {card.coverAttachmentId !== null ? (
                <KanbanCardCover
                  environmentId={environmentId}
                  card={card}
                  className="max-h-45 w-full rounded-xl border border-border bg-muted object-cover"
                />
              ) : null}

              <div className="grid gap-3">
                <QuietInput
                  key={card.title}
                  aria-label="Title"
                  defaultValue={card.title}
                  disabled={disabled}
                  className="w-full text-2xl leading-tight font-semibold tracking-tight"
                  onBlur={(event) => {
                    const title = event.target.value.trim();
                    if (title.length > 0 && title !== card.title) void patch({ title });
                  }}
                  onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                />
                {disabled ? null : (
                  <div role="toolbar" aria-label="Quick actions" className="flex flex-wrap gap-1.5">
                    <Menu>
                      <MenuTrigger render={<Button size="xs" variant="outline" />}>
                        <TagIcon />
                        Labels
                      </MenuTrigger>
                      <MenuPopup align="start">
                        <LabelMenuItems
                          board={board}
                          card={card}
                          onToggle={toggleLabel}
                          onNew={() => setNewLabel(true)}
                        />
                      </MenuPopup>
                    </Menu>
                    <Button size="xs" variant="outline" onClick={openDueDate}>
                      <CalendarDaysIcon />
                      Dates
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => checklistInput.current?.focus()}
                    >
                      <ListChecksIcon />
                      Checklist
                    </Button>
                    <Button size="xs" variant="outline" onClick={() => picker.current?.click()}>
                      <PaperclipIcon />
                      Attach
                    </Button>
                    {archived ? null : (
                      <Button size="xs" variant="outline" onClick={() => setStartAgent(true)}>
                        <BotIcon />
                        Agent
                      </Button>
                    )}
                  </div>
                )}
              </div>

              <Description
                key={card.description}
                text={card.description}
                cwd={project?.workspaceRoot}
                environmentId={environmentId}
                disabled={disabled}
                onSave={(description) => void patch({ description })}
              />

              <KanbanCardAttachments
                environmentId={environmentId}
                card={card}
                disabled={disabled}
                uploads={attachments.uploads}
                onAddFiles={attachments.addFiles}
                onRetry={attachments.retry}
                onDiscard={attachments.discard}
                patch={patch}
                pickerRef={picker}
              />

              {archived ? null : (
                <KanbanSubtasks
                  environmentId={environmentId}
                  board={board}
                  card={card}
                  disabled={disabled}
                  onOpenCard={props.onOpenCard}
                />
              )}

              <KanbanChecklist
                title="Checklist"
                icon={ListChecksIcon}
                items={card.checklist}
                disabled={disabled}
                addRef={checklistInput}
                onChange={(checklist) => void patch({ checklist })}
              />
              <KanbanChecklist
                title="Acceptance criteria"
                icon={CircleCheckBigIcon}
                items={card.acceptanceCriteria}
                disabled={disabled}
                onChange={(acceptanceCriteria) => void patch({ acceptanceCriteria })}
              />

              <section className="grid gap-4" aria-label="Activity">
                <SectionHeading icon={ActivityIcon} title="Activity" />
                {disabled ? null : (
                  <div className="flex gap-3">
                    <Avatar icon={UserIcon} />
                    <div className="grid min-w-0 flex-1 gap-2">
                      <Textarea
                        rows={2}
                        aria-label="Comment"
                        placeholder="Write a comment…"
                        value={comment}
                        onChange={(event) => setComment(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            void postComment();
                          }
                        }}
                      />
                      {comment.trim().length > 0 ? (
                        <div className="flex justify-end">
                          <Button size="xs" onClick={() => void postComment()}>
                            Comment
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
                {query.error !== null ? (
                  <p className="text-sm text-destructive-foreground">Could not load activity.</p>
                ) : (
                  <Activity events={result?.activity ?? []} columnName={columnName} />
                )}
              </section>
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
                        <LabelMenuItems
                          board={board}
                          card={card}
                          onToggle={toggleLabel}
                          onNew={() => setNewLabel(true)}
                        />
                      </MenuPopup>
                    </Menu>
                  )}
                </div>
              </PropertyRow>
              <PropertyRow label="Due date">
                <div className="flex items-center gap-1">
                  <QuietInput
                    ref={dueInput}
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
      {startAgent ? (
        <KanbanStartAgentDialog
          environmentId={environmentId}
          board={board}
          cards={[card]}
          onClose={() => setStartAgent(false)}
        />
      ) : null}
    </Sheet>
  );
}
