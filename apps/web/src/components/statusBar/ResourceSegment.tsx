import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ProjectId,
  type ResourceTelemetryProcess,
  type ResourceTelemetrySnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  AppWindowIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CpuIcon,
  ListOrderedIcon,
  PauseIcon,
  MemoryStickIcon,
  MonitorIcon,
  ServerIcon,
  SmartphoneIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { createContext, use, useEffect, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useDeviceState } from "../../state/device";
import { useHeavyQueue } from "../../state/heavyQueue";
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
import { HeavyQueueBody } from "./HeavyQueueBody";
import { processLabel } from "./processLabel.logic";
import {
  addUsage,
  buildResourceTree,
  deviceShutdownTargets,
  EMPTY_USAGE,
  type AppProcessGroup,
  type DevicePlatform,
  type DeviceRow,
  type ResourceSort,
  type ResourceUsage,
} from "./resourceUsage.logic";
import { formatMemory, sparklinePoints } from "./statusBar.logic";
import { isStatusBarItemShown, STATUS_BAR_RESOURCE_ITEM } from "./statusBarItems.logic";
import { useCloseTerminal, useShutDownDevice } from "./useKillTarget";
import {
  useEnvironmentResources,
  useEnvironmentSnapshots,
  type EnvironmentResources,
} from "./useEnvironmentResources";

type SortOption = ResourceSort;

const APP_GROUP_LABEL: Record<AppProcessGroup, string> = {
  main: "Desktop main",
  renderer: "Renderers",
  server: "Server",
  other: "Other processes",
};
const APP_GROUP_ICON: Record<AppProcessGroup, typeof AppWindowIcon> = {
  main: AppWindowIcon,
  renderer: MonitorIcon,
  server: ServerIcon,
  other: CpuIcon,
};
const UNATTRIBUTED = "Unattributed";

const CPU_COLUMN = "w-12 text-right";
const MEM_COLUMN = "w-16 text-right";
const GUTTER = "flex w-5 shrink-0 items-center justify-end";
const METRICS = "flex shrink-0 items-center tabular-nums";

// Half a core; process CPU arrives as a share of the whole machine.
const HEAVY_CPU_PERCENT_OF_CORE = 50;
const HostCoresContext = createContext(1);
const HEAVY_RSS_BYTES = 1024 ** 3;

// Shares of the whole machine are small; one decimal keeps a busy process from reading as 0%.
const formatCpu = (cpuPercent: number) =>
  cpuPercent > 0 && cpuPercent < 10 ? `${cpuPercent.toFixed(1)}%` : `${Math.round(cpuPercent)}%`;
const CPU_SCALE_HINT = "Share of the whole machine: 100% means every CPU core is busy.";

function Metrics({ usage }: { readonly usage: ResourceUsage | null }) {
  return (
    <div className={cn(METRICS, "text-2xs text-muted-foreground")}>
      <span className={CPU_COLUMN}>{usage === null ? "--" : formatCpu(usage.cpuPercent)}</span>
      <span className={MEM_COLUMN}>{usage === null ? "--" : formatMemory(usage.rssBytes)}</span>
    </div>
  );
}

const SCOPE_HINT: Record<"mac" | "t3", string> = {
  mac: "Every app on this computer.",
  t3: "T3 Code and the agents and commands it runs.",
};

function FigureRow({
  scope,
  label,
  detail,
  cpuPercent,
  memory,
}: {
  readonly scope: "mac" | "t3";
  readonly label: string;
  readonly detail?: string;
  readonly cpuPercent: number | null;
  readonly memory: string;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-0.5 text-xs tabular-nums">
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 cursor-default truncate font-medium text-foreground" />}
        >
          {label}
          {detail === undefined ? null : (
            <span className="font-normal text-muted-foreground"> · {detail}</span>
          )}
        </TooltipTrigger>
        <TooltipPopup side="bottom" className="max-w-xs">
          {SCOPE_HINT[scope]} {CPU_SCALE_HINT}
        </TooltipPopup>
      </Tooltip>
      {/* Same columns as the process table below, so the figures read down its CPU and Memory. */}
      <div className="flex items-center gap-2">
        <div className={cn(METRICS, "text-foreground")}>
          <span className={CPU_COLUMN}>{cpuPercent === null ? "--" : formatCpu(cpuPercent)}</span>
          <span className={MEM_COLUMN}>{memory}</span>
        </div>
        <span className={GUTTER} aria-hidden />
      </div>
    </div>
  );
}

