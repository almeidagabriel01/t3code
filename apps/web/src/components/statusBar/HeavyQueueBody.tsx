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
  formatDuration,
  formatFreeMemory,
  heavyItemsInProject,
  jobPriority,
  machineSummaries,
  moveTarget,
  PRIORITY_CHANGE,
  ordinal,
  PRIORITY_LABEL,
  projectForCommand,
  readableLabel,
  ruleForRoot,
  usageLine,
  type MachineSummary,
  type MoveAction,
  type PriorityChange,
} from "@t3tools/client-runtime/state/heavyQueueModel";
import {
  ASK_TITLE,
  askRemaining,
  routeActions,
  RUNNER_DEADLINE_LABEL,
  RUNNER_PHASE_LABEL,
  RUNNER_POLICY_LABEL,
  runnerBadge,
  RUNNER_UNCONFIRMED_NOTE,
} from "@t3tools/client-runtime/state/runnerModel";
import type { EnvironmentId, HeavyQueueEntry, HeavyRunner } from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpIcon,
  ArrowUpToLineIcon,
  ChevronsDownIcon,
  ChevronsUpIcon,
  CpuIcon,
  EllipsisIcon,
  GaugeIcon,
  GripVerticalIcon,
  InfoIcon,
  LaptopIcon,
  MemoryStickIcon,
  MessageSquareIcon,
  PlayIcon,
  RocketIcon,
  ServerIcon,
  SnailIcon,
  SquareIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useProjects } from "../../state/entities";
import { useHeavyQueue } from "../../state/heavyQueue";
import { cn } from "../../lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
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
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useHeavyQueueActions } from "./useKillTarget";

const ELAPSED_REFRESH_MS = 5_000;
const ASK_REFRESH_MS = 1_000;
const DRAG_MODIFIERS = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];

export function Elapsed({ since, prefix }: { readonly since: string; readonly prefix?: string }) {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- coarse timer so the elapsed time does not repaint continuously
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const duration = formatDuration(since, now);
  return <>{prefix === undefined ? duration : `${prefix} ${duration}`}</>;
}

