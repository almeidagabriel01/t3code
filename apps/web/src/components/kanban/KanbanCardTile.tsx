import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  KanbanCard,
  KanbanLabel,
  KanbanTemplate,
  ThreadId,
} from "@t3tools/contracts";
import { checklistProgress } from "@t3tools/client-runtime/state/kanbanLogic";
import {
  BanIcon,
  BotIcon,
  CalendarDaysIcon,
  CornerDownRightIcon,
  LinkIcon,
  ListChecksIcon,
  ListTreeIcon,
  PaperclipIcon,
  PencilIcon,
} from "lucide-react";
import { memo } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { useProviderEntry } from "../../state/kanban";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { KanbanCardCover } from "./KanbanCardAttachments";
import {
  KanbanProjectBadge,
  projectAccentClassName,
  type KanbanProjectInfo,
} from "./KanbanProjectBadge";
import { formatDueLabel, isDueOverdue } from "./kanbanFormat";
import type { QuickEditTarget } from "./KanbanQuickEdit";
import { useKanbanCanEdit } from "./useKanban";
import { LabelChip, PriorityIcon, ProgressBar, TemplateIcon } from "./kanbanPresentation";

const LinkedAgent = memo(function LinkedAgent(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const shell = useQuietThreadShell({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const entry = useProviderEntry(props.environmentId, shell?.providerInstanceId ?? "");
  if (shell === null) return null;
  const working = threadRuntimeIsActive(shell.runtime);
  return (
    <span className="inline-flex items-center gap-1">
      {working ? <Spinner className="size-3" aria-label="Agent working" /> : null}
      {entry ? (
        <ProviderInstanceIcon
          driverKind={entry.driverKind}
          displayName={entry.displayName}
          accentColor={entry.accentColor}
          acpRegistryAgentId={entry.acpRegistryAgentId}
          acpRegistryIconUrl={entry.acpRegistryIconUrl}
          size="compact"
        />
      ) : (
        <BotIcon className="size-3.5 text-muted-foreground" />
      )}
    </span>
  );
});

export interface KanbanCardTileProps {
  readonly card: KanbanCard;
  readonly environmentId: EnvironmentId;
  readonly labels: ReadonlyArray<KanbanLabel>;
  readonly templates: ReadonlyArray<KanbanTemplate>;
  readonly project?: KanbanProjectInfo | undefined;
  /** The accent strip shows whenever `project` is set; the badge row only where projects are mixed. */
  readonly showProjectBadge?: boolean | undefined;
  readonly subtasksDone?: number | undefined;
  readonly subtasksTotal?: number | undefined;
  readonly parentNumber?: number | undefined;
  readonly parentTitle?: string | undefined;
  readonly onOpen: (card: KanbanCard) => void;
  /** Present when the viewer can edit; adds the agent quick action. */
  readonly onStartAgent?: ((card: KanbanCard) => void) | undefined;
  readonly onLinkThread?: ((card: KanbanCard) => void) | undefined;
  /** Shown only where the viewer can edit the card's environment. */
  readonly onQuickEdit?: ((target: QuickEditTarget) => void) | undefined;
}

export const KanbanCardTile = memo(function KanbanCardTile(props: KanbanCardTileProps) {
  const { card } = props;
  const template = props.templates.find((entry) => entry.id === card.type);
  const labels = card.labelIds.flatMap((id) => props.labels.find((label) => label.id === id) ?? []);
  const progress = checklistProgress(card.checklist);
  const now = Date.parse(useNowMinute());
  const overdue = card.dueAt !== null && isDueOverdue(card.dueAt, now);
  const subtasksTotal = props.subtasksTotal ?? 0;
  const canQuickEdit = useKanbanCanEdit(props.environmentId) && props.onQuickEdit !== undefined;
  const hasFooter =
    progress.total > 0 ||
    subtasksTotal > 0 ||
    card.dueAt !== null ||
    card.attachments.length > 0 ||
    card.linkedThreadIds.length > 0;
  return (
    <div
      data-testid="kanban-card"
      data-card-id={card.id}
      className="group/card relative flex w-full flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card p-3 text-left shadow-xs/5 hover:border-foreground/20 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring"
    >
      {props.project ? (
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-0 start-0 w-0.5 bg-current",
            projectAccentClassName(props.project),
          )}
        />
      ) : null}
      {card.coverAttachmentId !== null ? (
        <KanbanCardCover
          environmentId={props.environmentId}
          card={card}
          className="-mx-3 -mt-3 h-28 w-[calc(100%+1.5rem)] max-w-none border-b border-border bg-muted object-cover"
        />
      ) : null}
      {props.project && props.showProjectBadge ? <KanbanProjectBadge info={props.project} /> : null}
      <div className="flex min-h-5 items-center gap-1.5 text-xs text-muted-foreground">
        {template ? <TemplateIcon template={template} /> : null}
        <span className="tabular-nums">#{card.number}</span>
        <span className="ms-auto flex items-center gap-1.5">
          {card.blockedBy.length > 0 ? (
            <BanIcon aria-label="Blocked" className="size-3.5 text-warning-foreground" />
          ) : null}
          <PriorityIcon priority={card.priority} />
          {canQuickEdit || (props.onStartAgent && props.onLinkThread) ? (
            <span className="relative z-10 -my-1 -me-1 flex opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100 has-data-popup-open:opacity-100">
              {canQuickEdit ? (
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Quick edit #${card.number}`}
                  onClick={(event) => {
                    const anchor = event.currentTarget.closest<HTMLElement>(
                      '[data-testid="kanban-card"]',
                    );
                    if (anchor) props.onQuickEdit?.({ cardId: card.id, anchor });
                  }}
                >
                  <PencilIcon />
                </Button>
              ) : null}
              {props.onStartAgent && props.onLinkThread ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Agent actions for #${card.number}`}
                      />
                    }
                  >
                    <BotIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem onClick={() => props.onStartAgent?.(card)}>
                      <BotIcon />
                      Start new agent…
                    </MenuItem>
                    <MenuItem onClick={() => props.onLinkThread?.(card)}>
                      <LinkIcon />
                      Link existing thread…
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              ) : null}
            </span>
          ) : null}
        </span>
      </div>
      <button
        type="button"
        onClick={() => props.onOpen(card)}
        className="line-clamp-3 cursor-pointer text-left text-sm leading-snug font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-lg"
      >
        {card.title}
      </button>
      {props.parentNumber !== undefined ? (
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <CornerDownRightIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">
            #{props.parentNumber} {props.parentTitle}
          </span>
        </span>
      ) : null}
      {labels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
        </div>
      ) : null}
      {hasFooter ? (
        <div className="flex min-h-5 items-center gap-3 text-xs text-muted-foreground">
          {progress.total > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <ListChecksIcon className="size-3.5" />
              <ProgressBar done={progress.done} total={progress.total} />
              <span className="tabular-nums">
                {progress.done}/{progress.total}
              </span>
            </span>
          ) : null}
          {subtasksTotal > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <ListTreeIcon aria-label="Subtasks" className="size-3.5" />
              <span className="tabular-nums">
                {props.subtasksDone ?? 0}/{subtasksTotal}
              </span>
            </span>
          ) : null}
          {card.dueAt !== null ? (
            <span
              className={cn(
                "inline-flex items-center gap-1",
                overdue && "font-medium text-destructive-foreground",
              )}
            >
              <CalendarDaysIcon className="size-3.5" />
              {formatDueLabel(card.dueAt, now)}
            </span>
          ) : null}
          {card.attachments.length > 0 ? (
            <span className="inline-flex items-center gap-1">
              <PaperclipIcon aria-label="Attachments" className="size-3.5" />
              <span className="tabular-nums">{card.attachments.length}</span>
            </span>
          ) : null}
          <span className="ms-auto flex items-center gap-1.5">
            {card.linkedThreadIds.map((threadId) => (
              <LinkedAgent key={threadId} environmentId={props.environmentId} threadId={threadId} />
            ))}
          </span>
        </div>
      ) : null}
    </div>
  );
});
