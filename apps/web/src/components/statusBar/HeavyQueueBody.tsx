import { heavyEntryName } from "@t3tools/shared/heavyEntryName";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  dropTarget,
  heavyItemsInProject,
  heavyWork,
  heavyWorkItems,
  heavyRowUsage,
  jobCost,
  jobPriority,
  orphanLine,
  machineSummaries,
  moveTarget,
  PRIORITY_CHANGE,
  ordinal,
  PRIORITY_LABEL,
  projectForCommand,
  ruleForRoot,
  usageLine,
  type MachineWork,
  type MoveAction,
  type PriorityChange,
} from "@t3tools/client-runtime/state/heavyQueueModel";
import {
  ASK_TITLE,
  askAnswers,
  askRemaining,
  moveAllActions,
  routeActions,
  RUNNER_DEADLINE_LABEL,
  RUNNER_PHASE_LABEL,
  RUNNER_POLICY_LABEL,
  RUNNER_UNCONFIRMED_NOTE,
  type MoveAllAction,
} from "@t3tools/client-runtime/state/runnerModel";
import type {
  EnvironmentId,
  HeavyCommand,
  HeavyQueueEntry,
  HeavyRunner,
  HeavyRunnerPhase,
} from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpIcon,
  ArrowUpToLineIcon,
  CircleStopIcon,
  DumbbellIcon,
  EllipsisIcon,
  FolderSyncIcon,
  GaugeIcon,
  GripVerticalIcon,
  HourglassIcon,
  LaptopIcon,
  MessageSquareIcon,
  PackageIcon,
  PauseIcon,
  PlayIcon,
  RocketIcon,
  ServerIcon,
  SnailIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useHeavyQueue } from "../../state/heavyQueue";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  Elapsed,
  type Fact,
  HeavyCommandRow,
  type HeavyCommandThreads,
  HeavyRow,
  ProjectChip,
  threadFact,
} from "./HeavyCommandsBody";
import { ResourceSection } from "./ResourceMetrics";
import { useHeavyQueueActions, useStopHeavyCommand } from "./useKillTarget";

const ASK_REFRESH_MS = 1_000;
const DRAG_MODIFIERS = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];

/** Ticks every `refreshMs` while a row counts down; null leaves the clock still. */
function useRowClock(refreshMs: number | null) {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer for the ask and orphan countdowns, running only while one is shown
  useEffect(() => {
    if (refreshMs === null) return;
    const tick = () => setNow(Date.now());
    // The first tick catches up a clock that sat idle since mount.
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, refreshMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refreshMs]);
  return now;
}

type Actions = ReturnType<typeof useHeavyQueueActions>;
type QueueState = ReturnType<typeof useHeavyQueue>;

const PRIORITY_CHANGE_ITEM: Record<PriorityChange, { Icon: typeof ZapIcon; text: string }> = {
  "high-now": { Icon: ZapIcon, text: "High priority now" },
  normal: { Icon: GaugeIcon, text: "Normal priority" },
  lower: { Icon: SnailIcon, text: "Lower priority" },
};

