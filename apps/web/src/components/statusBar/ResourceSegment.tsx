import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ProjectId,
  type ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MemoryStickIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery, useEnvironmentQuerySelector } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  addUsage,
  appBreakdown,
  attributeTerminalUsage,
  EMPTY_USAGE,
  type AppProcessGroup,
  type ResourceUsage,
} from "./resourceUsage.logic";
import { formatMemory, sparklinePoints } from "./statusBar.logic";
import { isStatusBarItemShown, STATUS_BAR_RESOURCE_ITEM } from "./statusBarItems.logic";
import { useCloseTerminal } from "./useKillTarget";
import {
  useEnvironmentResources,
  useEnvironmentSnapshots,
  type EnvironmentResources,
} from "./useEnvironmentResources";

type SortOption = "name" | "cpu" | "memory";

const APP_GROUP_LABEL: Record<AppProcessGroup, string> = {
  main: "Desktop main",
  renderer: "Renderers",
  server: "Server",
  other: "Other processes",
};
const UNATTRIBUTED = "Unattributed";

const CPU_COLUMN = "w-12 text-right";
const MEM_COLUMN = "w-16 text-right";
const GUTTER = "flex w-5 shrink-0 items-center justify-end";
const METRICS = "flex shrink-0 items-center tabular-nums";

const formatCpu = (cpuPercent: number) => `${Math.round(cpuPercent)}%`;

function Metrics({ usage }: { readonly usage: ResourceUsage | null }) {
  return (
    <div className={cn(METRICS, "text-2xs text-muted-foreground")}>
      <span className={CPU_COLUMN}>{usage === null ? "--" : formatCpu(usage.cpuPercent)}</span>
      <span className={MEM_COLUMN}>{usage === null ? "--" : formatMemory(usage.rssBytes)}</span>
    </div>
  );
}

function HostTotals({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const host = useEnvironmentQuery(
    canRead ? serverEnvironment.hostResources({ environmentId, input: {} }) : null,
  ).data;
  if (host === null) return null;
  return (
    <div className="flex justify-between px-3 py-1 text-2xs tabular-nums text-muted-foreground">
      <span>Host</span>
      <span>
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
    <div className="flex items-center justify-between px-3 py-1 text-2xs text-muted-foreground">
      <span>Last 5 min</span>
      <Sparkline label="Memory history" values={buckets.map((bucket) => bucket.maxRssBytes)} />
      <Sparkline label="CPU history" values={buckets.map((bucket) => bucket.avgCpuPercent)} />
    </div>
  );
}

function ChevronToggle({ open }: { readonly open: boolean }) {
  return open ? (
    <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground" />
  ) : (
    <ChevronRightIcon aria-hidden className="size-3 text-muted-foreground" />
  );
}

const byMetric =
  (sort: SortOption, usageOf: (key: string) => ResourceUsage | undefined) =>
  (a: string, b: string) => {
    if (sort === "name") return a.localeCompare(b);
    const left = usageOf(a) ?? EMPTY_USAGE;
    const right = usageOf(b) ?? EMPTY_USAGE;
    return sort === "cpu" ? right.cpuPercent - left.cpuPercent : right.rssBytes - left.rssBytes;
  };

function TerminalRow({
  label,
  detail,
  busy,
  usage,
  onOpen,
  onClose,
}: {
  readonly label: string;
  readonly detail: string;
  readonly busy: boolean;
  readonly usage: ResourceUsage | null;
  readonly onOpen: () => void;
  readonly onClose: (() => void) | null;
}) {
  return (
    <div className="group/row flex items-center gap-2 py-1.5 pl-10 pr-3 hover:bg-muted/60">
      <TerminalIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onOpen}
              className="min-w-0 flex-1 truncate text-start text-2xs text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
            />
          }
        >
          {label}
          {busy ? <span className="text-foreground/70"> · running</span> : null}
        </TooltipTrigger>
        <TooltipPopup side="top">{detail}</TooltipPopup>
      </Tooltip>
      <Metrics usage={usage} />
      <span
        className={cn(
          GUTTER,
          "opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100",
        )}
      >
        {onClose === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-destructive"
                  size="icon-micro"
                  aria-label={`End terminal ${label}`}
                  onClick={onClose}
                />
              }
            >
              <XIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="top">End terminal</TooltipPopup>
          </Tooltip>
        )}
      </span>
    </div>
  );
}

