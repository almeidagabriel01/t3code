import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import type {
  EnvironmentId,
  KanbanCard,
  KanbanCardEvent,
  KanbanColumnId,
  KanbanLabelId,
  KanbanLinkedThread,
  KanbanPriority,
  KanbanTemplateId,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, ArchiveRestoreIcon, PlusIcon, Trash2Icon, UnlinkIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useQuietThreadShell, useProject } from "../../state/entities";
import { kanbanEnvironment } from "../../state/kanban";
import { useEnvironmentQuery } from "../../state/query";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  definitionOfDoneWarning,
  describeCardEvent,
  dueAtToInput,
  inputToDueAt,
  KANBAN_PRIORITIES,
} from "./kanban.logic";
import { KanbanCardRelations } from "./KanbanCardRelations";
import { KanbanChecklist } from "./KanbanChecklist";
import { OptionSelect, PromptDialog } from "./kanbanDialogs";
import { LabelChip, KANBAN_COLOR_NAMES, PRIORITY_LABELS } from "./kanbanPresentation";
import { KanbanStartAgentButton } from "./KanbanStartAgent";
import { useKanbanActions } from "./useKanban";

const NO_TYPE = "__none__";

function LinkedThreadRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly derived: KanbanLinkedThread | undefined;
  readonly disabled: boolean;
  readonly onUnlink: () => void;
}) {
  const navigate = useNavigate();
  const shell = useQuietThreadShell({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const title = shell?.title ?? props.derived?.title ?? "Thread no longer available";
  return (
    <li className="flex items-center gap-2 text-sm">
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left hover:underline"
        disabled={shell === null}
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: props.environmentId, threadId: props.threadId },
          })
        }
      >
        {title}
      </button>
      {props.derived?.status ? (
        <Badge variant="secondary" size="sm">
          {props.derived.status}
        </Badge>
      ) : null}
      {props.derived?.pullRequests.map((pullRequest) => (
        <Badge key={pullRequest.url} variant="outline" size="sm">
          PR {pullRequest.number === null ? "" : `#${pullRequest.number}`} {pullRequest.state ?? ""}
        </Badge>
      ))}
      {props.disabled ? null : (
        <Button
          size="icon-xs"
          variant="ghost-destructive"
          aria-label="Unlink thread"
          onClick={props.onUnlink}
        >
          <UnlinkIcon />
        </Button>
      )}
    </li>
  );
}