function RowMenu({
  entry,
  entries,
  state,
  actions,
  priority,
  projectRoot,
  onOpenThread,
}: {
  readonly entry: HeavyQueueEntry;
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  readonly state: QueueState;
  readonly actions: Actions;
  readonly priority: "first" | "normal" | "last";
  readonly projectRoot: string | null;
  readonly onOpenThread: (() => void) | null;
}) {
  const running = entry.startedAt !== null;
  const orphaned = !running && entry.orphanedAt !== undefined;
  const move = (action: MoveAction) => {
    const target = moveTarget(entries, entry.id, action);
    if (target !== undefined) void actions.move(entry.id, target);
  };
  const label = heavyEntryName(entry);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button variant="ghost-muted" size="icon-micro" aria-label={`Actions for ${label}`} />
        }
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup side="top" align="end">
        {running || orphaned ? null : (
          <MenuGroup>
            <MenuItem disabled={!actions.canChange} onClick={() => void actions.startNow(entry.id)}>
              <RocketIcon aria-hidden />
              Start now
            </MenuItem>
            <MenuItem
              disabled={!actions.canChange || moveTarget(entries, entry.id, "next") === undefined}
              onClick={() => move("next")}
            >
              <ArrowUpToLineIcon aria-hidden />
              Run next
            </MenuItem>
            <MenuItem
              disabled={!actions.canChange || moveTarget(entries, entry.id, "up") === undefined}
              onClick={() => move("up")}
            >
              <ArrowUpIcon aria-hidden />
              Move up
            </MenuItem>
            <MenuItem
              disabled={!actions.canChange || moveTarget(entries, entry.id, "down") === undefined}
              onClick={() => move("down")}
            >
              <ArrowDownIcon aria-hidden />
              Move down
            </MenuItem>
            <MenuItem
              disabled={!actions.canChange || moveTarget(entries, entry.id, "end") === undefined}
              onClick={() => move("end")}
            >
              <ArrowDownToLineIcon aria-hidden />
              Move to end
            </MenuItem>
          </MenuGroup>
        )}
        {(orphaned ? [] : routeActions(entry, state)).map((action) => (
          <MenuItem
            key={action.runner}
            disabled={!actions.canRoute}
            onClick={() => void actions.route(entry.id, action)}
          >
            {action.runner === "mac" ? <LaptopIcon aria-hidden /> : <ServerIcon aria-hidden />}
            {action.label}
          </MenuItem>
        ))}
        {jobPriority(entry).changes.map((change) => {
          const { Icon, text } = PRIORITY_CHANGE_ITEM[change];
          return (
            <MenuItem
              key={change}
              disabled={!actions.canChange}
              onClick={() => void actions.setPriority(entry.id, PRIORITY_CHANGE[change])}
            >
              <Icon aria-hidden />
              {text}
            </MenuItem>
          );
        })}
        {onOpenThread === null ? null : (
          <MenuItem onClick={onOpenThread}>
            <MessageSquareIcon aria-hidden />
            Open thread
          </MenuItem>
        )}
        {projectRoot === null ? null : (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Priority for this project</MenuGroupLabel>
              <MenuRadioGroup
                value={priority}
                onValueChange={(value) => {
                  if (value === "first" || value === "last") {
                    void actions.setRule(projectRoot, value);
                  } else {
                    void actions.setRule(projectRoot, null);
                  }
                }}
              >
                {(["first", "normal", "last"] as const).map((value) => (
                  <MenuRadioItem key={value} value={value} disabled={!actions.canChange}>
                    {PRIORITY_LABEL[value]}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        )}
        <MenuSeparator />
        <MenuItem
          variant="destructive"
          disabled={!actions.canChange || (running && entry.server === true)}
          onClick={() => void actions.cancel(entry.id, running)}
        >
          {running || orphaned ? <CircleStopIcon aria-hidden /> : <Trash2Icon aria-hidden />}
          {running || orphaned ? "Stop" : "Remove from the queue"}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

const ASK_CHOICES = [
  { runner: "mac", label: RUNNER_POLICY_LABEL.mac, Icon: LaptopIcon },
  { runner: "linux", label: RUNNER_POLICY_LABEL.wait, Icon: ServerIcon },
] as const;

function AskPrompt({
  entry,
  ask,
  state,
  actions,
  now,
}: {
  readonly entry: HeavyQueueEntry;
  readonly ask: NonNullable<HeavyQueueEntry["ask"]>;
  readonly state: QueueState;
  readonly actions: Actions;
  readonly now: number;
}) {
  const title = ASK_TITLE[ask.reason];
  const answers = askAnswers(entry, state);
  return (
    <div
      role="group"
      aria-label={title}
      className="mr-3 mb-2 ml-9 rounded-md border border-foreground/12 px-2 py-1.5"
    >
      <div className="flex items-center gap-1.5 text-3xs">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">{title}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {askRemaining(ask.deadlineAt, now)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {ASK_CHOICES.map(({ runner, label, Icon }) => {
          const action = answers.find((candidate) => candidate.runner === runner);
          return action === undefined ? null : (
            <Button
              key={runner}
              size="xs"
              variant="outline"
              disabled={!actions.canRoute}
              onClick={() => void actions.route(entry.id, action)}
            >
              <Icon aria-hidden />
              {label}
            </Button>
          );
        })}
        <Button
          size="xs"
          variant="ghost"
          disabled={!actions.canChange}
          onClick={() => void actions.cancel(entry.id, entry.startedAt !== null)}
        >
          {RUNNER_DEADLINE_LABEL.cancel}
        </Button>
      </div>
    </div>
  );
}

