import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, KanbanCard, KanbanLinkedThread, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, ExternalLinkIcon, LinkIcon, PlusIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";

import { useQuietThreadShell } from "../../state/entities";
import { useProviderEntry } from "../../state/kanban";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { KanbanLinkThreadDialog } from "./KanbanLinkDialogs";
import { KanbanStartAgentDialog } from "./KanbanStartAgent";
import { useKanbanActions } from "./useKanban";

function AgentRow(props: {
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
  const entry = useProviderEntry(props.environmentId, shell?.providerInstanceId ?? "");
  const title = shell?.title ?? props.derived?.title ?? "Thread no longer available";
  const status = shell?.runtime?.status ?? props.derived?.status ?? null;
  const working = shell !== null && threadRuntimeIsActive(shell.runtime);
  return (
    <li className="group grid gap-1 rounded-md border border-border bg-card p-2">
      <div className="flex items-center gap-2">
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
          <BotIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        {working ? <Spinner className="size-3" aria-label="Working" /> : null}
      </div>
      <div className="flex items-center gap-1">
        {status ? (
          <Badge variant="secondary" size="sm">
            {status}
          </Badge>
        ) : null}
        {props.derived?.pullRequests.map((pullRequest) => (
          <Badge key={pullRequest.url} variant="outline" size="sm">
            PR{pullRequest.number === null ? "" : ` #${pullRequest.number}`}
            {pullRequest.state ? ` ${pullRequest.state}` : ""}
          </Badge>
        ))}
        <span className="ms-auto flex">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Open thread"
            disabled={shell === null}
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: props.environmentId, threadId: props.threadId },
              })
            }
          >
            <ExternalLinkIcon />
          </Button>
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
        </span>
      </div>
    </li>
  );
}

export function KanbanLinkedAgents(props: {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly card: KanbanCard;
  readonly derived: ReadonlyArray<KanbanLinkedThread>;
  readonly disabled: boolean;
}) {
  const { card } = props;
  const actions = useKanbanActions(props.environmentId);
  const [dialog, setDialog] = useState<"start" | "link" | null>(null);
  return (
    <section className="grid gap-2" aria-label="Linked agents">
      <div className="flex min-h-7 items-center justify-between text-xs text-muted-foreground">
        Agents
        {props.disabled ? null : (
          <span className="flex gap-0.5">
            <Button size="xs" variant="ghost-muted" onClick={() => setDialog("start")}>
              <PlusIcon />
              Start new
            </Button>
            <Button size="xs" variant="ghost-muted" onClick={() => setDialog("link")}>
              <LinkIcon />
              Link
            </Button>
          </span>
        )}
      </div>
      {card.linkedThreadIds.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No agent yet. Start one with this card as context, or link a thread you already have.
        </p>
      ) : (
        <ul className="grid gap-1.5">
          {card.linkedThreadIds.map((threadId) => (
            <AgentRow
              key={threadId}
              environmentId={props.environmentId}
              threadId={threadId}
              derived={props.derived.find((thread) => thread.threadId === threadId)}
              disabled={props.disabled}
              onUnlink={() => void actions.unlinkCardThread({ cardId: card.id, threadId })}
            />
          ))}
        </ul>
      )}
      {dialog === "start" ? (
        <KanbanStartAgentDialog
          environmentId={props.environmentId}
          board={props.board}
          card={card}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "link" ? (
        <KanbanLinkThreadDialog
          environmentId={props.environmentId}
          board={props.board}
          card={card}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </section>
  );
}
