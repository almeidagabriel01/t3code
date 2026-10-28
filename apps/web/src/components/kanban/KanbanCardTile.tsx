import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  KanbanCard,
  KanbanLabel,
  KanbanTemplate,
  ThreadId,
} from "@t3tools/contracts";
import { BanIcon, CalendarDaysIcon, ListChecksIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useProviderEntry } from "../../state/kanban";
import { useQuietThreadShell } from "../../state/entities";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import { Spinner } from "../ui/spinner";
import { checklistProgress, isOverdue } from "./kanban.logic";
import { LabelChip, PriorityIcon, TemplateIcon } from "./kanbanPresentation";

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
      {entry ? (
        <ProviderInstanceIcon
          driverKind={entry.driverKind}
          displayName={entry.displayName}
          accentColor={entry.accentColor}
          acpRegistryAgentId={entry.acpRegistryAgentId}
          acpRegistryIconUrl={entry.acpRegistryIconUrl}
          size="compact"
        />
      ) : null}
      {working ? <Spinner className="size-3" aria-label="Agent working" /> : null}
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
}

export const KanbanCardTile = memo(function KanbanCardTile(props: KanbanCardTileProps) {
  const { card } = props;
  const template = props.templates.find((entry) => entry.id === card.type);
  const labels = card.labelIds.flatMap((id) => props.labels.find((label) => label.id === id) ?? []);
  const progress = checklistProgress(card.checklist);
  const overdue = isOverdue(card, Date.parse(useNowMinute()));
  return (
    <button
      type="button"
      data-testid="kanban-card"
      data-card-id={card.id}
      onClick={() => props.onOpen(card)}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5 text-left text-sm shadow-xs/5 outline-none hover:border-ring/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
    >
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {template ? <TemplateIcon template={template} /> : null}
        <span>#{card.number}</span>
        {props.projectLabel ? (
          <Badge variant="outline" size="sm">
            {props.projectLabel}
          </Badge>
        ) : null}
        <span className="ms-auto flex items-center gap-1">
          <PriorityIcon priority={card.priority} />
          {card.blockedBy.length > 0 ? (
            <Badge variant="warning" size="sm">
              <BanIcon className="size-3" />
              Blocked
            </Badge>
          ) : null}
        </span>
      </span>
      <span className="line-clamp-3 font-medium text-foreground">{card.title}</span>
      {labels.length > 0 ? (
        <span className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
        </span>
      ) : null}
      {progress.total > 0 || card.dueAt !== null || card.linkedThreadIds.length > 0 ? (
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {progress.total > 0 ? (
            <span className="inline-flex items-center gap-1">
              <ListChecksIcon className="size-3.5" />
              {progress.done}/{progress.total}
            </span>
          ) : null}
          {card.dueAt !== null ? (
            <span
              className={cn(
                "inline-flex items-center gap-1",
                overdue && "text-destructive-foreground",
              )}
            >
              <CalendarDaysIcon className="size-3.5" />
              {new Date(card.dueAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
          ) : null}
          <span className="ms-auto flex items-center gap-1.5">
            {card.linkedThreadIds.map((threadId) => (
              <LinkedAgent key={threadId} environmentId={props.environmentId} threadId={threadId} />
            ))}
          </span>
        </span>
      ) : null}
    </button>
  );
});
