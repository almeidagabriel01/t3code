import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { teamLeaderBadge, teamSummary } from "@t3tools/client-runtime/assistantTeam";
import type {
  Assistant,
  AssistantTeam,
  AssistantTeamMessage,
  EnvironmentId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { ArrowRightIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useAssistantEntries, useAssistantTeamActivity } from "../../state/assistants";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { AssistantAvatar } from "./assistantPresentation";
import { assistantTeamActivityAtom } from "./assistantTeamState";

const REFRESH_MS = 5_000;
const COLLAPSED_CHARS = 280;

export function AssistantTeamActivityHost() {
  const target = useAtomValue(assistantTeamActivityAtom);
  const { teams } = useAssistantEntries();
  if (target === null) return null;
  const entry = teams.find(
    (candidate) =>
      candidate.environmentId === target.environmentId && candidate.team.id === target.teamId,
  );
  const close = () => appAtomRegistry.set(assistantTeamActivityAtom, null);
  if (entry === undefined) return null;
  return (
    <AssistantTeamActivityDialog
      environmentId={entry.environmentId}
      team={entry.team}
      onClose={close}
    />
  );
}

function MessageRow(props: {
  readonly message: AssistantTeamMessage;
  readonly team: AssistantTeam;
  readonly assistants: ReadonlyMap<string, Assistant>;
  readonly onOpen: (message: AssistantTeamMessage) => void;
}) {
  const { message, team } = props;
  const [expanded, setExpanded] = useState(false);
  const from = props.assistants.get(message.fromAssistantId);
  const to = props.assistants.get(message.toAssistantId);
  const long = message.text.length > COLLAPSED_CHARS;
  const shown = long && !expanded ? `${message.text.slice(0, COLLAPSED_CHARS)}…` : message.text;
  const who = (assistant: Assistant | undefined, id: string) => (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {assistant ? <AssistantAvatar assistant={assistant} /> : null}
      <span className="truncate font-medium">{assistant?.name ?? id}</span>
      {team.leaderId === id ? (
        <Badge variant="outline" size="sm">
          {teamLeaderBadge(team)}
        </Badge>
      ) : null}
    </span>
  );
  return (
    <li
      data-testid="team-message"
      className="flex flex-col gap-1.5 rounded-lg border border-foreground/12 px-3 py-2"
    >
      <div className="flex items-center gap-2 text-sm">
        {who(from, message.fromAssistantId)}
        <ArrowRightIcon aria-label="to" className="size-3.5 shrink-0 text-muted-foreground" />
        {who(to, message.toAssistantId)}
        <time
          dateTime={message.at}
          className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums"
        >
          {new Date(message.at).toLocaleString()}
        </time>
      </div>
      <p className="text-sm break-words whitespace-pre-wrap">{shown}</p>
      <div className="flex items-center gap-2">
        {long ? (
          <Button size="xs" variant="ghost-muted" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show less" : "Show more"}
          </Button>
        ) : null}
        {message.truncated ? (
          <span className="text-xs text-muted-foreground">Cut short. Open the thread for all.</span>
        ) : null}
        <Button
          size="xs"
          variant="ghost-muted"
          className="ms-auto"
          onClick={() => props.onOpen(message)}
        >
          <ExternalLinkIcon />
          Open thread
        </Button>
      </div>
    </li>
  );
}

function AssistantTeamActivityDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly team: AssistantTeam;
  readonly onClose: () => void;
}) {
  const router = useRouter();
  const { active, archived } = useAssistantEntries();
  const assistants = new Map(
    [...active, ...archived]
      .filter((entry) => entry.environmentId === props.environmentId)
      .map((entry) => [entry.assistant.id as string, entry.assistant]),
  );
  const query = useAssistantTeamActivity(props.environmentId, props.team);
  const { refresh } = query;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the server while the view is open
  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  const messages = query.data?.messages ?? [];
  const open = (message: AssistantTeamMessage) => {
    props.onClose();
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, message.toThreadId)),
    });
  };
  return (
    <Dialog open onOpenChange={(next) => !next && props.onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{props.team.name}</DialogTitle>
          <DialogDescription>
            {teamSummary(props.team, [...assistants.values()])}. Messages members sent each other,
            oldest first.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="mb-3 flex justify-end">
            <Button size="xs" variant="ghost-muted" onClick={refresh}>
              <RefreshCwIcon />
              Refresh
            </Button>
          </div>
          {query.isSuccess && messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No messages between members yet. They show up here when teammates talk.
            </p>
          ) : query.error !== null && !query.isSuccess ? (
            <p className="text-sm text-destructive-foreground">{query.error}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {messages.map((message) => (
                <MessageRow
                  key={message.messageId}
                  message={message}
                  team={props.team}
                  assistants={assistants}
                  onOpen={open}
                />
              ))}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
