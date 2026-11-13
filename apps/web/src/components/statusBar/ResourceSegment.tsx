import { useAtom } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { heavyWork, heavyWorkItems } from "@t3tools/client-runtime/state/heavyQueueModel";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  AuthDiagnosticsReadScope,
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
  ActivityIcon,
  AppWindowIcon,
  BotIcon,
  ChevronRightIcon,
  CpuIcon,
  FolderIcon,
  ListOrderedIcon,
  MemoryStickIcon,
  MonitorCogIcon,
  MonitorIcon,
  PauseIcon,
  ServerIcon,
  SmartphoneIcon,
  SquareDashedIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { createContext, use, useRef, useState, type ReactNode } from "react";

import { useOrderWhileOpen } from "../../hooks/useOrderWhileOpen";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useDeviceState } from "../../state/device";
import { resourceManagerOpenAtom, useHeavyCommands, useHeavyQueue } from "../../state/heavyQueue";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuerySelector } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HeavyCommandRows, type HeavyCommandThreads } from "./HeavyCommandsBody";
import { HeavyWorkSection } from "./HeavyQueueBody";
import { MachineBar } from "./MachineBar";
import { processLabel } from "./processLabel.logic";
import {
  addUsage,
  buildResourceTree,
  deviceRowLabel,
  deviceShutdownTargets,
  EMPTY_USAGE,
  orderResourceTree,
  resourceTreeKeys,
  type AppProcessGroup,
  type DevicePlatform,
  type DeviceRow,
  type ResourceSort,
  type ResourceUsage,
} from "./resourceUsage.logic";
import {
  CPU_COLUMN,
  FOCUS_RING,
  GLYPH,
  GUTTER,
  MEM_COLUMN,
  Metrics,
  METRICS,
  ResourceSection,
  ROW_HOVER,
  ROW_LINE,
  UNDER_NAME,
} from "./ResourceMetrics";
import { formatMemory } from "./statusBar.logic";
import { isStatusBarItemShown, STATUS_BAR_RESOURCE_ITEM } from "./statusBarItems.logic";
import { useCloseTerminal, useShutDownDevice } from "./useKillTarget";
import {
  useEnvironmentResources,
  useEnvironmentSnapshots,
  type EnvironmentResources,
} from "./useEnvironmentResources";

type SortOption = ResourceSort;
type ProjectInfo = ProjectFaviconProject & { readonly title: string };

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