/** Ticks once a second only while `active`, so an idle list never repaints. */
function useAskClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one-second timer for the ask countdown, running only while a question is shown
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    // The first tick catches up a clock that sat idle since mount.
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, ASK_REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active]);
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
        {running ? null : (
          <MenuGroup>
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
        {routeActions(entry, state).map((action) => (
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
          {running ? <SquareIcon aria-hidden /> : <Trash2Icon aria-hidden />}
          {running ? "Stop" : "Remove from the queue"}
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
  // Unpinned, so the runner it already heads for is offered too, with any rerun confirmation.
  const { route: _route, ...unpinned } = entry;
  const answers = routeActions(unpinned, state);
  return (
    <div
      role="group"
      aria-label={title}
      className="mt-1.5 ml-6.5 rounded-md border border-foreground/12 px-2 py-1.5"
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

/** An icon, or a short value, whose meaning lives in its tooltip and accessible name. */
function Hint({
  label,
  Icon,
  children,
}: {
  readonly label: string;
  readonly Icon: typeof InfoIcon;
  readonly children?: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            tabIndex={0}
            className="flex shrink-0 cursor-default items-center gap-0.5 rounded-sm tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring [&>svg]:size-3"
          />
        }
      >
        <Icon aria-hidden />
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** One truncated line whose full text is in its tooltip. */
function TruncatedText({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className={cn(
              "cursor-default truncate rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
              className,
            )}
          />
        }
      >
        {text}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-sm">
        {text}
      </TooltipPopup>
    </Tooltip>
  );
}

const RULE_ICON = { first: ChevronsUpIcon, last: ChevronsDownIcon } as const;

function Row({
  entry,
  entries,
  position,
  state,
  actions,
  now,
  threadTitle,
  projectIdOfThread,
  onOpenThread,
  scopeProjectId,
}: {
  readonly entry: HeavyQueueEntry;
  /** The waiters of this row's machine, in run order: moves stay inside its group. */
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  readonly position: number | null;
  readonly state: QueueState;
  readonly now: number;
  readonly actions: Actions;
  readonly threadTitle: (threadId: string) => string | undefined;
  readonly projectIdOfThread: (threadId: string) => string | undefined;
  readonly onOpenThread: (threadId: string) => void;
  readonly scopeProjectId?: string | undefined;
}) {
  const running = position === null;
  const projects = useProjects();
  const project = projectForCommand(entry, projects, projectIdOfThread);
  const rule = project === undefined ? undefined : ruleForRoot(state.rules, project.workspaceRoot);
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.id, disabled: running || !actions.canChange });
  const label = heavyEntryName(entry);
  const { threadId } = entry;
  const title = threadId === null ? undefined : threadTitle(threadId);
  const usage = usageLine(entry, state);
  const cpuLabel = jobPriority(entry).label;
  const detail = [state.reasons[entry.id], entry.note].filter(Boolean).join(" · ");
  const RuleIcon = rule === undefined ? null : RULE_ICON[rule.priority];
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn(
        "py-1.5 pl-2 pr-3 hover:bg-foreground/8",
        isDragging && "relative z-10 bg-popover shadow-md",
      )}
    >
      <div className="flex items-center gap-1.5">
        {running ? (
          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3">
            <PlayIcon aria-hidden />
          </span>
        ) : (
          <Button
            variant="ghost-muted"
            size="icon-micro"
            className="cursor-grab touch-none"
            aria-label={`Drag to reorder ${label}`}
            disabled={!actions.canChange}
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon aria-hidden />
          </Button>
        )}
        {readableLabel(entry.label) === label ? (
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
            {label}
          </span>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="min-w-0 flex-1 cursor-default truncate text-xs font-medium text-foreground/90" />
              }
            >
              {label}
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-sm break-all">
              {entry.label}
            </TooltipPopup>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="shrink-0 cursor-default text-2xs tabular-nums text-muted-foreground" />
            }
          >
            {entry.startedAt === null ? (
              <>
                {ordinal(position ?? 0)} · <Elapsed since={entry.createdAt} />
              </>
            ) : (
              <>
                {entry.phase === undefined ? "" : `${RUNNER_PHASE_LABEL[entry.phase]} · `}
                <Elapsed since={entry.startedAt} />
              </>
            )}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {entry.startedAt === null ? (
              <Elapsed since={entry.createdAt} prefix="Waiting" />
            ) : (
              <Elapsed since={entry.startedAt} prefix="Running" />
            )}
          </TooltipPopup>
        </Tooltip>
        {running ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-micro"
                  className="cursor-pointer"
                  aria-label={`Start ${label} now`}
                  disabled={!actions.canChange}
                  onClick={() => void actions.startNow(entry.id)}
                />
              }
            >
              <RocketIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="top">Start now, even if the Mac is busy</TooltipPopup>
          </Tooltip>
        )}
        <RowMenu
          entry={entry}
          entries={entries}
          state={state}
          actions={actions}
          priority={rule?.priority ?? "normal"}
          projectRoot={project?.workspaceRoot ?? null}
          onOpenThread={threadId === null ? null : () => onOpenThread(threadId)}
        />
      </div>
      <div className="mt-0.5 ml-6.5 flex min-w-0 items-center gap-1.5 text-3xs text-muted-foreground">
        {/* A project-scoped list already names the project. */}
        {project !== undefined && project.id === scopeProjectId ? null : (
          <span className="flex min-w-0 max-w-[40%] shrink-0 items-center gap-1">
            {project === undefined ? null : (
              <ProjectFavicon project={project} className="size-3 shrink-0" />
            )}
            <span className="truncate">
              {project?.title ?? entry.cwd.split(/[\\/]/).findLast(Boolean)}
            </span>
          </span>
        )}
        {RuleIcon === null || rule === undefined ? null : (
          <Hint label={`Project priority: ${PRIORITY_LABEL[rule.priority]}`} Icon={RuleIcon} />
        )}
        {cpuLabel === null ? null : <Hint label={cpuLabel} Icon={SnailIcon} />}
        {threadId === null ? null : (
          <button
            type="button"
            className="flex min-w-0 max-w-[40%] shrink-0 cursor-pointer items-center gap-0.5 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring [&>svg]:size-3 [&>svg]:shrink-0"
            onClick={() => onOpenThread(threadId)}
          >
            <MessageSquareIcon aria-hidden />
            <span className="truncate hover:underline">{title ?? "Open thread"}</span>
          </button>
        )}
        {usage === null ? null : <TruncatedText text={usage} className="min-w-0 flex-1" />}
      </div>
      {detail === "" ? null : (
        <div className="mt-0.5 ml-6.5 flex min-w-0 items-center gap-1 text-3xs text-muted-foreground [&>svg]:size-3 [&>svg]:shrink-0">
          <InfoIcon aria-hidden />
          <TruncatedText text={detail} className="min-w-0" />
        </div>
      )}
      {entry.ask === undefined ? null : (
        <AskPrompt entry={entry} ask={entry.ask} state={state} actions={actions} now={now} />
      )}
      {running || entry.unconfirmed !== true ? null : (
        <div className="mt-1 ml-6.5 text-3xs text-muted-foreground">{RUNNER_UNCONFIRMED_NOTE}</div>
      )}
    </div>
  );
}

