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
  moveTarget,
  ordinal,
  PRIORITY_LABEL,
  projectForCwd,
  queueSummary,
  readableLabel,
  ruleForRoot,
  usageLine,
  type MoveAction,
} from "@t3tools/client-runtime/state/heavyQueueModel";
import {
  ASK_TITLE,
  askRemaining,
  linuxLine,
  routeActions,
  RUNNER_DEADLINE_LABEL,
  RUNNER_POLICY_LABEL,
  runnerBadge,
  RUNNER_UNCONFIRMED_NOTE,
} from "@t3tools/client-runtime/state/runnerModel";
import type { EnvironmentId, HeavyQueueEntry } from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpIcon,
  ArrowUpToLineIcon,
  EllipsisIcon,
  GripVerticalIcon,
  HourglassIcon,
  LaptopIcon,
  MessageSquareIcon,
  PlayIcon,
  RocketIcon,
  ServerIcon,
  SnailIcon,
  SquareIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

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

export function Elapsed({ since, prefix }: { readonly since: string; readonly prefix: string }) {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- coarse timer so the elapsed time does not repaint continuously
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      {prefix} {formatDuration(since, now)}
    </>
  );
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
        {entry.priority === "high" ? null : (
          <MenuItem
            disabled={!actions.canChange}
            onClick={() => void actions.setPriority(entry.id, "high")}
          >
            <ZapIcon aria-hidden />
            High priority now
          </MenuItem>
        )}
        {running ? (
          <MenuItem
            disabled={!actions.canChange}
            onClick={() => void actions.setPriority(entry.id, "low")}
          >
            <SnailIcon aria-hidden />
            Lower priority
          </MenuItem>
        ) : null}
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

function Row({
  entry,
  entries,
  position,
  state,
  actions,
  now,
  threadTitle,
  onOpenThread,
}: {
  readonly entry: HeavyQueueEntry;
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  readonly position: number | null;
  readonly state: QueueState;
  readonly now: number;
  readonly actions: Actions;
  readonly threadTitle: (threadId: string) => string | undefined;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const running = position === null;
  const projects = useProjects();
  const project = projectForCwd(projects, entry.cwd);
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
  const command = readableLabel(entry.label);
  const title = entry.threadId === null ? undefined : threadTitle(entry.threadId);
  const usage = usageLine(entry, state);
  const detail = [state.reasons[entry.id], entry.note].filter(Boolean).join(" · ");
  const badge = runnerBadge(entry, state);
  const Icon = running ? PlayIcon : HourglassIcon;
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
            <Icon aria-hidden />
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
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-3xs text-muted-foreground">
            {project === undefined ? null : (
              <ProjectFavicon project={project} className="size-3.5 shrink-0" />
            )}
            <span className="truncate">
              {project?.title ?? entry.cwd.split(/[\\/]/).findLast(Boolean)}
            </span>
            {rule === undefined ? null : (
              <span className="shrink-0 rounded-sm bg-foreground/8 px-1">
                {PRIORITY_LABEL[rule.priority]}
              </span>
            )}
            {badge === null ? null : (
              <span className="shrink-0 rounded-sm bg-foreground/8 px-1">{badge.label}</span>
            )}
          </div>
          <div className="truncate text-xs font-medium text-foreground/90">{label}</div>
          {command === label ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <div className="cursor-default truncate font-mono text-3xs text-muted-foreground" />
                }
              >
                {command}
              </TooltipTrigger>
              <TooltipPopup side="top" className="max-w-sm break-all">
                {entry.label}
              </TooltipPopup>
            </Tooltip>
          )}
          {usage === null ? null : (
            <div className="truncate text-3xs text-muted-foreground">{usage}</div>
          )}
          <div className="flex min-w-0 items-center gap-1 text-3xs text-muted-foreground">
            {entry.threadId === null ? null : (
              <button
                type="button"
                className="min-w-0 max-w-[60%] shrink-0 cursor-pointer truncate rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onOpenThread(entry.threadId!)}
              >
                {title ?? "Open thread"}
              </button>
            )}
            {detail === "" ? null : (
              <span className="truncate">
                {entry.threadId === null ? "" : "· "}
                {detail}
              </span>
            )}
          </div>
        </div>
        <span className="shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
          {entry.startedAt === null ? (
            <>
              {ordinal(position ?? 0)}
              <span className="block text-3xs">
                <Elapsed since={entry.createdAt} prefix="waited" />
              </span>
            </>
          ) : (
            <Elapsed since={entry.startedAt} prefix="Running ·" />
          )}
        </span>
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
          onOpenThread={entry.threadId === null ? null : () => onOpenThread(entry.threadId!)}
        />
      </div>
      {entry.ask === undefined ? null : (
        <AskPrompt entry={entry} ask={entry.ask} state={state} actions={actions} now={now} />
      )}
      {running || entry.unconfirmed !== true ? null : (
        <div className="mt-1 ml-6.5 text-3xs text-muted-foreground">{RUNNER_UNCONFIRMED_NOTE}</div>
      )}
    </div>
  );
}

/** The popover's heavy-work section: slot summary, pause, and the entries in run order. */
export function HeavyQueueBody({
  environmentId,
  threadTitle,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadTitle: (threadId: string) => string | undefined;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const state = useHeavyQueue(environmentId);
  const actions = useHeavyQueueActions(environmentId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const { entries } = state;
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null) return;
    const target = dropTarget(entries, String(active.id), String(over.id));
    if (target !== undefined) void actions.move(String(active.id), target);
  };
  const waiting = entries.filter((entry) => entry.startedAt === null);
  const now = useAskClock(entries.some((entry) => entry.ask !== undefined));
  return (
    <div>
      <div className="flex items-center gap-2 py-1.5 pl-10 pr-3">
        <span className="min-w-0 flex-1 truncate text-3xs text-muted-foreground">
          {queueSummary(state)}
        </span>
        {state.enabled ? (
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-3xs text-muted-foreground">
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
            disabled={!actions.canChange}
            onClick={() => void actions.setEnabled(true)}
          >
            Turn on
          </Button>
        )}
      </div>
      {state.linux === null ? null : (
        <div className="truncate pb-1.5 pl-10 pr-3 text-3xs text-muted-foreground">
          {linuxLine(state.linux)}
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={DRAG_MODIFIERS}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={waiting.map((entry) => entry.id)}
          strategy={verticalListSortingStrategy}
        >
          {entries.map((entry) => (
            <Row
              key={entry.id}
              entry={entry}
              entries={entries}
              position={
                entry.startedAt === null ? waiting.findIndex((w) => w.id === entry.id) + 1 : null
              }
              state={state}
              actions={actions}
              now={entry.ask === undefined ? 0 : now}
              threadTitle={threadTitle}
              onOpenThread={onOpenThread}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}