// Half a core; process CPU arrives as a share of the whole machine.
const HEAVY_CPU_PERCENT_OF_CORE = 50;
const HostCoresContext = createContext(1);
const HEAVY_RSS_BYTES = 1024 ** 3;

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
    <div className="pb-1">
      {processes.map((process) => {
        const heavy =
          process.cpuPercent * cores >= HEAVY_CPU_PERCENT_OF_CORE ||
          process.residentBytes >= HEAVY_RSS_BYTES;
        const label = processLabel(process);
        return (
          <div
            key={process.identity.pid}
            className={cn("flex items-center gap-2 py-0.5 pr-3", UNDER_NAME, ROW_HOVER)}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <div
                    data-heavy={heavy ? "" : undefined}
                    className={cn(
                      "flex min-w-0 flex-1 cursor-default items-baseline gap-2 text-2xs",
                      heavy ? "text-warning-foreground" : "text-muted-foreground",
                    )}
                  />
                }
              >
                <span className="max-w-[45%] shrink-0 truncate font-medium">{label}</span>
                <span dir="rtl" className="min-w-0 flex-1 truncate text-left opacity-70">
                  <bdi dir="ltr">{process.command}</bdi>
                </span>
              </TooltipTrigger>
              <TooltipPopup side="left" className="max-w-sm break-all">
                {process.command} · pid {process.identity.pid}
              </TooltipPopup>
            </Tooltip>
            <Metrics
              usage={{
                cpuPercent: process.cpuPercent,
                rssBytes: process.residentBytes,
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
  readonly icon: ReactNode;
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
      {suffix ? <span className="text-muted-foreground"> · {suffix}</span> : null}
    </>
  );
  const name = "min-w-0 flex-1 truncate text-start text-xs text-foreground/90";
  return (
    <>
      <div className={cn(ROW_LINE, ROW_HOVER, "group/row")}>
        {expandable ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} processes of ${label}`}
            onClick={() => setExpanded((value) => !value)}
            className={cn(
              GLYPH,
              "group/toggle cursor-pointer rounded-sm hover:text-foreground",
              FOCUS_RING,
            )}
          >
            {/* The row's icon at rest; a chevron says it opens once the row is pointed at or open. */}
            <span
              className={cn(
                "[&>svg]:size-3.5",
                expanded ? "hidden" : "group-hover/row:hidden group-focus-visible/toggle:hidden",
              )}
            >
              {icon}
            </span>
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "transition-transform duration-150 ease-out motion-reduce:transition-none",
                expanded
                  ? "rotate-90"
                  : "hidden group-hover/row:block group-focus-visible/toggle:block",
              )}
            />
          </button>
        ) : (
          <span className={GLYPH}>{icon}</span>
        )}
        {onOpen === null ? (
          <span className={name}>{text}</span>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onOpen}
                  className={cn(
                    name,
                    "cursor-pointer rounded-sm hover:text-foreground",
                    FOCUS_RING,
                  )}
                />
              }
            >
              {text}
            </TooltipTrigger>
            <TooltipPopup side="left">{detail}</TooltipPopup>
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

interface ThreadInfo {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly working: boolean;
}

/** Rendered only while devices run, so the device state subscription stays closed otherwise. */
function DeviceRows({
  environmentId,
  devices,
  outside,
}: {
  readonly environmentId: EnvironmentId;
  readonly devices: ReadonlyArray<DeviceRow>;
  /** Devices running outside T3's process tree, which the T3 total leaves out. */
  readonly outside: boolean;
}) {
  const { state } = useDeviceState(environmentId);
  const { canShutDown, shutDown } = useShutDownDevice(environmentId);
  const localHostIds = new Set<string>(
    state.hosts.flatMap((host) => (host.kind === "local" ? [host.id] : [])),
  );
  return devices.map((device) => {
    const Icon = DEVICE_ICON[device.platform];
    const targets = deviceShutdownTargets(device, state.devices, localHostIds);
    const label = deviceRowLabel(device, state.devices, localHostIds);
    return (
      <UsageRow
        key={device.key}
        icon={<Icon aria-hidden />}
        label={label}
        detail={outside ? `${label} · runs outside T3, not counted in the T3 total` : label}
        usage={device.usage}
        processes={device.processes}
        onOpen={null}
        closeLabel="Shut down"
        onClose={canShutDown && targets.length > 0 ? () => void shutDown(targets, label) : null}
      />
    );
  });
}

const sumUsage = (rows: ReadonlyArray<{ readonly usage: ResourceUsage }>) =>
  rows.reduce((sum, row) => addUsage(sum, row.usage), EMPTY_USAGE);

export function EnvironmentSection({
  resources,
  snapshot,
  sort,
  holdOrder = false,
  label,
  threadInfo,
  projectById,
  sortHeader = null,
}: {
  readonly resources: EnvironmentResources;
  readonly snapshot: ResourceTelemetrySnapshot | null;
  readonly sort: SortOption;
  /** Keeps rows where they are instead of re-ranking them as usage changes. */
  readonly holdOrder?: boolean;
  readonly label: string | null;
  readonly threadInfo: ReadonlyMap<string, ThreadInfo>;
  readonly projectById: ReadonlyMap<ProjectId, ProjectInfo>;
  /** The columns' sort header, under the first environment's machines. */
  readonly sortHeader?: ReactNode;
}) {
  const { environmentId } = resources;
  const navigate = useNavigate();
  const { canClose, close } = useCloseTerminal(environmentId);
  const queue = useHeavyQueue(environmentId);
  // While mounted, the server samples processes for heavy commands.
  const { commands, cpuCount } = useHeavyCommands(environmentId);
  const infoOf = (threadId: string) => threadInfo.get(`${environmentId}:${threadId}`);
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  const threads: HeavyCommandThreads = {
    threadTitle: (threadId) => infoOf(threadId)?.title,
    projectIdOfThread: (threadId) => infoOf(threadId)?.projectId,
    onOpenThread: (threadId) => openThread(threadId as ThreadId),
  };
  const sessions = new Map(
    resources.terminals
      .filter((session) => session.state.status === "running")
      .map((session) => [`${session.target.threadId}:${session.target.terminalId}`, session]),
  );
  const owners = snapshot?.owners ?? [];
  const ranked = buildResourceTree({
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
        : (projectById.get(projectKey as ProjectId)?.title ?? UNATTRIBUTED),
    threadTitle: (threadId) => infoOf(threadId)?.title || "Agent",
  });
  const order = useOrderWhileOpen(resourceTreeKeys(ranked), String, holdOrder);
  const tree = holdOrder ? orderResourceTree(ranked, order) : ranked;
  const t3Devices = tree.devices.filter((device) => !device.outside);
  const outsideDevices = tree.devices.filter((device) => device.outside);
  const work = heavyWork(queue, commands);
  const detached = work.detached;
  const heavyCount = heavyWorkItems(work).length;
  const app = snapshot === null ? null : tree.app;
  const outsideCount = outsideDevices.length + detached.length;
  const outsideUsage = detached.reduce(
    (sum, command) =>
      command.cpu === undefined || command.memory === undefined
        ? sum
        : addUsage(sum, {
            cpuPercent: (command.cpu / Math.max(1, cpuCount)) * 100,
            rssBytes: command.memory,
            processCount: 1,
          }),
    sumUsage(outsideDevices),
  );

  return (
    <HostCoresContext value={snapshot?.cpuCount ?? 1}>
      <div className="border-t border-foreground/10 first:border-t-0">
        {label === null ? null : (
          <div className="flex items-center gap-2 px-3 pt-2.5 text-2xs font-semibold text-foreground/80 [&>svg]:size-3.5 [&>svg]:text-muted-foreground">
            <ServerIcon aria-hidden />
            {label}
          </div>
        )}
        <MachineBar
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
        {sortHeader}
        {tree.projects.length === 0 && t3Devices.length === 0 && heavyCount === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-3 py-8 text-center text-xs text-muted-foreground">
            <ActivityIcon aria-hidden className="size-4 opacity-60" />
            Nothing running right now
          </div>
        ) : null}
        <HeavyWorkSection
          environmentId={environmentId}
          commands={commands}
          cpuCount={cpuCount}
          threads={threads}
        />
        {tree.projects.map((project) => {
          const info =
            project.projectKey === null
              ? undefined
              : projectById.get(project.projectKey as ProjectId);
          return (
            <ResourceSection
              key={project.projectKey ?? UNATTRIBUTED}
              sectionId={`${environmentId}:project:${project.projectKey ?? UNATTRIBUTED}`}
              title={project.title}
              icon={
                info === undefined ? (
                  <FolderIcon aria-hidden />
                ) : (
                  <ProjectFavicon project={info} className="size-3.5" />
                )
              }
              count={project.rows.length}
              usage={snapshot === null ? null : project.usage}
            >
              {project.rows.map((row) => {
                const usage = snapshot === null ? null : row.usage;
                if (row.kind === "agent") {
                  const working = infoOf(row.threadId)?.working ?? false;
                  return (
                    <UsageRow
                      key={row.key}
                      icon={<BotIcon aria-hidden />}
                      label={row.name}
                      detail={
                        working
                          ? `Agent · ${row.name}`
                          : `Idle agent session, kept open for follow-ups · ${row.name}`
                      }
                      suffix={working ? null : "idle"}
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
            </ResourceSection>
          );
        })}
        {t3Devices.length === 0 ? null : (
          <ResourceSection
            sectionId={`${environmentId}:devices`}
            title="Devices"
            icon={<SmartphoneIcon aria-hidden />}
            count={t3Devices.length}
            usage={sumUsage(t3Devices)}
          >
            <DeviceRows environmentId={environmentId} devices={t3Devices} outside={false} />
          </ResourceSection>
        )}
        {app === null ? null : (
          <ResourceSection
            sectionId={`${environmentId}:app`}
            title="T3 Code"
            icon={<MonitorCogIcon aria-hidden />}
            count={app.length}
            usage={sumUsage(app)}
            defaultOpen={false}
          >
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
          </ResourceSection>
        )}
        {outsideCount === 0 ? null : (
          <ResourceSection
            sectionId={`${environmentId}:outside`}
            title="Outside T3"
            icon={<SquareDashedIcon aria-hidden />}
            count={outsideCount}
            usage={outsideUsage}
          >
            {outsideDevices.length === 0 ? null : (
              <DeviceRows environmentId={environmentId} devices={outsideDevices} outside />
            )}
            <HeavyCommandRows
              environmentId={environmentId}
              commands={detached}
              cpuCount={cpuCount}
              threads={threads}
            />
          </ResourceSection>
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
        "cursor-pointer rounded-sm transition-colors hover:text-foreground",
        FOCUS_RING,
        sort === option ? "font-semibold text-foreground" : "text-muted-foreground",
      )}
    >
      {text}
    </button>
  );
  return (
    <div className="flex items-center justify-between border-y border-foreground/10 py-1 pr-3 pl-9 text-3xs tracking-wide uppercase">
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
  // Scrolled down, rows hold their order so the ones in view stay put; at the top they re-rank live.
  const [scrolled, setScrolled] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const changeSort = (next: SortOption) => {
    setSort(next);
    setScrolled(false);
    listRef.current?.scrollTo({ top: 0 });
  };
  const projects = useProjects();
  const threads = useThreadShells();
  const snapshots = useEnvironmentSnapshots(resources.map(({ environmentId }) => environmentId));
  const projectById = new Map<ProjectId, ProjectInfo>(
    projects.map((project) => [project.id, project]),
  );
  const threadInfo = new Map<string, ThreadInfo>(
    threads.map((thread) => [
      `${thread.environmentId}:${thread.id}`,
      {
        projectId: thread.projectId,
        title: thread.title,
        working: threadRuntimeIsActive(thread.runtime),
      },
    ]),
  );
  return (
    // Base UI measures the popup with --available-height set to max-content, which voids a min() height:
    // the full list then overflows every side and the popup lands beside the button.
    <div className="flex h-[40rem] max-h-(--available-height) w-full flex-col">
      <div className="flex items-center gap-2 border-b border-foreground/10 px-3 py-2 text-xs font-semibold text-foreground">
        <MemoryStickIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">Resource Manager</span>
      </div>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
      >
        {resources.map((environment, index) => (
          <EnvironmentSection
            key={environment.environmentId}
            resources={environment}
            snapshot={snapshots.get(environment.environmentId) ?? null}
            sort={sort}
            holdOrder={scrolled}
            label={resources.length > 1 ? environment.label : null}
            threadInfo={threadInfo}
            projectById={projectById}
            sortHeader={index === 0 ? <SortHeader sort={sort} onSort={changeSort} /> : null}
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
  const queue = useHeavyQueue(environmentId);
  // Switched off, a pause holds nothing back, so it is not worth a warning.
  const paused = queue.paused && queue.enabled;
  const count = queue.entries.length;
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
  const [open, setOpen] = useAtom(resourceManagerOpenAtom);
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
      <PopoverPopup side="top" align="end" padding="none" className="w-[28rem]">
        <ResourceManager resources={resources} />
      </PopoverPopup>
    </Popover>
  );
}

export function ResourceSegment() {
  const hidden = useClientSettings((settings) => settings.statusBarHiddenItems);
  return isStatusBarItemShown(hidden, STATUS_BAR_RESOURCE_ITEM) ? <ResourceSegmentBody /> : null;
}