const MACHINE = {
  mac: { name: "This Mac", Icon: LaptopIcon },
  linux: { name: "Linux", Icon: ServerIcon },
} as const;

const PHASE_ICON: Record<HeavyRunnerPhase, typeof PlayIcon> = {
  syncing: FolderSyncIcon,
  installing: PackageIcon,
  running: PlayIcon,
};

function QueueRow({
  entry,
  waiting,
  position,
  state,
  actions,
  now,
  cpuCount,
  threads,
  scopeProjectId,
}: {
  readonly entry: HeavyQueueEntry;
  /** The waiters of this row's machine, in run order: moves stay inside its line. */
  readonly waiting: ReadonlyArray<HeavyQueueEntry>;
  readonly position: number | null;
  readonly state: QueueState;
  readonly actions: Actions;
  readonly now: number;
  readonly cpuCount: number;
  readonly threads: HeavyCommandThreads;
  readonly scopeProjectId: string | undefined;
}) {
  const running = position === null;
  const onLinux = running ? entry.runner === "linux" : state.routes[entry.id] === "linux";
  const projects = useProjects();
  const project = projectForCommand(entry, projects, threads.projectIdOfThread);
  const rule = project === undefined ? undefined : ruleForRoot(state.rules, project.workspaceRoot);
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: entry.id,
    disabled: running || entry.orphanedAt !== undefined || !actions.canChange,
  });
  const label = heavyEntryName(entry);
  const { threadId } = entry;
  const cpuLabel = jobPriority(entry).label;
  const reason = state.reasons[entry.id];
  const cost = jobCost(state, entry);
  const orphan = running ? null : orphanLine(entry, state.reclaimMinutes, now);
  const classLabel = cost === null ? null : `${cost.label} · `;
  const machine = onLinux
    ? `Linux${state.linux === null ? "" : ` (${state.linux.host})`}`
    : MACHINE.mac.name;
  const PhaseIcon = PHASE_ICON[entry.phase ?? "running"];
  // A Linux job's own processes run there; what this Mac samples is only its ssh session.
  const usage = !running || onLinux ? undefined : heavyRowUsage(entry, cpuCount);
  const facts = (interactive: boolean): ReadonlyArray<Fact> => [
    { label: "Command", value: entry.label, mono: true },
    { label: "Folder", value: entry.cwd, mono: true },
    ...threadFact(threadId, threads, interactive),
    {
      label: running ? "Runs on" : "Waits for",
      value:
        running && onLinux && entry.phase !== undefined
          ? `${machine} · ${RUNNER_PHASE_LABEL[entry.phase]}`
          : machine,
    },
    ...(entry.remote === undefined
      ? []
      : [{ label: "Run folder", value: `~/runs/${entry.remote.id}`, mono: true }]),
    running
      ? { label: "Running", value: <Elapsed since={entry.startedAt ?? entry.createdAt} /> }
      : {
          label: "Waiting",
          value: orphan ?? (
            <>
              {ordinal(position ?? 0)} in line · <Elapsed since={entry.createdAt} />
            </>
          ),
        },
    ...(cost === null ? [] : [{ label: "Class", value: `${cost.label} · ${cost.why}` }]),
    {
      label: "Priority",
      value: [`Project: ${PRIORITY_LABEL[rule?.priority ?? "normal"]}`, cpuLabel]
        .filter(Boolean)
        .join(" · "),
    },
    ...(onLinux && running
      ? []
      : [{ label: "Usage", value: usageLine(entry, state) ?? "Unknown" }]),
    ...(reason === undefined ? [] : [{ label: "Why waiting", value: reason }]),
    ...(entry.note === undefined ? [] : [{ label: "Note", value: entry.note }]),
    ...(entry.unconfirmed === true
      ? [{ label: "Earlier run", value: RUNNER_UNCONFIRMED_NOTE }]
      : []),
    { label: "Process", value: `pid ${entry.pid}` },
  ];
  return (
    <HeavyRow
      rowRef={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "relative z-20 bg-popover shadow-md")}
      name={label}
      glyph={
        running ? (
          <PhaseIcon
            aria-label={
              onLinux && entry.phase !== undefined ? RUNNER_PHASE_LABEL[entry.phase] : "Running"
            }
            className="fill-current text-success"
          />
        ) : (
          <Button
            variant="ghost-muted"
            size="icon-tiny"
            className="cursor-grab touch-none"
            aria-label={`Drag to reorder ${label}`}
            disabled={!actions.canChange}
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
          >
            <HourglassIcon aria-hidden className="group-hover/row:hidden" />
            <GripVerticalIcon aria-hidden className="hidden group-hover/row:block" />
          </Button>
        )
      }
      chip={
        project !== undefined && project.id === scopeProjectId ? null : (
          <ProjectChip project={project} folder={entry.cwd} />
        )
      }
      state={
        running ? (
          onLinux && entry.phase !== undefined && entry.phase !== "running" ? (
            RUNNER_PHASE_LABEL[entry.phase]
          ) : (
            <>
              {classLabel}
              <Elapsed since={entry.startedAt ?? entry.createdAt} />
            </>
          )
        ) : (
          <>
            {classLabel}
            {orphan === null ? `${ordinal(position ?? 0)} · ` : null}
            <Elapsed since={entry.createdAt} />
          </>
        )
      }
      usage={usage}
      secondLine={running || orphan !== null ? undefined : reason}
      facts={facts}
      menu={
        <RowMenu
          entry={entry}
          entries={waiting}
          state={state}
          actions={actions}
          priority={rule?.priority ?? "normal"}
          projectRoot={project?.workspaceRoot ?? null}
          onOpenThread={threadId === null ? null : () => threads.onOpenThread(threadId)}
        />
      }
    >
      {entry.ask === undefined ? null : (
        <AskPrompt entry={entry} ask={entry.ask} state={state} actions={actions} now={now} />
      )}
      {orphan === null ? null : (
        <div
          role="group"
          aria-label="Stopped agent's place"
          className="mr-3 mb-2 ml-9 flex items-center gap-1.5 rounded-md border border-foreground/12 px-2 py-1.5 text-3xs"
        >
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{orphan}</span>
          <Button
            size="xs"
            variant="outline"
            disabled={!actions.canChange}
            onClick={() => void actions.cancel(entry.id, false)}
          >
            <CircleStopIcon aria-hidden />
            Stop
          </Button>
        </div>
      )}
    </HeavyRow>
  );
}