const NO_THREAD_PROJECT = () => undefined;

const MACHINE = {
  mac: { name: "This Mac", Icon: LaptopIcon },
  linux: { name: "Linux", Icon: ServerIcon },
} as const;

const LINUX_STATUS = (online: boolean | null) =>
  online === null
    ? { text: "checking", dot: "bg-muted-foreground/60" }
    : online
      ? { text: "online", dot: "bg-success" }
      : { text: "offline", dot: "bg-destructive" };

/** A machine's name, status and readings on one row; the whole-queue control sits at its right. */
function MachineHeader({
  runner,
  summary,
  host,
  queueOn,
  children,
}: {
  readonly runner: HeavyRunner;
  readonly summary: MachineSummary | null;
  readonly host: string | null;
  readonly queueOn: boolean;
  readonly children?: ReactNode;
}) {
  const { name, Icon } = MACHINE[runner];
  // A job can outlive the Runner on Linux; with no heartbeat there is no status to show.
  const status = runner === "linux" && summary !== null ? LINUX_STATUS(summary.online) : null;
  // Linux's readings are stale while it is offline or unchecked; the Mac's slots mean nothing with the queue off.
  const live = summary !== null && summary.online === true;
  const showSlots = live && (runner === "linux" || queueOn);
  const load = summary?.load ?? null;
  const cpuCount = summary?.cpuCount ?? null;
  return (
    <>
      <div className="flex items-center gap-1.5 py-1.5 pl-2 pr-3 text-3xs text-muted-foreground">
        <span className="flex size-5 shrink-0 items-center justify-center [&>svg]:size-3.5">
          <Icon aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {host === null ? (
            <span className="truncate text-xs font-medium text-foreground/90">{name}</span>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="cursor-default truncate text-xs font-medium text-foreground/90" />
                }
              >
                {name}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {host} · {status?.text}
              </TooltipPopup>
            </Tooltip>
          )}
          {status === null ? null : (
            <span className={cn("size-1.5 shrink-0 rounded-full", status.dot)}>
              <span className="sr-only">{status.text}</span>
            </span>
          )}
        </span>
        {!showSlots || summary === null ? null : (
          <Hint label={`${summary.running} of ${summary.slots} running`} Icon={PlayIcon}>
            {summary.running}/{summary.slots}
          </Hint>
        )}
        {!live || summary.cpuPercent === null ? null : (
          <Hint label={`CPU ${summary.cpuPercent}%`} Icon={CpuIcon}>
            {summary.cpuPercent}%
          </Hint>
        )}
        {!live || load === null ? null : (
          <Hint
            label={`load ${load.toFixed(1)}${cpuCount === null ? "" : ` on ${cpuCount} cores`}`}
            Icon={CpuIcon}
          >
            {load.toFixed(1)}
            {cpuCount === null ? "" : `/${cpuCount}`}
          </Hint>
        )}
        {!live || summary.freeBytes === null ? null : (
          <Hint label={`${formatFreeMemory(summary.freeBytes)} free`} Icon={MemoryStickIcon}>
            {formatFreeMemory(summary.freeBytes)}
          </Hint>
        )}
        {children}
      </div>
      {summary === null || summary.note === null ? null : (
        <div className="-mt-1 flex items-start gap-1.5 pb-1.5 pl-2 pr-3 text-3xs text-muted-foreground">
          <span className="flex h-3.5 w-5 shrink-0 items-center justify-center [&>svg]:size-3">
            <InfoIcon aria-hidden />
          </span>
          <span className="min-w-0">{summary.note}</span>
        </div>
      )}
    </>
  );
}

