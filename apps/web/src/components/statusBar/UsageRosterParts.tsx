import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatResetLabel, shortLimitName } from "@t3tools/client-runtime/state/usageReset";
import {
  groupSessionsByProject,
  splitSessions,
  type UsageSession,
  type UsageSessionState,
} from "@t3tools/client-runtime/state/usageSessions";
import type {
  ConsumerKind,
  ConsumerRef,
  InstanceSpendResult,
  ServerProviderUsageWindow,
  UsageResetDisplay,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SESSIONS_SHOWN = 8;
const SESSION_STATE: Record<UsageSessionState, { label: string; dot: string }> = {
  waiting: { label: "Waiting for you", dot: "bg-warning" },
  working: { label: "Working", dot: "bg-success" },
  recent: { label: "Recent", dot: "bg-muted-foreground/40" },
};

/** The limit's short name ("Fable"); the full label is in the tooltip. */
export function LimitName({ window }: { readonly window: ServerProviderUsageWindow }) {
  const name = shortLimitName(window);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="w-14 shrink-0 truncate text-3xs text-muted-foreground" />}
      >
        {name}
      </TooltipTrigger>
      <TooltipPopup side="top">{window.label}</TooltipPopup>
    </Tooltip>
  );
}

export function ResetText({
  window,
  now,
  mode,
  hour12,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly mode: UsageResetDisplay;
  readonly hour12: boolean | undefined;
}) {
  const reset = formatResetLabel({ window, mode, now, hour12 });
  if (reset === null) return <span className="shrink-0" />;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="min-w-12 shrink-0 whitespace-nowrap text-end text-3xs tabular-nums text-muted-foreground" />
        }
      >
        {reset.label}
      </TooltipTrigger>
      <TooltipPopup side="top">{reset.title}</TooltipPopup>
    </Tooltip>
  );
}

function SessionRow({ session }: { readonly session: UsageSession }) {
  const navigate = useNavigate();
  const state = SESSION_STATE[session.state];
  return (
    <button
      type="button"
      className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-start hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(session.environmentId, session.threadId)),
        })
      }
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", state.dot)} />
      <span className="min-w-0 flex-1 truncate text-2xs text-foreground">{session.title}</span>
      <span className="shrink-0 text-3xs text-muted-foreground">{state.label}</span>
      <span className="max-w-24 shrink-0 truncate text-3xs text-muted-foreground">
        {session.model}
      </span>
      <span className="w-12 shrink-0 text-end text-3xs tabular-nums text-muted-foreground">
        {session.elapsed}
      </span>
    </button>
  );
}