/** Whole machine and T3 side by side; T3 is a subset, so it never reads above the machine. */
function ResourceFigures({
  environmentId,
  t3,
}: {
  readonly environmentId: EnvironmentId;
  readonly t3: ResourceUsage | null;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const host = useEnvironmentQuery(
    canRead ? serverEnvironment.hostResources({ environmentId, input: {} }) : null,
  ).data;
  const macCpu = host?.cpuUtilization == null ? null : host.cpuUtilization * 100;
  return (
    <div className="border-b border-border py-1.5">
      {host === null || host === undefined ? null : (
        <FigureRow
          scope="mac"
          label="Mac"
          cpuPercent={macCpu}
          detail={`${formatMemory(host.totalMemoryBytes)} total`}
          memory={formatMemory(host.totalMemoryBytes - host.availableMemoryBytes)}
        />
      )}
      {t3 === null ? null : (
        <FigureRow
          scope="t3"
          label="T3"
          cpuPercent={macCpu === null ? t3.cpuPercent : Math.min(t3.cpuPercent, macCpu)}
          memory={formatMemory(t3.rssBytes)}
        />
      )}
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
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, HISTORY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  const buckets = history.data?.buckets ?? [];
  if (buckets.length < 2) return null;
  return (
    <div className="flex items-center justify-between px-3 py-1 text-2xs text-muted-foreground">
      <span>T3 · last 5 min</span>
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

const DEVICE_ICON: Record<DevicePlatform, typeof SmartphoneIcon> = {
  android: SmartphoneIcon,
  ios: SmartphoneIcon,
  tools: WrenchIcon,
};

function ProcessList({
  processes,
}: {
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
}) {
  const cores = use(HostCoresContext);
  return (
    <div>
      {processes.map((process) => {
        const heavy =
          process.cpuPercent * cores >= HEAVY_CPU_PERCENT_OF_CORE ||
          process.residentBytes >= HEAVY_RSS_BYTES;
        const label = processLabel(process);
        return (
          <div
            key={process.identity.pid}
            className="flex items-center gap-2 py-1 pl-16 pr-3 hover:bg-foreground/8"
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <div
                    data-heavy={heavy ? "" : undefined}
                    className={cn(
                      "flex min-w-0 flex-1 cursor-default items-baseline gap-2 text-2xs",
                      heavy ? "text-warning" : "text-muted-foreground",
                    )}
                  />
                }
              >
                <span className="max-w-[45%] shrink-0 truncate font-medium">{label}</span>
                <span dir="rtl" className="min-w-0 flex-1 truncate text-left opacity-70">
                  <bdi dir="ltr">{process.command}</bdi>
                </span>
              </TooltipTrigger>
              <TooltipPopup side="top" className="max-w-sm break-all">
                {process.command} · pid {process.identity.pid}
              </TooltipPopup>
            </Tooltip>
            <Metrics
              usage={{
                cpuPercent: process.cpuPercent,
                rssBytes: process.residentBytes,
                processCount: 1,
              }}
            />
            <span className={GUTTER} aria-hidden />
          </div>
        );
      })}
    </div>
  );
}

function UsageRow({
  icon,
  label,
  detail,
  suffix,
  usage,
  onOpen,
  closeLabel,
  onClose,
  processes,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly detail: string;
  readonly suffix?: string | null;
  readonly usage: ResourceUsage | null;
  /** Rows with nowhere to go render as plain text. */
  readonly onOpen: (() => void) | null;
  readonly closeLabel?: string;
  readonly onClose?: (() => void) | null;
  /** Rows with processes expand to list them; only an open row renders the list. */
  readonly processes?: ReadonlyArray<ResourceTelemetryProcess> | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const expandable = processes !== undefined && processes.length > 0;
  const text = (
    <>
      {label}
      {suffix ? <span className="text-foreground/70"> · {suffix}</span> : null}
    </>
  );
  return (
    <>
      <div
        className={cn(
          "group/row flex items-center gap-2 py-1.5 pr-3 hover:bg-foreground/8",
          expandable ? "pl-3" : "pl-10",
        )}
      >
        {expandable ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} processes of ${label}`}
            onClick={() => setExpanded((value) => !value)}
            className="flex w-5 shrink-0 cursor-pointer items-center justify-center self-stretch rounded-sm outline-none hover:bg-foreground/8 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <ChevronToggle open={expanded} />
          </button>
        ) : null}
        <span className="shrink-0 text-muted-foreground [&>svg]:size-3">{icon}</span>
        {onOpen === null ? (
          <span className="min-w-0 flex-1 truncate text-start text-2xs text-muted-foreground">
            {text}
          </span>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onOpen}
                  className="min-w-0 flex-1 cursor-pointer truncate rounded-sm text-start text-2xs text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
            >
              {text}
            </TooltipTrigger>
            <TooltipPopup side="top">{detail}</TooltipPopup>
          </Tooltip>
        )}
        <Metrics usage={usage} />
        <span
          className={cn(
            GUTTER,
            "opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100",
          )}
        >
          {onClose === null || onClose === undefined ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost-destructive"
                    size="icon-micro"
                    aria-label={`${closeLabel} ${label}`}
                    onClick={onClose}
                  />
                }
              >
                <XIcon aria-hidden />
              </TooltipTrigger>
              <TooltipPopup side="top">{closeLabel}</TooltipPopup>
            </Tooltip>
          )}
        </span>
      </div>
      {expandable && expanded ? <ProcessList processes={processes} /> : null}
    </>
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
  /** Omitted for groups whose rows have no usage, so the header shows no empty metrics. */
  readonly usage?: ResourceUsage | null;
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
          {usage === undefined ? null : <Metrics usage={usage} />}
          <span className={GUTTER} aria-hidden />
        </CollapsibleTrigger>
        <CollapsiblePanel animate={false}>
          <div className="border-t border-border/30">{children}</div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

interface ThreadInfo {
  readonly projectId: ProjectId;
  readonly title: string;
}

/** Rendered only while devices run, so the device state subscription stays closed otherwise. */
function DeviceGroup({
  environmentId,
  devices,
}: {
  readonly environmentId: EnvironmentId;
  readonly devices: ReadonlyArray<DeviceRow>;
}) {
  const { state } = useDeviceState(environmentId);
  const { canShutDown, shutDown } = useShutDownDevice(environmentId);
  const localHostIds = new Set<string>(
    state.hosts.flatMap((host) => (host.kind === "local" ? [host.id] : [])),
  );
  const total = devices.reduce((sum, device) => addUsage(sum, device.usage), EMPTY_USAGE);
  return (
    <ProjectGroup title="Devices" count={devices.length} usage={total}>
      {devices.map((device) => {
        const Icon = DEVICE_ICON[device.platform];
        const targets = deviceShutdownTargets(device, state.devices, localHostIds);
        return (
          <UsageRow
            key={device.key}
            icon={<Icon aria-hidden />}
            label={device.label}
            detail={device.label}
            usage={device.usage}
            processes={device.processes}
            onOpen={null}
            closeLabel="Shut down"
            onClose={
              canShutDown && targets.length > 0 ? () => void shutDown(targets, device.label) : null
            }
          />
        );
      })}
    </ProjectGroup>
  );
}

/** Renders nothing while the machine-wide heavy-work queue is empty and running. */
export function HeavyQueueGroup({
  environmentId,
  threadTitle,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadTitle: (threadId: string) => string | undefined;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { entries, paused } = useHeavyQueue(environmentId);
  if (entries.length === 0 && !paused) return null;
  return (
    <ProjectGroup title="Heavy work queue" count={entries.length}>
      <HeavyQueueBody
        environmentId={environmentId}
        threadTitle={threadTitle}
        onOpenThread={onOpenThread}
      />
    </ProjectGroup>
  );
}

export function EnvironmentSection({
  resources,
  snapshot,
  sort,
  label,
  threadInfo,
  projectTitleById,
}: {
  readonly resources: EnvironmentResources;
  readonly snapshot: ResourceTelemetrySnapshot | null;
  readonly sort: SortOption;
  readonly label: string | null;
  readonly threadInfo: ReadonlyMap<string, ThreadInfo>;
  readonly projectTitleById: ReadonlyMap<ProjectId, string>;
}) {
  const { environmentId } = resources;
  const navigate = useNavigate();
  const { canClose, close } = useCloseTerminal(environmentId);
  const [appOpen, setAppOpen] = useState(false);
  const infoOf = (threadId: string) => threadInfo.get(`${environmentId}:${threadId}`);
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  const sessions = new Map(
    resources.terminals
      .filter((session) => session.state.status === "running")
      .map((session) => [`${session.target.threadId}:${session.target.terminalId}`, session]),
  );
  const owners = snapshot?.owners ?? [];
  const tree = buildResourceTree({
    processes: snapshot?.processes ?? [],
    terminals: [...sessions].map(([key, session]) => ({
      key,
      name: session.state.summary?.label || session.target.terminalId,
      threadId: session.target.threadId,
      projectKey: infoOf(session.target.threadId)?.projectId ?? null,
      pid: session.state.summary?.pid ?? null,
    })),
    agents: owners.flatMap((owner) =>
      owner.kind === "agent" ? [{ pid: owner.pid, threadId: owner.threadId }] : [],
    ),
    hubPids: owners.flatMap((owner) => (owner.kind === "device-hub" ? [owner.pid] : [])),
    sort,
    projectOfThread: (threadId) => infoOf(threadId)?.projectId ?? null,
    projectTitle: (projectKey) =>
      projectKey === null
        ? UNATTRIBUTED
        : (projectTitleById.get(projectKey as ProjectId) ?? UNATTRIBUTED),
    threadTitle: (threadId) => infoOf(threadId)?.title || "Agent",
  });
  const app = snapshot === null ? null : tree.app;
  const appTotal =
    app === null ? null : app.reduce((sum, row) => addUsage(sum, row.usage), EMPTY_USAGE);

  return (
    <HostCoresContext value={snapshot?.cpuCount ?? 1}>
      <div>
        {label === null ? null : (
          <div className="border-b border-border/50 bg-muted/30 px-3 py-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
        )}
        <ResourceFigures
          environmentId={environmentId}
          t3={
            snapshot === null
              ? null
              : {
                  cpuPercent: snapshot.groups.allT3.currentCpuPercent,
                  rssBytes: snapshot.groups.allT3.currentRssBytes,
                  processCount: snapshot.groups.allT3.processCount,
                }
          }
        />
        <ResourceHistory environmentId={environmentId} />
        {tree.projects.length === 0 && tree.devices.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            Nothing running right now
          </div>
        ) : null}
        {tree.projects.map((project) => (
          <ProjectGroup
            key={project.projectKey ?? UNATTRIBUTED}
            title={project.title}
            count={project.rows.length}
            usage={snapshot === null ? null : project.usage}
          >
            {project.rows.map((row) => {
              const usage = snapshot === null ? null : row.usage;
              if (row.kind === "agent") {
                return (
                  <UsageRow
                    key={row.key}
                    icon={<BotIcon aria-hidden />}
                    label={row.name}
                    detail={`Agent · ${row.name}`}
                    usage={usage}
                    processes={snapshot === null ? undefined : row.processes}
                    onOpen={() => openThread(row.threadId as ThreadId)}
                  />
                );
              }
              const session = sessions.get(row.key);
              return (
                <UsageRow
                  key={row.key}
                  icon={<TerminalIcon aria-hidden />}
                  label={row.name}
                  detail={session?.state.summary?.cwd ?? row.name}
                  suffix={session?.state.hasRunningSubprocess ? "running" : null}
                  usage={usage}
                  processes={snapshot === null ? undefined : row.processes}
                  onOpen={() => openThread(row.threadId as ThreadId)}
                  closeLabel="End terminal"
                  onClose={
                    canClose && session !== undefined
                      ? () =>
                          void close(
                            {
                              threadId: session.target.threadId,
                              terminalId: session.target.terminalId,
                            },
                            row.name,
                          )
                      : null
                  }
                />
              );
            })}
          </ProjectGroup>
        ))}
        {tree.devices.length === 0 ? null : (
          <DeviceGroup environmentId={environmentId} devices={tree.devices} />
        )}
        <HeavyQueueGroup
          environmentId={environmentId}
          threadTitle={(threadId) => infoOf(threadId)?.title}
          onOpenThread={(threadId) => openThread(threadId as ThreadId)}
        />
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
                  {app.map((row) => {
                    const AppGroupIcon = APP_GROUP_ICON[row.group];
                    return (
                      <UsageRow
                        key={row.group}
                        icon={<AppGroupIcon aria-hidden />}
                        label={`${APP_GROUP_LABEL[row.group]} (${row.usage.processCount})`}
                        detail={APP_GROUP_LABEL[row.group]}
                        usage={row.usage}
                        processes={row.processes}
                        onOpen={null}
                      />
                    );
                  })}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          </div>
        )}
      </div>
    </HostCoresContext>
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
  const threadInfo = new Map<string, ThreadInfo>(
    threads.map((thread) => [
      `${thread.environmentId}:${thread.id}`,
      { projectId: thread.projectId, title: thread.title },
    ]),
  );
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-2xs font-medium text-foreground">
        <MemoryStickIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate">Resource Manager</span>
      </div>
      <SortHeader sort={sort} onSort={setSort} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {resources.map((environment) => (
          <EnvironmentSection
            key={environment.environmentId}
            resources={environment}
            snapshot={snapshots.get(environment.environmentId) ?? null}
            sort={sort}
            label={resources.length > 1 ? environment.label : null}
            threadInfo={threadInfo}
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

function QueueCount({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
  const { entries, paused } = useHeavyQueue(environmentId);
  const count = entries.length;
  return count === 0 && !paused ? null : (
    <>
      <span className="text-muted-foreground/50">·</span>
      <ListOrderedIcon aria-hidden />
      <span className="tabular-nums" aria-label={`${count} in heavy work queue`}>
        {count}
      </span>
      {paused ? <PauseIcon aria-label="Heavy work queue paused" className="text-warning" /> : null}
    </>
  );
}

function ResourceSegmentBody() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
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
        <QueueCount environmentId={primaryEnvironmentId} />
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