/** One machine's rows: running jobs, then the commands agents run directly, then its line. */
function MachineGroup({
  runner,
  work,
  showName,
  children,
  renderWaiter,
  actions,
  moveAll,
}: {
  readonly runner: HeavyRunner;
  /** Already narrowed to what this list shows; `line` keeps every waiter for places and moves. */
  readonly work: MachineWork & { readonly line: ReadonlyArray<HeavyQueueEntry> };
  readonly showName: boolean;
  readonly children: ReactNode;
  readonly renderWaiter: (entry: HeavyQueueEntry, position: number) => ReactNode;
  readonly actions: Actions;
  /** The Move all that sends waiting jobs to the other machine, when one would move. */
  readonly moveAll: MoveAllAction | undefined;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null) return;
    const target = dropTarget(work.line, String(active.id), String(over.id));
    if (target !== undefined) void actions.move(String(active.id), target);
  };
  const { name, Icon } = MACHINE[runner];
  return (
    <div role="group" aria-label={name}>
      {showName ? (
        <div className="flex items-center gap-1.5 pt-2 pb-0.5 pl-3">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-3xs font-medium tracking-wide text-muted-foreground uppercase [&>svg]:size-3">
            <Icon aria-hidden />
            {name}
          </span>
          {moveAll === undefined ? null : (
            <Button
              size="micro"
              variant="ghost-muted"
              disabled={!actions.canRouteAll}
              onClick={() => void actions.moveAll(moveAll.runner)}
            >
              {moveAll.runner === "mac" ? <LaptopIcon aria-hidden /> : <ServerIcon aria-hidden />}
              {moveAll.label}
            </Button>
          )}
        </div>
      ) : null}
      {children}
      {/* One drag context per machine, so a waiter cannot be dropped into the other machine's line. */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={DRAG_MODIFIERS}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={work.waiting.map((entry) => entry.id)}
          strategy={verticalListSortingStrategy}
        >
          {work.waiting.map((entry) =>
            renderWaiter(entry, work.line.findIndex((w) => w.id === entry.id) + 1),
          )}
        </SortableContext>
      </DndContext>
    </div>
  );
}