function Activity(props: {
  readonly events: ReadonlyArray<KanbanCardEvent>;
  readonly columnName: (id: string) => string;
}) {
  return (
    <ol className="grid gap-2">
      {props.events.map((event) => (
        <li key={event.id} className="grid gap-0.5 text-sm">
          <span className="text-xs text-muted-foreground">
            {event.actor === "user" ? "You" : event.actor.replace(/^agent:/, "Agent ")} ·{" "}
            {new Date(event.createdAt).toLocaleString()}
          </span>
          {event.kind === "comment" ? (
            <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-2">
              {describeCardEvent(event, props.columnName)}
            </p>
          ) : (
            <span className="text-muted-foreground">
              {describeCardEvent(event, props.columnName)}
            </span>
          )}
        </li>
      ))}
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
  return (
    <section className="grid gap-2" aria-label="Description">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Description</h3>
        {props.disabled || editing ? null : (
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => {
              setDraft(props.text);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
      </div>
      {editing ? (
        <>
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
        </>
      ) : props.text.trim().length > 0 ? (
        <ChatMarkdown text={props.text} cwd={props.cwd} environmentId={props.environmentId} />
      ) : (
        <p className="text-sm text-muted-foreground">No description.</p>
      )}
    </section>
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
  const columnName = (id: string) =>
    board.columns.find((column) => column.id === id)?.name ?? "a column";
  const result = query.data;
  const patch = (input: Omit<Parameters<typeof actions.updateCard>[0], "cardId">) =>
    actions.updateCard({ cardId: card.id, ...input } as Parameters<typeof actions.updateCard>[0]);

  const moveTo = async (columnId: KanbanColumnId) => {
    const target = board.columns.find((column) => column.id === columnId);
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

  return (
    <Sheet open onOpenChange={(open) => !open && props.onClose()}>
      <SheetPopup className="sm:max-w-2xl">
        <div
          className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5"
          data-testid="kanban-card-detail"
        >
          <header className="grid gap-2">
            <SheetTitle className="sr-only">Card #{card.number}</SheetTitle>
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              #{card.number}
              {archived ? <Badge variant="secondary">Archived</Badge> : null}
              {query.isPending ? <Spinner className="size-3" /> : null}
            </div>
            <Input
              key={card.title}
              size="lg"
              aria-label="Title"
              defaultValue={card.title}
              disabled={disabled}
              onBlur={(event) => {
                const title = event.target.value.trim();
                if (title.length > 0 && title !== card.title) void patch({ title });
              }}
              onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
            />
            <div className="flex flex-wrap items-center gap-2">
              <KanbanStartAgentButton
                environmentId={environmentId}
                board={board}
                card={card}
                disabled={disabled || archived}
              />
              {disabled ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void (archived
                      ? actions.unarchiveCard({ cardId: card.id })
                      : actions.archiveCard({ cardId: card.id }).then((r) => r && props.onClose()))
                  }
                >
                  {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                  {archived ? "Restore" : "Archive"}
                </Button>
              )}
              {disabled ? null : (
                <Button size="sm" variant="destructive-outline" onClick={() => void remove()}>
                  <Trash2Icon />
                  Delete
                </Button>
              )}
            </div>
          </header>

          <div className="grid grid-cols-2 gap-3">
            {archived ? null : (
              <div className="grid gap-1.5">
                <Label>Column</Label>
                <OptionSelect
                  label="Column"
                  value={card.columnId}
                  disabled={disabled}
                  options={board.columns.map((column) => ({
                    value: column.id,
                    label: column.name,
                  }))}
                  onChange={(columnId) => void moveTo(columnId)}
                />
              </div>
            )}
            <div className="grid gap-1.5">
              <Label>Type</Label>
              <OptionSelect
                label="Type"
                value={card.type ?? NO_TYPE}
                disabled={disabled}
                options={[
                  { value: NO_TYPE, label: "No type" },
                  ...board.templates.map((template) => ({
                    value: template.id as string,
                    label: template.name,
                  })),
                ]}
                onChange={(value) =>
                  void patch({ type: value === NO_TYPE ? null : (value as KanbanTemplateId) })
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Priority</Label>
              <OptionSelect
                label="Priority"
                value={card.priority}
                disabled={disabled}
                options={KANBAN_PRIORITIES.map((value) => ({
                  value,
                  label: PRIORITY_LABELS[value],
                }))}
                onChange={(priority: KanbanPriority) => void patch({ priority })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kanban-due">Due date</Label>
              <Input
                id="kanban-due"
                type="date"
                size="sm"
                disabled={disabled}
                value={dueAtToInput(card.dueAt)}
                onChange={(event) => void patch({ dueAt: inputToDueAt(event.target.value) })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kanban-estimate">Estimate</Label>
              <div className="flex gap-2">
                <Input
                  id="kanban-estimate"
                  key={card.estimate?.value ?? "none"}
                  type="number"
                  size="sm"
                  min={0}
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
                <OptionSelect
                  label="Estimate unit"
                  value={card.estimate?.unit ?? "points"}
                  disabled={disabled || card.estimate === null}
                  options={[
                    { value: "points", label: "points" },
                    { value: "hours", label: "hours" },
                  ]}
                  onChange={(unit) =>
                    card.estimate && void patch({ estimate: { value: card.estimate.value, unit } })
                  }
                />
              </div>
            </div>
          </div>

          <section className="grid gap-2" aria-label="Labels">
            <h3 className="text-sm font-semibold">Labels</h3>
            <div className="flex flex-wrap items-center gap-1.5">
              {card.labelIds.flatMap((id) => {
                const label = board.labels.find((entry) => entry.id === id);
                return label ? [<LabelChip key={id} label={label} />] : [];
              })}
              {disabled ? null : (
                <Menu>
                  <MenuTrigger render={<Button size="xs" variant="ghost-muted" />}>
                    <PlusIcon />
                    Labels
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
          </section>

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

          <KanbanCardRelations
            card={card}
            boardCards={board.cards}
            disabled={disabled}
            onChange={(relations) => void patch(relations)}
            onOpenCard={props.onOpenCard}
          />

          <section className="grid gap-2" aria-label="Linked threads">
            <h3 className="text-sm font-semibold">Linked threads</h3>
            {card.linkedThreadIds.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agent works on this card yet.</p>
            ) : (
              <ul className="grid gap-1.5">
                {card.linkedThreadIds.map((threadId) => (
                  <LinkedThreadRow
                    key={threadId}
                    environmentId={environmentId}
                    threadId={threadId}
                    derived={result?.threads.find((thread) => thread.threadId === threadId)}
                    disabled={disabled}
                    onUnlink={() => void actions.unlinkCardThread({ cardId: card.id, threadId })}
                  />
                ))}
              </ul>
            )}
            {result && (result.costUsd !== null || result.durationMs !== null) ? (
              <p className="text-xs text-muted-foreground">
                {result.costUsd !== null ? `$${result.costUsd.toFixed(2)}` : null}
                {result.costUsd !== null && result.durationMs !== null ? " · " : null}
                {result.durationMs !== null
                  ? `${Math.round(result.durationMs / 60_000)} min`
                  : null}
              </p>
            ) : null}
          </section>

          <section className="grid gap-2" aria-label="Activity">
            <h3 className="text-sm font-semibold">Activity</h3>
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
          </section>
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