function ProjectGroup({
  title,
  count,
  usage,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly usage: ResourceUsage | null;
  readonly children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-t border-border/50">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center py-2 pl-2 pr-3 hover:bg-muted/50">
          <span className="flex w-5 shrink-0 items-center justify-center">
            <ChevronToggle open={open} />
          </span>
          <span className="min-w-0 flex-1 truncate text-start text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
            <span className="font-normal normal-case"> ({count})</span>
          </span>
          <Metrics usage={usage} />
          <span className={GUTTER} aria-hidden />
        </CollapsibleTrigger>
        <CollapsiblePanel animate={false}>
          <div className="border-t border-border/30">{children}</div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function EnvironmentSection({
  resources,
  snapshot,
  sort,
  label,
  projectIdByThread,
  projectTitleById,
}: {
  readonly resources: EnvironmentResources;
  readonly snapshot: ResourceTelemetrySnapshot | null;
  readonly sort: SortOption;
  readonly label: string | null;
  readonly projectIdByThread: ReadonlyMap<string, ProjectId>;
  readonly projectTitleById: ReadonlyMap<ProjectId, string>;
}) {
  const { environmentId } = resources;
  const navigate = useNavigate();
  const { canClose, close } = useCloseTerminal(environmentId);
  const [appOpen, setAppOpen] = useState(false);
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
  const titleOf = (projectId: ProjectId | null) =>
    projectId === null ? UNATTRIBUTED : (projectTitleById.get(projectId) ?? UNATTRIBUTED);
  const groupKeys = [...groups.keys()].map((projectId) => projectId ?? "");
  const orderedGroups = groupKeys
    .toSorted(
      byMetric(sort, (key) => attributed.projects.get(key === "" ? null : (key as ProjectId))),
    )
    .map((key) => (key === "" ? null : (key as ProjectId)));
  const app = snapshot === null ? null : appBreakdown(snapshot.processes, attributed.claimed);
  const appTotal = app === null ? null : [...app.values()].reduce(addUsage, EMPTY_USAGE);

  return (
    <div>
      {label === null ? null : (
        <div className="border-b border-border/50 bg-muted/30 px-3 py-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
      )}
      <HostTotals environmentId={environmentId} />
      <ResourceHistory environmentId={environmentId} />
      {orderedGroups.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">
          Nothing running right now
        </div>
      ) : null}
      {orderedGroups.map((projectId) => {
        const group = groups.get(projectId) ?? [];
        const ordered = group.toSorted((a, b) =>
          byMetric(sort, (key) => attributed.terminals.get(key))(a.key, b.key),
        );
        return (
          <ProjectGroup
            key={projectId ?? UNATTRIBUTED}
            title={titleOf(projectId)}
            count={group.length}
            usage={snapshot === null ? null : (attributed.projects.get(projectId) ?? null)}
          >
            {ordered.map(({ session, key }) => {
              const summary = session.state.summary;
              const name = summary?.label || session.target.terminalId;
              return (
                <TerminalRow
                  key={key}
                  label={name}
                  detail={summary?.cwd ?? name}
                  busy={session.state.hasRunningSubprocess}
                  usage={snapshot === null ? null : (attributed.terminals.get(key) ?? null)}
                  onOpen={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(environmentId, session.target.threadId),
                      ),
                    })
                  }
                  onClose={
                    canClose
                      ? () =>
                          void close(
                            {
                              threadId: session.target.threadId,
                              terminalId: session.target.terminalId,
                            },
                            name,
                          )
                      : null
                  }
                />
              );
            })}
          </ProjectGroup>
        );
      })}
      {app === null || appTotal === null ? null : (
        <div className="border-t border-border/50">
          <Collapsible open={appOpen} onOpenChange={setAppOpen}>
            <CollapsibleTrigger className="flex w-full items-center py-2 pl-2 pr-3 hover:bg-muted/50">
              <span className="flex w-5 shrink-0 items-center justify-center">
                <ChevronToggle open={appOpen} />
              </span>
              <span className="min-w-0 flex-1 truncate text-start text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                T3 Code
              </span>
              <Metrics usage={appTotal} />
              <span className={GUTTER} aria-hidden />
            </CollapsibleTrigger>
            <CollapsiblePanel animate={false}>
              <div className="border-t border-border/30">
                {[...app].map(([group, usage]) => (
                  <div key={group} className="flex items-center gap-2 py-1.5 pl-10 pr-3">
                    <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                      {APP_GROUP_LABEL[group]} ({usage.processCount})
                    </span>
                    <Metrics usage={usage} />
                    <span className={GUTTER} aria-hidden />
                  </div>
                ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </div>
      )}
    </div>
  );
}

function SortHeader({
  sort,
  onSort,
}: {
  readonly sort: SortOption;
  readonly onSort: (sort: SortOption) => void;
}) {
  const cell = (option: SortOption, className: string, text: string) => (
    <button
      type="button"
      aria-pressed={sort === option}
      onClick={() => onSort(option)}
      className={cn(
        className,
        "transition-colors hover:text-foreground",
        sort === option ? "font-semibold text-foreground" : "text-muted-foreground/80",
      )}
    >
      {text}
    </button>
  );
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border/50 bg-muted/30 px-3 py-1 text-3xs uppercase tracking-wide">
      {cell("name", "", "Name")}
      <div className="flex items-center gap-2">
        <div className={METRICS}>
          {cell("cpu", CPU_COLUMN, "CPU")}
          {cell("memory", MEM_COLUMN, "Memory")}
        </div>
        <span className={GUTTER} aria-hidden />
      </div>
    </div>
  );
}

