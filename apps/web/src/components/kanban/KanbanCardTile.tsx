import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  KanbanCard,
  KanbanLabel,
  KanbanTemplate,
  ThreadId,
} from "@t3tools/contracts";
import { checklistProgress } from "@t3tools/client-runtime/state/kanbanLogic";
import { BanIcon, BotIcon, CalendarDaysIcon, LinkIcon, ListChecksIcon } from "lucide-react";
import { memo } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { useProviderEntry } from "../../state/kanban";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { formatDueLabel, isDueOverdue } from "./kanbanFormat";
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
  readonly projectLabel?: string | undefined;
  readonly onOpen: (card: KanbanCard) => void;
  /** Present when the viewer can edit; adds the agent quick action. */
  readonly onStartAgent?: ((card: KanbanCard) => void) | undefined;
  readonly onLinkThread?: ((card: KanbanCard) => void) | undefined;
}

export const KanbanCardTile = memo(function KanbanCardTile(props: KanbanCardTileProps) {
  const { card } = props;
  const template = props.templates.find((entry) => entry.id === card.type);
  const labels = card.labelIds.flatMap((id) => props.labels.find((label) => label.id === id) ?? []);
  const progress = checklistProgress(card.checklist);
  const now = Date.parse(useNowMinute());
  const overdue = card.dueAt !== null && isDueOverdue(card.dueAt, now);
  const hasFooter = progress.total > 0 || card.dueAt !== null || card.linkedThreadIds.length > 0;
  return (
    <div
      data-testid="kanban-card"
      data-card-id={card.id}
      className="group/card relative flex w-full flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left shadow-xs/5 hover:border-foreground/20 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring"
    >
      <div className="flex min-h-5 items-center gap-1.5 text-xs text-muted-foreground">
        {template ? <TemplateIcon template={template} /> : null}
        <span className="tabular-nums">#{card.number}</span>
        {props.projectLabel ? (
          <Badge variant="outline" size="sm">
            {props.projectLabel}
          </Badge>
        ) : null}
        <span className="ms-auto flex items-center gap-1.5">
          {card.blockedBy.length > 0 ? (
            <BanIcon aria-label="Blocked" className="size-3.5 text-warning-foreground" />
          ) : null}
          <PriorityIcon priority={card.priority} />
          {props.onStartAgent && props.onLinkThread ? (
            <span className="relative z-10 -my-1 -me-1 opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100 has-data-popup-open:opacity-100">
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