function MachineGroup({
  rows,
  waiting,
  actions,
  header,
  renderRow,
}: {
  readonly rows: ReadonlyArray<HeavyQueueEntry>;
  /** Every waiter on this machine in run order, shown or not: places and moves count them all. */
  readonly waiting: ReadonlyArray<HeavyQueueEntry>;
  readonly actions: Actions;
  readonly header: ReactNode;
  readonly renderRow: (entry: HeavyQueueEntry, position: number | null) => ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null) return;
    const target = dropTarget(waiting, String(active.id), String(over.id));
    if (target !== undefined) void actions.move(String(active.id), target);
  };
  return (
    <div className="border-t border-foreground/8 first:border-t-0">
      {header}
      {/* One drag context per machine, so a waiter cannot be dropped into the other machine's line. */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={DRAG_MODIFIERS}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={rows.filter((entry) => entry.startedAt === null).map((entry) => entry.id)}
          strategy={verticalListSortingStrategy}
        >
          {rows.map((entry) =>
            renderRow(
              entry,
              entry.startedAt === null ? waiting.findIndex((w) => w.id === entry.id) + 1 : null,
            ),
          )}
        </SortableContext>
      </DndContext>
    </div>
  );
}

/**
 * The popover's heavy-work section, grouped by machine: each one's readings and note, the pause,
 * and its entries in run order. With `projectId` it lists that project's entries only, at their
 * places on their machine, and leaves the whole-queue switches to the Resource Manager.
 */
export function HeavyQueueBody({
  environmentId,
  threadTitle,
  projectIdOfThread = NO_THREAD_PROJECT,
  onOpenThread,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadTitle: (threadId: string) => string | undefined;
  readonly projectIdOfThread?: (threadId: string) => string | undefined;
  readonly onOpenThread: (threadId: string) => void;
  readonly projectId?: string;
}) {
  const state = useHeavyQueue(environmentId);
  const actions = useHeavyQueueActions(environmentId);
  const projects = useProjects();
  const { entries } = state;
  const shown =
    projectId === undefined
      ? entries
      : heavyItemsInProject(entries, {
          projectId,
          projects: projects.filter((project) => project.environmentId === environmentId),
          projectIdOfThread,
        });
  const now = useAskClock(entries.some((entry) => entry.ask !== undefined));
  const summaries = machineSummaries(state);
  const machineOf = (entry: HeavyQueueEntry) => runnerBadge(entry, state)?.runner ?? "mac";
  const groups = (["mac", "linux"] as const)
    .map((runner) => ({
      runner,
      summary: runner === "mac" ? summaries.mac : summaries.linux,
      rows: shown.filter((entry) => machineOf(entry) === runner),
      waiting: entries.filter((entry) => entry.startedAt === null && machineOf(entry) === runner),
    }))
    // Linux stays visible while the Runner is on, and while a job still runs there after it went off.
    .filter((group) => group.runner === "mac" || group.summary !== null || group.rows.length > 0);
  return (
    <div>
      {groups.map(({ runner, summary, rows, waiting }) => (
        <MachineGroup
          key={runner}
          rows={rows}
          waiting={waiting}
          actions={actions}
          header={
            <MachineHeader
              runner={runner}
              summary={summary}
              host={runner === "linux" ? (state.linux?.host ?? null) : null}
              queueOn={state.enabled}
            >
              {runner === "linux" || projectId !== undefined ? null : state.enabled ? (
                <label className="ml-1 flex shrink-0 cursor-pointer items-center gap-1.5">
                  Pause
                  <Switch
                    size="sm"
                    checked={state.paused}
                    disabled={!actions.canChange}
                    onCheckedChange={(checked) => void actions.setPaused(Boolean(checked))}
                    aria-label="Pause the heavy work queue"
                  />
                </label>
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  className="ml-1"
                  disabled={!actions.canChange}
                  onClick={() => void actions.setEnabled(true)}
                >
                  Turn on
                </Button>
              )}
            </MachineHeader>
          }
          renderRow={(entry, position) => (
            <Row
              key={entry.id}
              entry={entry}
              entries={waiting}
              position={position}
              state={state}
              actions={actions}
              now={entry.ask === undefined ? 0 : now}
              threadTitle={threadTitle}
              projectIdOfThread={projectIdOfThread}
              onOpenThread={onOpenThread}
              scopeProjectId={projectId}
            />
          )}
        />
      ))}
    </div>
  );
}