function ResourceManager({
  resources,
}: {
  readonly resources: ReadonlyArray<EnvironmentResources>;
}) {
  const defaultSort = useClientSettings((settings) => settings.statusBarResourceSort);
  const [sort, setSort] = useState<SortOption>(defaultSort);
  const projects = useProjects();
  const threads = useThreadShells();
  const snapshots = useEnvironmentSnapshots(resources.map(({ environmentId }) => environmentId));
  const projectTitleById = new Map<ProjectId, string>(
    projects.map((project) => [project.id, project.title]),
  );
  const projectIdByThread = new Map(
    threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread.projectId] as const),
  );
  const totals = [...snapshots.values()].reduce<ResourceUsage>(
    (sum, { groups }) =>
      addUsage(sum, {
        rssBytes: groups.allT3.currentRssBytes,
        cpuPercent: groups.allT3.currentCpuPercent,
        processCount: groups.allT3.processCount,
      }),
    EMPTY_USAGE,
  );
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-2xs font-medium text-foreground">
        <MemoryStickIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate">Resource Manager</span>
      </div>
      {snapshots.size === 0 ? null : (
        <div className="flex items-baseline gap-3 border-b border-border px-3 py-2 text-xs tabular-nums">
          <span className="font-medium text-foreground">{formatCpu(totals.cpuPercent)}</span>
          <span className="text-muted-foreground/50">·</span>
          <span className="font-medium text-foreground">
            {formatMemory(totals.rssBytes)}{" "}
            <span className="font-normal text-muted-foreground">memory</span>
          </span>
        </div>
      )}
      <SortHeader sort={sort} onSort={setSort} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {resources.map((environment) => (
          <EnvironmentSection
            key={environment.environmentId}
            resources={environment}
            snapshot={snapshots.get(environment.environmentId) ?? null}
            sort={sort}
            label={resources.length > 1 ? environment.label : null}
            projectIdByThread={projectIdByThread}
            projectTitleById={projectTitleById}
          />
        ))}
      </div>
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
  return label === null ? null : (
    <>
      <span className="font-medium tabular-nums">{label}</span>
      <span className="text-muted-foreground/50">·</span>
    </>
  );
}

function ResourceSegmentBody() {
  const [open, setOpen] = useState(false);
  const resources = useEnvironmentResources();
  const terminalCount = resources.reduce(
    (sum, { terminals }) =>
      sum + terminals.filter((session) => session.state.status === "running").length,
    0,
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="status-bar" size="status-bar" aria-label="Resource Manager" />}
      >
        <MemoryStickIcon aria-hidden />
        <PrimaryMemory />
        <TerminalIcon aria-hidden />
        <span className="tabular-nums">{terminalCount}</span>
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        padding="none"
        className="h-[min(40rem,var(--available-height))] w-[26rem]"
      >
        <ResourceManager resources={resources} />
      </PopoverPopup>
    </Popover>
  );
}

export function ResourceSegment() {
  const hidden = useClientSettings((settings) => settings.statusBarHiddenItems);
  return isStatusBarItemShown(hidden, STATUS_BAR_RESOURCE_ITEM) ? <ResourceSegmentBody /> : null;
}