function SessionGroups({
  sessions,
  titles,
}: {
  readonly sessions: ReadonlyArray<UsageSession>;
  readonly titles: ReadonlyMap<string, string>;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? sessions : sessions.slice(0, SESSIONS_SHOWN);
  return (
    <div className="flex flex-col gap-1">
      {groupSessionsByProject(visible).map((group) => (
        <div key={group.projectKey} className="flex flex-col">
          <span className="truncate px-1 text-3xs font-medium text-muted-foreground">
            {titles.get(group.projectKey) ?? "Project"}
          </span>
          {group.sessions.map((session) => (
            <SessionRow key={`${session.environmentId}:${session.threadId}`} session={session} />
          ))}
        </div>
      ))}
      {sessions.length > visible.length ? (
        <button
          type="button"
          className="w-fit cursor-pointer px-1 text-3xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowAll(true)}
        >
          and {sessions.length - visible.length} more
        </button>
      ) : null}
    </div>
  );
}

function Disclosure({
  open,
  onToggle,
  children,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      className="flex w-fit cursor-pointer items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
      onClick={onToggle}
    >
      <ChevronRightIcon aria-hidden className={cn("size-3", open && "rotate-90")} />
      {children}
    </button>
  );
}

/** "Sessions · 2 running"; opened, running threads lead and finished ones sit in their own collapsed list. */
export function UsageSessionsList({
  sessions,
  titles,
}: {
  readonly sessions: ReadonlyArray<UsageSession>;
  readonly titles: ReadonlyMap<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [finishedOpen, setFinishedOpen] = useState(false);
  if (sessions.length === 0) return null;
  const { running, finished } = splitSessions(sessions);
  return (
    <div className="flex flex-col gap-0.5 pl-7.5">
      <Disclosure open={open} onToggle={() => setOpen(!open)}>
        {running.length > 0 ? `Sessions · ${running.length} running` : "Sessions"}
      </Disclosure>
      {open ? (
        <div className="flex flex-col gap-1">
          {running.length > 0 ? <SessionGroups sessions={running} titles={titles} /> : null}
          {finished.length > 0 ? (
            <>
              <Disclosure open={finishedOpen} onToggle={() => setFinishedOpen(!finishedOpen)}>
                {`Finished · ${finished.length}`}
              </Disclosure>
              {finishedOpen ? <SessionGroups sessions={finished} titles={titles} /> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const CONSUMER_KIND_LABEL: Record<ConsumerKind, string> = {
  thread: "Threads",
  assistant: "Assistants",
  groupMember: "Group members",
  subagent: "Subagents",
};

/** Names a consumer from what the client already holds; the server only sends ids. */
export function consumerLabel(
  consumer: ConsumerRef,
  names: {
    readonly thread: (threadId: string) => string | undefined;
    readonly assistant: (assistantId: string) => string | undefined;
  },
): string {
  switch (consumer.kind) {
    case "thread":
      return names.thread(consumer.threadId) ?? "Thread";
    case "assistant":
      return names.assistant(consumer.assistantId) ?? "Assistant";
    case "groupMember":
      return `${names.assistant(consumer.assistantId) ?? "Assistant"} in a group`;
    case "subagent":
      return `Subagent of ${names.thread(consumer.parentThreadId) ?? "a thread"}`;
  }
}

/** "Who used it": spend per kind, then the heaviest consumers, as the server aggregated them. */
export function ConsumerSpendList({
  spend,
  label,
  formatUsd,
  equivalent,
}: {
  readonly spend: Pick<InstanceSpendResult["instances"][number], "consumers" | "consumerKinds">;
  readonly label: (consumer: ConsumerRef) => string;
  readonly formatUsd: (value: number) => string;
  /** Subscription accounts: the dollars are API-priced, not billed. */
  readonly equivalent: boolean;
}) {
  const [open, setOpen] = useState(false);
  const kinds = spend.consumerKinds ?? [];
  const consumers = spend.consumers ?? [];
  if (kinds.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 pl-7.5">
      <Disclosure open={open} onToggle={() => setOpen(!open)}>
        {kinds.length > 1 ? `By consumer · ${kinds.length} kinds` : "By consumer"}
      </Disclosure>
      {open ? (
        <div className="flex flex-col gap-1 px-1">
          <span className="text-3xs text-muted-foreground tabular-nums">
            {kinds
              .map((row) => `${CONSUMER_KIND_LABEL[row.kind]} ${formatUsd(row.periodUsd)}`)
              .join(" · ")}
            {equivalent ? " · API-equivalent, last 30 days" : " · last 30 days"}
          </span>
          {consumers.map((row) => (
            <span
              key={`${row.consumer.kind}:${row.consumer.threadId}`}
              className="flex min-w-0 items-center gap-1.5 text-2xs"
            >
              <span className="min-w-0 flex-1 truncate text-foreground">{label(row.consumer)}</span>
              <span className="shrink-0 text-3xs text-muted-foreground">
                {CONSUMER_KIND_LABEL[row.consumer.kind]}
              </span>
              <span className="w-28 shrink-0 text-end text-3xs tabular-nums text-muted-foreground">
                {formatUsd(row.todayUsd)} today · {formatUsd(row.periodUsd)}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
