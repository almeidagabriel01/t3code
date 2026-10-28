import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ProjectId,
  type ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, SquareIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery, useEnvironmentQuerySelector } from "../../state/query";
import { useProjects, useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { LivePortsList } from "./LivePortsList";
import {
  appBreakdown,
  attributeTerminalUsage,
  type AppProcessGroup,
  type ResourceUsage,
} from "./resourceUsage.logic";
import { formatMemory, sparklinePoints } from "./statusBar.logic";
import { useCloseTerminal } from "./useKillTarget";
import {
  useEnvironmentResources,
  useEnvironmentSnapshots,
  type EnvironmentResources,
} from "./useEnvironmentResources";

const APP_GROUP_LABEL: Record<AppProcessGroup, string> = {
  main: "Desktop main",
  renderer: "Renderers",
  server: "Server",
  other: "Other processes",
};
const UNATTRIBUTED = "Unattributed";

function UsageText({ usage }: { readonly usage: ResourceUsage | null }) {
  if (usage === null) return null;
  return (
    <span className="shrink-0 tabular-nums text-muted-foreground">
      {formatMemory(usage.rssBytes)} · {Math.round(usage.cpuPercent)}%
    </span>
  );
}

function SectionTitle({ children }: { readonly children: string }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

function HostTotals({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const host = useEnvironmentQuery(
    canRead ? serverEnvironment.hostResources({ environmentId, input: {} }) : null,
  ).data;
  if (host === null) return null;
  return (
    <div className="flex justify-between text-muted-foreground">
      <span>Host</span>
      <span className="tabular-nums">
        {host.cpuUtilization === null ? "" : `${Math.round(host.cpuUtilization * 100)}% CPU · `}
        {formatMemory(host.availableMemoryBytes)} free of {formatMemory(host.totalMemoryBytes)}
      </span>
    </div>
  );
}

const HISTORY_INPUT = { windowMs: 5 * 60_000, bucketMs: 15_000 } as const;
const HISTORY_REFRESH_MS = 15_000;
const SPARKLINE_WIDTH = 120;
const SPARKLINE_HEIGHT = 20;

function Sparkline({
  label,
  values,
}: {
  readonly label: string;
  readonly values: ReadonlyArray<number>;
}) {
  return (
    <svg
      role="img"
      aria-label={label}
      width={SPARKLINE_WIDTH}
      height={SPARKLINE_HEIGHT}
      className="text-muted-foreground"
    >
      <polyline
        points={sparklinePoints(values, SPARKLINE_WIDTH, SPARKLINE_HEIGHT)}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
      />
    </svg>
  );
}

function ResourceHistory({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const history = useEnvironmentQuery(
    canRead
      ? serverEnvironment.resourceTelemetryHistory({ environmentId, input: HISTORY_INPUT })
      : null,
  );
  const { refresh } = history;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer that re-reads server-retained history while the popover shows it
  useEffect(() => {
    const timer = setInterval(refresh, HISTORY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  const buckets = history.data?.buckets ?? [];
  if (buckets.length < 2) return null;
  return (
    <div className="flex items-center justify-between text-muted-foreground">
      <span>Last 5 min</span>
      <Sparkline label="Memory history" values={buckets.map((bucket) => bucket.maxRssBytes)} />
      <Sparkline label="CPU history" values={buckets.map((bucket) => bucket.avgCpuPercent)} />
    </div>
  );
}

function EnvironmentSection({
  resources,
  snapshot,
  showLabel,
  projectIdByThread,
  projectTitleById,
}: {
  readonly resources: EnvironmentResources;
  readonly snapshot: ResourceTelemetrySnapshot | null;
  readonly showLabel: boolean;
  readonly projectIdByThread: ReadonlyMap<string, ProjectId>;
  readonly projectTitleById: ReadonlyMap<ProjectId, string>;
}) {
  const { environmentId } = resources;
  const navigate = useNavigate();
  const { canClose, close } = useCloseTerminal(environmentId);
  const running = resources.terminals.filter((session) => session.state.status === "running");
  const rows = running.map((session) => ({
    session,
    key: `${session.target.threadId}:${session.target.terminalId}`,
    projectId: projectIdByThread.get(`${environmentId}:${session.target.threadId}`) ?? null,
  }));
  const attributed = attributeTerminalUsage(
    snapshot?.processes ?? [],
    rows.map(({ session, key, projectId }) => ({
      key,
      projectKey: projectId,
      pid: session.state.summary?.pid ?? null,
    })),
  );
  const groups = new Map<ProjectId | null, Array<(typeof rows)[number]>>();
  for (const row of rows) groups.set(row.projectId, [...(groups.get(row.projectId) ?? []), row]);
  const projectGroups = [...groups].toSorted(
    ([a], [b]) =>
      (attributed.projects.get(b)?.rssBytes ?? 0) - (attributed.projects.get(a)?.rssBytes ?? 0),
  );
  const app = snapshot === null ? null : appBreakdown(snapshot.processes, attributed.claimed);

  return (
    <div className="flex flex-col gap-3">
      {showLabel ? (
        <span className="text-sm font-medium text-foreground">{resources.label}</span>
      ) : null}
      <HostTotals environmentId={environmentId} />
      <ResourceHistory environmentId={environmentId} />
      <section className="flex flex-col gap-1">
        <SectionTitle>{`Terminals (${running.length})`}</SectionTitle>
        {running.length === 0 ? <span className="text-muted-foreground">None running.</span> : null}
        {projectGroups.map(([projectId, group]) => (
          <Collapsible key={projectId ?? UNATTRIBUTED}>
            <CollapsibleTrigger className="flex w-full items-center gap-1 text-left">
              <ChevronRightIcon
                aria-hidden
                className="size-3 transition-transform in-data-panel-open:rotate-90"
              />
              <span className="min-w-0 flex-1 truncate">
                {projectId === null
                  ? UNATTRIBUTED
                  : (projectTitleById.get(projectId) ?? UNATTRIBUTED)}
                <span className="text-muted-foreground"> ({group.length})</span>
              </span>
              <UsageText
                usage={snapshot === null ? null : (attributed.projects.get(projectId) ?? null)}
              />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <ul className="flex flex-col gap-0.5 ps-4 pt-0.5">
                {group.map(({ session, key }) => {
                  const summary = session.state.summary;
                  const label = summary?.label || session.target.terminalId;
                  return (
                    <li key={key} className="flex items-center gap-1">
                      <Button
                        variant="ghost-muted"
                        size="micro"
                        className="min-w-0 flex-1 justify-start"
                        onClick={() =>
                          void navigate({
                            to: "/$environmentId/$threadId",
                            params: buildThreadRouteParams(
                              scopeThreadRef(environmentId, session.target.threadId),
                            ),
                          })
                        }
                      >
                        <span className="truncate">
                          {label}
                          {summary ? ` · ${summary.cwd}` : ""}
                        </span>
                      </Button>
                      <span className="text-muted-foreground">
                        {session.state.hasRunningSubprocess ? "busy" : "idle"}
                      </span>
                      <UsageText
                        usage={snapshot === null ? null : (attributed.terminals.get(key) ?? null)}
                      />
                      {canClose ? (
                        <Button
                          variant="ghost-destructive"
                          size="icon-micro"
                          aria-label={`Close terminal ${label}`}
                          onClick={() =>
                            void close(
                              {
                                threadId: session.target.threadId,
                                terminalId: session.target.terminalId,
                              },
                              label,
                            )
                          }
                        >
                          <SquareIcon aria-hidden />
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </CollapsiblePanel>
          </Collapsible>
        ))}
      </section>
      {app === null ? null : (
        <section className="flex flex-col gap-0.5">
          <SectionTitle>App</SectionTitle>
          {[...app].map(([group, usage]) => (
            <div key={group} className="flex justify-between">
              <span className="text-muted-foreground">
                {APP_GROUP_LABEL[group]} ({usage.processCount})
              </span>
              <UsageText usage={usage} />
            </div>
          ))}
        </section>
      )}
      <section className="flex flex-col gap-1">
        <SectionTitle>{`Ports (${resources.ports.length})`}</SectionTitle>
        <LivePortsList
          environmentId={environmentId}
          ports={resources.ports}
          projectTitleById={projectTitleById}
        />
      </section>
    </div>
  );
}

function ResourceManager({
  resources,
}: {
  readonly resources: ReadonlyArray<EnvironmentResources>;
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const snapshots = useEnvironmentSnapshots(resources.map(({ environmentId }) => environmentId));
  const projectTitleById = new Map<ProjectId, string>(
    projects.map((project) => [project.id, project.title]),
  );
  const projectIdByThread = new Map(
    threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread.projectId] as const),
  );
  return (
    <div className="flex flex-col gap-4 text-xs">
      <span className="text-sm font-medium text-foreground">Resource manager</span>
      {resources.map((environment) => (
        <EnvironmentSection
          key={environment.environmentId}
          resources={environment}
          snapshot={snapshots.get(environment.environmentId) ?? null}
          showLabel={resources.length > 1}
          projectIdByThread={projectIdByThread}
          projectTitleById={projectTitleById}
        />
      ))}
    </div>
  );
}

const selectMemoryLabel = (result: AsyncResult.AsyncResult<ResourceTelemetrySnapshot, unknown>) => {
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  return snapshot === null ? null : formatMemory(snapshot.groups.allT3.currentRssBytes);
};

/** Telemetry emits about once a second; selecting the formatted label re-renders only when it changes. */
function PrimaryMemory() {
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const label = useEnvironmentQuerySelector(
    environmentId === null || !canRead
      ? null
      : serverEnvironment.resourceTelemetry({ environmentId, input: {} }),
    selectMemoryLabel,
  );
  return label === null ? null : <span>{label}</span>;
}

export function ResourceSegment() {
  const [open, setOpen] = useState(false);
  const resources = useEnvironmentResources(open);
  const terminalCount = resources.reduce(
    (sum, { terminals }) =>
      sum + terminals.filter((session) => session.state.status === "running").length,
    0,
  );
  const portCount = resources.reduce((sum, { ports }) => sum + ports.length, 0);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost-muted" size="micro" aria-label="Resource manager" />}
      >
        <span className="flex items-center gap-2 tabular-nums">
          <PrimaryMemory />
          <span>{terminalCount} term</span>
          <span>{portCount} ports</span>
        </span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="lg">
        <ResourceManager resources={resources} />
      </PopoverPopup>
    </Popover>
  );
}