const NO_COMMANDS: ReadonlyArray<HeavyCommand> = [];

/**
 * Heavy work split by machine, each running first and then waiting in its own line, with every
 * job listed once. With `projectId` it keeps that project's rows, at their places on their machine.
 */
export function HeavyWorkList({
  environmentId,
  commands = NO_COMMANDS,
  cpuCount,
  threads,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly commands?: ReadonlyArray<HeavyCommand>;
  readonly cpuCount: number;
  readonly threads: HeavyCommandThreads;
  readonly projectId?: string;
}) {
  const state = useHeavyQueue(environmentId);
  const actions = useHeavyQueueActions(environmentId);
  const stop = useStopHeavyCommand(environmentId);
  const projects = useProjects();
  const work = heavyWork(state, commands);
  const keep = <T extends Pick<HeavyCommand, "threadId"> & { readonly cwd?: string | undefined }>(
    items: ReadonlyArray<T>,
  ) =>
    projectId === undefined
      ? items
      : heavyItemsInProject(items, {
          projectId,
          projects: projects.filter((project) => project.environmentId === environmentId),
          projectIdOfThread: threads.projectIdOfThread,
        });
  // An orphan's countdown is in minutes, so it needs no per-second ticks.
  const now = useRowClock(
    state.entries.some((entry) => entry.ask !== undefined)
      ? ASK_REFRESH_MS
      : state.entries.some((entry) => entry.orphanedAt !== undefined)
        ? 30_000
        : null,
  );
  const machineCpuCount = state.machine?.cpuCount ?? cpuCount;
  const groups = (["mac", "linux"] as const)
    .map((runner) => {
      const all = work[runner];
      return {
        runner,
        work: {
          running: keep(all.running),
          direct: keep(all.direct),
          waiting: keep(all.waiting),
          line: all.waiting,
        },
      };
    })
    .filter(({ work: rows }) => rows.running.length + rows.direct.length + rows.waiting.length > 0);
  const moveAlls = moveAllActions(state);
  const showNames =
    state.linux !== null || work.linux.running.length + work.linux.waiting.length > 0;
  const row = (
    entry: HeavyQueueEntry,
    position: number | null,
    line: ReadonlyArray<HeavyQueueEntry>,
  ) => (
    <QueueRow
      key={entry.id}
      entry={entry}
      waiting={line}
      position={position}
      state={state}
      actions={actions}
      now={entry.ask === undefined && entry.orphanedAt === undefined ? 0 : now}
      cpuCount={machineCpuCount}
      threads={threads}
      scopeProjectId={projectId}
    />
  );
  return (
    <div>
      {groups.map(({ runner, work: rows }) => (
        <MachineGroup
          key={runner}
          runner={runner}
          work={rows}
          showName={showNames}
          actions={actions}
          moveAll={moveAlls.find((action) => action.runner !== runner)}
          renderWaiter={(entry, position) => row(entry, position, rows.line)}
        >
          {rows.running.map((entry) => row(entry, null, rows.line))}
          {rows.direct.map((command) => (
            <HeavyCommandRow
              key={`${command.pid}:${command.startTimeMs}`}
              command={command}
              cpuCount={cpuCount}
              threads={threads}
              stop={stop}
              scopeProjectId={projectId}
            />
          ))}
        </MachineGroup>
      ))}
    </div>
  );
}

/** "Mac 0/3": a machine's running jobs against its slots, without slots where none apply. */
function MachineCount({
  runner,
  running,
  slots,
}: {
  readonly runner: HeavyRunner;
  readonly running: number;
  readonly slots: number | null;
}) {
  const name = runner === "mac" ? "Mac" : "Linux";
  return (
    <span
      aria-label={`${MACHINE[runner].name}: ${running}${slots === null ? "" : ` of ${slots}`} running`}
    >
      {name} {running}
      {slots === null ? "" : `/${slots}`}
    </span>
  );
}

/**
 * The Resource Manager's Heavy work section: per-machine counts and the queue's pause in its
 * header. Hidden while nothing runs or waits and the queue is simply on.
 */
export function HeavyWorkSection({
  environmentId,
  commands,
  cpuCount,
  threads,
}: {
  readonly environmentId: EnvironmentId;
  readonly commands: ReadonlyArray<HeavyCommand>;
  readonly cpuCount: number;
  readonly threads: HeavyCommandThreads;
}) {
  const state = useHeavyQueue(environmentId);
  const actions = useHeavyQueueActions(environmentId);
  const work = heavyWork(state, commands);
  const summaries = machineSummaries(state);
  const count = heavyWorkItems(work).length;
  if (count === 0 && state.enabled && !state.paused) return null;
  const showLinux =
    summaries.linux !== null || work.linux.running.length + work.linux.waiting.length > 0;
  return (
    <ResourceSection
      sectionId={`${environmentId}:heavy-work`}
      title="Heavy work"
      icon={<DumbbellIcon aria-hidden />}
      count={count}
      controls={
        <>
          <span className="pointer-events-none mr-1 flex items-center gap-1 text-2xs tabular-nums text-muted-foreground">
            <MachineCount
              runner="mac"
              running={summaries.mac.running}
              slots={state.enabled ? state.maxRunning : null}
            />
            {showLinux ? (
              <>
                <span aria-hidden>·</span>
                <MachineCount
                  runner="linux"
                  running={work.linux.running.length}
                  slots={summaries.linux?.slots ?? null}
                />
              </>
            ) : null}
          </span>
          {state.enabled ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost-muted"
                    size="icon-micro"
                    aria-label="Pause the heavy work queue"
                    aria-pressed={state.paused}
                    disabled={!actions.canChange}
                    onClick={() => void actions.setPaused(!state.paused)}
                  />
                }
              >
                <PauseIcon aria-hidden className={cn(state.paused && "text-warning")} />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {state.paused
                  ? "Paused: nothing new starts. Click to resume."
                  : "Pause the queue: running jobs finish, nothing new starts."}
              </TooltipPopup>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="micro"
                    variant="outline"
                    disabled={!actions.canChange}
                    onClick={() => void actions.setEnabled(true)}
                  />
                }
              >
                Turn on
              </TooltipTrigger>
              <TooltipPopup side="top">{summaries.mac.note}</TooltipPopup>
            </Tooltip>
          )}
        </>
      }
    >
      <HeavyWorkList
        environmentId={environmentId}
        commands={commands}
        cpuCount={cpuCount}
        threads={threads}
      />
    </ResourceSection>
  );
}
