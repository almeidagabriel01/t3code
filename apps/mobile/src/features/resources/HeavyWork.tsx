import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  formatDuration,
  HEAVY_COMMAND_SOURCE_LABEL,
  heavyCommandKey,
  heavyItemsInProject,
  heavyWork,
  heavyWorkItems,
  jobPriority,
  machineSummaries,
  moveTarget,
  ordinal,
  PRIORITY_CHANGE,
  PRIORITY_LABEL,
  projectForCommand,
  ruleForRoot,
  runningUsageLine,
  usageLine,
  type MoveAction,
  type PriorityChange,
} from "@t3tools/client-runtime/state/heavyQueueModel";
import {
  ASK_TITLE,
  askRemaining,
  moveAllActions,
  RUNNER_NAME,
  RUNNER_PHASE_LABEL,
  RUNNER_POLICY_LABEL,
  RUNNER_UNCONFIRMED_NOTE,
  routeActions,
  runnerBadge,
  type RouteAction,
} from "@t3tools/client-runtime/state/runnerModel";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { heavyEntryName } from "@t3tools/shared/heavyEntryName";
import {
  ThreadId,
  type EnvironmentId,
  type HeavyCommand,
  type HeavyQueueEntry,
  type HeavyQueueState,
  type HeavyRunner,
  type HeavyRunnerPhase,
} from "@t3tools/contracts";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Alert, Platform, Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { RowMenuButton } from "../../components/ui/RowMenuButton";
import { useProjects, useQuietThreadShells, useThreadShell } from "../../state/entities";
import {
  heavyQueueEnvironment,
  useHeavyCommandsState,
  useHeavyQueueState,
} from "../../state/heavyQueue";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";

const PRIORITY_CHANGE_ROW: Record<PriorityChange, { icon: string; label: string }> = {
  "high-now": { icon: "bolt.horizontal.circle", label: "High priority now" },
  normal: { icon: "gauge.with.dots.needle.50percent", label: "Normal priority" },
  lower: { icon: "arrow.down.circle", label: "Lower priority" },
};

export const MACHINE = {
  mac: { name: "This Mac", icon: "laptopcomputer" },
  linux: { name: "Linux", icon: "server.rack" },
} as const satisfies Record<HeavyRunner, { name: string; icon: AppSymbolName }>;

const PHASE_ICON = {
  syncing: "arrow.clockwise",
  installing: "cube",
  running: "play",
} as const satisfies Record<HeavyRunnerPhase, AppSymbolName>;

const SOURCE_ICON = {
  queue: "robot",
  agent: "robot",
  terminal: "chevron.left.forwardslash.chevron.right",
  detached: "cable.connector",
} as const satisfies Record<HeavyCommand["source"], AppSymbolName>;

/** A clock for elapsed times; coarse so rows do not repaint continuously. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- coarse timer for the elapsed times
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Keeps the items that belong to `projectId`, matched by cwd or by their thread's project. */
function useProjectFilter(environmentId: EnvironmentId, projectId: string | undefined) {
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const threads = useQuietThreadShells();
  return <T extends Pick<HeavyCommand, "threadId"> & { readonly cwd?: string | undefined }>(
    items: ReadonlyArray<T>,
  ): ReadonlyArray<T> =>
    projectId === undefined
      ? items
      : heavyItemsInProject(items, {
          projectId,
          projects,
          projectIdOfThread: (threadId) =>
            threads.find(
              (thread) => thread.environmentId === environmentId && thread.id === threadId,
            )?.projectId,
        });
}

interface QueueActions {
  readonly canChange: boolean;
  readonly canRoute: boolean;
  readonly canRouteAll: boolean;
  readonly moveAll: (runner: HeavyRunner) => void;
  readonly move: (id: string, beforeId: string | null) => void;
  readonly startNow: (entry: HeavyQueueEntry) => void;
  readonly cancel: (entry: HeavyQueueEntry) => void;
  readonly setPriority: (id: string, priority: "low" | "high") => void;
  readonly setRule: (root: string, priority: "first" | "last" | null) => void;
  readonly route: (entry: HeavyQueueEntry, action: RouteAction) => void;
  readonly setPaused: (paused: boolean) => void;
  readonly setEnabled: (enabled: boolean) => void;
}

/** The queue's commands for one environment, each destructive one behind an alert. */
function useHeavyQueueActions(environmentId: EnvironmentId, state: HeavyQueueState): QueueActions {
  const canChange = useAtomValue(heavyQueueEnvironment.move.permissionAtom(environmentId));
  const canRoute = useAtomValue(heavyQueueEnvironment.route.permissionAtom(environmentId));
  const canRouteAll = useAtomValue(heavyQueueEnvironment.routeAll.permissionAtom(environmentId));
  const routeAll = useAtomCommand(heavyQueueEnvironment.routeAll);
  const route = useAtomCommand(heavyQueueEnvironment.route);
  const move = useAtomCommand(heavyQueueEnvironment.move);
  const startNow = useAtomCommand(heavyQueueEnvironment.startNow);
  const cancel = useAtomCommand(heavyQueueEnvironment.cancel);
  const setRule = useAtomCommand(heavyQueueEnvironment.setRule);
  const setPriority = useAtomCommand(heavyQueueEnvironment.setPriority);
  const setPaused = useAtomCommand(heavyQueueEnvironment.setPaused);
  const setEnabled = useAtomCommand(heavyQueueEnvironment.setEnabled);
  const machineOf = (entry: HeavyQueueEntry) => runnerBadge(entry, state)?.runner ?? "mac";
  return {
    canChange,
    canRoute,
    canRouteAll,
    moveAll: (runner) => void routeAll({ environmentId, input: { runner } }),
    setPriority: (id, priority) => void setPriority({ environmentId, input: { id, priority } }),
    move: (id, beforeId) => void move({ environmentId, input: { id, beforeId } }),
    setRule: (root, priority) => void setRule({ environmentId, input: { root, priority } }),
    setPaused: (paused) => void setPaused({ environmentId, input: { paused } }),
    setEnabled: (enabled) => void setEnabled({ environmentId, input: { enabled } }),
    route: (entry, action) => {
      const send = () =>
        void route({
          environmentId,
          input: { id: entry.id, runner: action.runner, force: action.force },
        });
      if (action.confirm === null) return send();
      Alert.alert(heavyEntryName(entry), action.confirm, [
        { text: "Keep", style: "cancel" },
        { text: action.label, style: "destructive", onPress: send },
      ]);
    },
    startNow: (entry) =>
      Alert.alert(
        "Start now?",
        `${heavyEntryName(entry)} starts now on ${RUNNER_NAME[machineOf(entry)]}, even if it is busy.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Start now",
            onPress: () => void startNow({ environmentId, input: { id: entry.id } }),
          },
        ],
      ),
    cancel: (entry) =>
      Alert.alert(
        entry.startedAt === null ? "Remove from the queue?" : "Stop the running command?",
        heavyEntryName(entry),
        [
          { text: "Keep", style: "cancel" },
          {
            text: entry.startedAt === null ? "Remove" : "Stop",
            style: "destructive",
            onPress: () => void cancel({ environmentId, input: { id: entry.id } }),
          },
        ],
      ),
  };
}

/** Stops a heavy command after an alert: a direct one by its process, a queued one through the queue. */
function useStopHeavyCommand(environmentId: EnvironmentId) {
  const canStop = useAtomValue(heavyQueueEnvironment.stopCommand.permissionAtom(environmentId));
  const stopCommand = useAtomCommand(heavyQueueEnvironment.stopCommand);
  const cancel = useAtomCommand(heavyQueueEnvironment.cancel);
  const stop = (command: HeavyCommand) =>
    Alert.alert("Stop this command?", `${command.name} receives a termination signal.`, [
      { text: "Keep", style: "cancel" },
      {
        text: "Stop",
        style: "destructive",
        onPress: async () => {
          const result =
            command.entryId === undefined
              ? await stopCommand({
                  environmentId,
                  input: { pid: command.pid, startTimeMs: command.startTimeMs },
                })
              : await cancel({ environmentId, input: { id: command.entryId } });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            Alert.alert(
              "Could not stop it",
              failure instanceof Error ? failure.message : String(failure),
            );
          }
        },
      },
    ]);
  return { canStop, stop };
}

/** A small icon whose meaning lives in the row's accessible label and its details. */
export function Glyph(props: { readonly name: AppSymbolName }) {
  return (
    <SymbolView
      name={props.name}
      size={13}
      tintColorClassName="accent-icon-subtle"
      type="monochrome"
    />
  );
}

/** One labelled fact of an expanded row; `mono` for command lines and paths. */
export interface Fact {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  /** Makes the value a link, such as a thread to open. */
  readonly onPress?: () => void;
}

function Facts(props: { readonly facts: ReadonlyArray<Fact> }) {
  return (
    <View className="gap-1.5 pr-4 pb-3 pl-13">
      {props.facts.map((fact) => (
        <View key={fact.label} className="flex-row gap-3">
          <Text textRole="footnote" className="w-24 shrink-0 text-foreground-muted">
            {fact.label}
          </Text>
          {fact.onPress === undefined ? (
            <Text
              textRole="footnote"
              selectable
              className={`min-w-0 flex-1 text-foreground${fact.mono === true ? " font-mono" : ""}`}
            >
              {fact.value}
            </Text>
          ) : (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`${fact.label}: ${fact.value}`}
              onPress={fact.onPress}
              className="min-w-0 flex-1 active:opacity-70"
            >
              <Text textRole="footnote" className="text-foreground underline">
                {fact.value}
              </Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

/** The project a heavy row belongs to, or its folder when no project holds it. */
function ProjectChip(props: { readonly title: string | undefined }) {
  if (props.title === undefined) return null;
  return (
    <View className="max-w-40 min-w-0 shrink flex-row items-center gap-1 rounded-full bg-subtle px-1.5 py-0.5">
      <Glyph name="folder" />
      <Text textRole="caption" className="shrink text-foreground-muted" numberOfLines={1}>
        {props.title}
      </Text>
    </View>
  );
}

/**
 * A heavy row: status icon, name, project chip and a short state. A press keeps every fact open
 * below it; prompts that need an answer stay under the row.
 */
export function HeavyRow(props: {
  readonly name: string;
  readonly icon: AppSymbolName;
  readonly iconLabel: string;
  readonly active?: boolean;
  readonly project: string | undefined;
  readonly state: string;
  /** Shown only when the eye needs it, such as why a job waits. */
  readonly secondLine?: string | undefined;
  readonly facts: ReadonlyArray<Fact>;
  /** More to show while open, under the facts, such as a row's processes. */
  readonly details?: ReactNode;
  readonly menu: ReactNode;
  readonly children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const second =
    props.secondLine === undefined || props.secondLine === "" ? null : props.secondLine;
  return (
    <View>
      <View className="flex-row items-center">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[props.name, props.iconLabel, props.state, props.project, second]
            .filter(Boolean)
            .join(", ")}
          accessibilityState={{ expanded: open }}
          accessibilityHint={open ? "Hides the details" : "Shows the details"}
          onPress={() => setOpen((value) => !value)}
          className="min-w-0 flex-1 flex-row items-start gap-3 py-3 pl-4 active:opacity-70"
        >
          <View className="h-6 w-6 items-center justify-center">
            <SymbolView
              name={props.icon}
              size={Platform.OS === "android" ? 20 : 18}
              tintColorClassName={
                props.active === true ? "accent-adaptive-emerald-600-400" : "accent-icon"
              }
              type="monochrome"
            />
          </View>
          <View className="min-w-0 flex-1 gap-1">
            <View className="flex-row items-center gap-2">
              <Text textRole="body" className="min-w-0 flex-1 text-foreground" numberOfLines={1}>
                {props.name}
              </Text>
              <Text textRole="footnote" className="shrink-0 text-foreground-muted tabular-nums">
                {props.state}
              </Text>
            </View>
            {props.project === undefined && second === null ? null : (
              <View className="flex-row items-center gap-2">
                <ProjectChip title={props.project} />
                {second === null ? null : (
                  <Text
                    textRole="footnote"
                    className="min-w-0 flex-1 text-foreground-muted"
                    numberOfLines={1}
                  >
                    {second}
                  </Text>
                )}
              </View>
            )}
          </View>
        </Pressable>
        <View className="pr-2 pl-1">{props.menu}</View>
      </View>
      {props.children}
      {open && props.facts.length > 0 ? <Facts facts={props.facts} /> : null}
      {open ? props.details : null}
    </View>
  );
}

const ASK_MAC: RouteAction = {
  runner: "mac",
  label: RUNNER_POLICY_LABEL.mac,
  confirm: null,
  force: false,
};
const ASK_WAIT: RouteAction = {
  runner: "linux",
  label: RUNNER_POLICY_LABEL.wait,
  confirm: null,
  force: false,
};

function RunnerAskRows(props: {
  readonly entry: HeavyQueueEntry;
  readonly ask: NonNullable<HeavyQueueEntry["ask"]>;
  readonly actions: QueueActions;
}) {
  const { entry, actions } = props;
  const now = useNow(1000);
  return (
    <>
      <ListRowLayout
        icon="exclamationmark.triangle"
        label={ASK_TITLE[props.ask.reason]}
        description="Choose where it runs before the time runs out."
        detail={askRemaining(props.ask.deadlineAt, now)}
      />
      <SettingsActionRow
        icon="laptopcomputer"
        label={ASK_MAC.label}
        disabled={!actions.canRoute}
        onPress={() => actions.route(entry, ASK_MAC)}
      />
      <SettingsActionRow
        icon="hourglass"
        label={ASK_WAIT.label}
        disabled={!actions.canRoute}
        onPress={() => actions.route(entry, ASK_WAIT)}
      />
      <SettingsActionRow
        icon="xmark"
        label="Cancel"
        tone="danger"
        disabled={!actions.canChange}
        onPress={() => actions.cancel(entry)}
      />
    </>
  );
}

export function useOpenThread(environmentId: EnvironmentId) {
  const selectDetail = useSelectWorkspaceDetail();
  return (threadId: string) =>
    selectDetail({ name: "Thread", params: { environmentId: String(environmentId), threadId } });
}

export const menuItem = (
  id: string,
  title: string,
  image: string,
  disabled = false,
): MenuAction => ({
  id,
  title,
  image,
  attributes: { disabled },
});

function QueueRow(props: {
  readonly environmentId: EnvironmentId;
  /** The waiters of this row's machine, in run order: places and moves stay inside its line. */
  readonly line: ReadonlyArray<HeavyQueueEntry>;
  readonly entry: HeavyQueueEntry;
  readonly runner: HeavyRunner;
  readonly state: HeavyQueueState;
  readonly position: number | null;
  readonly actions: QueueActions;
  readonly now: number;
  readonly scopeProjectId: string | undefined;
}) {
  const { entry, line, position, actions, state, runner, now } = props;
  const projects = useProjects().filter((p) => p.environmentId === props.environmentId);
  const openThread = useOpenThread(props.environmentId);
  const thread = useThreadShell(
    entry.threadId === null
      ? null
      : scopeThreadRef(props.environmentId, ThreadId.make(entry.threadId)),
  );
  const project = projectForCommand(entry, projects, () => thread?.projectId);
  const rule = project === undefined ? undefined : ruleForRoot(state.rules, project.workspaceRoot);
  const name = heavyEntryName(entry);
  const running = position === null;
  const onLinux = runner === "linux";
  const routes = routeActions(entry, state);
  const priority = jobPriority(entry);
  const reason = state.reasons[entry.id];
  const phase = entry.phase === undefined ? null : RUNNER_PHASE_LABEL[entry.phase];
  const machine = onLinux
    ? `Linux${state.linux === null ? "" : ` (${state.linux.host})`}`
    : MACHINE.mac.name;
  const waited = formatDuration(entry.createdAt, now);
  const ran = formatDuration(entry.startedAt ?? entry.createdAt, now);
  const facts: ReadonlyArray<Fact> = [
    { label: "Command", value: entry.label, mono: true },
    { label: "Folder", value: entry.cwd, mono: true },
    ...(entry.threadId === null
      ? []
      : [
          {
            label: "Thread",
            value: thread?.title ?? "Open thread",
            onPress: () => openThread(entry.threadId!),
          },
        ]),
    {
      label: running ? "Runs on" : "Waits for",
      value: running && onLinux && phase !== null ? `${machine} · ${phase}` : machine,
    },
    ...(entry.remote === undefined
      ? []
      : [{ label: "Run folder", value: `~/runs/${entry.remote.id}`, mono: true }]),
    running
      ? { label: "Running", value: ran }
      : { label: "Waiting", value: `${ordinal(position ?? 0)} in line · ${waited}` },
    {
      label: "Priority",
      value: [`Project: ${PRIORITY_LABEL[rule?.priority ?? "normal"]}`, priority.label]
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
  const can = (action: MoveAction) =>
    actions.canChange && moveTarget(line, entry.id, action) !== undefined;
  const menu: MenuAction[] = [
    ...(entry.ask === undefined
      ? routes.map((route) =>
          menuItem(
            `route:${route.runner}`,
            route.label,
            MACHINE[route.runner].icon,
            !actions.canRoute,
          ),
        )
      : []),
    ...(running
      ? []
      : [
          menuItem("next", "Run next", "arrow.up.circle", !can("next")),
          {
            ...menuItem("start-now", "Start now", "bolt.circle", !actions.canChange),
            subtitle: `Skips the wait on ${RUNNER_NAME[runner]}`,
          },
          menuItem("up", "Move up", "arrow.up", !can("up")),
          menuItem("down", "Move down", "arrow.down", !can("down")),
          menuItem("end", "Move to end", "arrow.down.to.line", !can("end")),
        ]),
    ...priority.changes.map((change) =>
      menuItem(
        `priority:${change}`,
        PRIORITY_CHANGE_ROW[change].label,
        PRIORITY_CHANGE_ROW[change].icon,
        !actions.canChange,
      ),
    ),
    ...(entry.threadId === null ? [] : [menuItem("thread", "Open thread", "bubble.left")]),
    ...(project === undefined
      ? []
      : [menuItem("rule", "Priority for this project", "tag", !actions.canChange)]),
    ...((running && entry.server === true) || entry.ask !== undefined
      ? []
      : [
          {
            ...menuItem("cancel", running ? "Stop" : "Remove", running ? "xmark" : "trash"),
            attributes: { disabled: !actions.canChange, destructive: true },
          },
        ]),
  ];
  const run = (id: string) => {
    if (id === "next" || id === "up" || id === "down" || id === "end") {
      const target = moveTarget(line, entry.id, id);
      if (target !== undefined) actions.move(entry.id, target);
    } else if (id === "start-now") actions.startNow(entry);
    else if (id.startsWith("priority:"))
      actions.setPriority(entry.id, PRIORITY_CHANGE[id.slice(9) as PriorityChange]);
    else if (id === "thread" && entry.threadId !== null) openThread(entry.threadId);
    else if (id === "rule" && project !== undefined)
      Alert.alert("Priority for this project", project.title, [
        {
          text: PRIORITY_LABEL.first,
          onPress: () => actions.setRule(project.workspaceRoot, "first"),
        },
        {
          text: PRIORITY_LABEL.last,
          onPress: () => actions.setRule(project.workspaceRoot, "last"),
        },
        {
          text: PRIORITY_LABEL.normal,
          onPress: () => actions.setRule(project.workspaceRoot, null),
        },
      ]);
    else if (id === "cancel") actions.cancel(entry);
    else {
      const route = routes.find((candidate) => `route:${candidate.runner}` === id);
      if (route !== undefined) actions.route(entry, route);
    }
  };
  const inScope = project !== undefined && project.id === props.scopeProjectId;
  return (
    <HeavyRow
      name={name}
      icon={running ? PHASE_ICON[entry.phase ?? "running"] : "hourglass"}
      iconLabel={running ? (onLinux && phase !== null ? phase : "Running") : "Waiting"}
      active={running}
      project={inScope ? undefined : (project?.title ?? entry.cwd.split(/[\\/]/).findLast(Boolean))}
      state={
        running
          ? onLinux && phase !== null && entry.phase !== "running"
            ? phase
            : ran
          : `${ordinal(position ?? 0)} · ${waited}`
      }
      secondLine={running ? undefined : reason}
      facts={facts}
      menu={<RowMenuButton label={`Actions for ${name}`} actions={menu} onAction={run} />}
    >
      {entry.ask === undefined ? null : (
        <RunnerAskRows entry={entry} ask={entry.ask} actions={actions} />
      )}
    </HeavyRow>
  );
}

/** A heavy command no queue entry covers: an agent's or terminal's own, or one outside T3. */
function HeavyCommandRow(props: {
  readonly environmentId: EnvironmentId;
  readonly command: HeavyCommand;
  readonly cpuCount: number;
  readonly stop: ReturnType<typeof useStopHeavyCommand>;
  readonly now: number;
  readonly scopeProjectId: string | undefined;
}) {
  const { command, environmentId } = props;
  const { threadId } = command;
  const thread = useThreadShell(
    threadId === null ? null : scopeThreadRef(environmentId, ThreadId.make(threadId)),
  );
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const project = projectForCommand(command, projects, () => thread?.projectId);
  const openThread = useOpenThread(environmentId);
  const ran = formatDuration(command.startedAt, props.now);
  const facts: ReadonlyArray<Fact> = [
    { label: "Command", value: command.label, mono: true },
    ...(command.cwd === undefined ? [] : [{ label: "Folder", value: command.cwd, mono: true }]),
    ...(threadId === null
      ? []
      : [
          {
            label: "Thread",
            value: thread?.title ?? "Open thread",
            onPress: () => openThread(threadId),
          },
        ]),
    { label: "Started by", value: HEAVY_COMMAND_SOURCE_LABEL[command.source] },
    { label: "Running", value: ran },
    { label: "Usage", value: runningUsageLine(command, props.cpuCount) ?? "No sample yet" },
    ...(command.reason === undefined ? [] : [{ label: "Why", value: command.reason }]),
    { label: "Process", value: `pid ${command.pid}` },
  ];
  // Nothing in T3 started a detached command, so T3 offers no Stop for it.
  const canStop = command.stoppable && command.source !== "detached";
  const menu: MenuAction[] = [
    ...(threadId === null ? [] : [menuItem("thread", "Open thread", "bubble.left")]),
    ...(canStop
      ? [
          {
            ...menuItem("stop", "Stop", "stop.fill"),
            attributes: { disabled: !props.stop.canStop, destructive: true },
          },
        ]
      : []),
  ];
  const inScope = project !== undefined && project.id === props.scopeProjectId;
  return (
    <HeavyRow
      name={command.name}
      icon={SOURCE_ICON[command.source]}
      iconLabel={HEAVY_COMMAND_SOURCE_LABEL[command.source]}
      project={
        inScope ? undefined : (project?.title ?? command.cwd?.split(/[\\/]/).findLast(Boolean))
      }
      state={ran}
      facts={facts}
      menu={
        menu.length === 0 ? null : (
          <RowMenuButton
            label={`Actions for ${command.name}`}
            actions={menu}
            onAction={(id) => {
              if (id === "thread" && threadId !== null) openThread(threadId);
              else if (id === "stop") props.stop.stop(command);
            }}
          />
        )
      }
    />
  );
}

/** Rows for heavy commands no queue entry covers, in the order given. */
export function HeavyCommandRows(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: ReadonlyArray<HeavyCommand>;
  readonly cpuCount: number;
  readonly scopeProjectId?: string;
}) {
  const stop = useStopHeavyCommand(props.environmentId);
  const now = useNow(15_000);
  return props.commands.map((command) => (
    <HeavyCommandRow
      key={heavyCommandKey(command)}
      environmentId={props.environmentId}
      command={command}
      cpuCount={props.cpuCount}
      stop={stop}
      now={now}
      scopeProjectId={props.scopeProjectId}
    />
  ));
}

/**
 * Heavy work split by machine, each running first and then waiting in its own line, with every
 * job listed once. With `projectId` it keeps that project's rows, at their places on their machine.
 */
function HeavyWorkList(props: {
  readonly environmentId: EnvironmentId;
  readonly state: HeavyQueueState;
  readonly commands: ReadonlyArray<HeavyCommand>;
  readonly cpuCount: number;
  readonly projectId?: string;
}) {
  const { environmentId, state, projectId } = props;
  const actions = useHeavyQueueActions(environmentId, state);
  const stop = useStopHeavyCommand(environmentId);
  const keep = useProjectFilter(environmentId, projectId);
  const now = useNow(15_000);
  const work = heavyWork(state, props.commands);
  const showNames =
    state.linux !== null || work.linux.running.length + work.linux.waiting.length > 0;
  const moveAlls = moveAllActions(state);
  const groups = (["mac", "linux"] as const)
    .map((runner) => ({
      runner,
      running: keep(work[runner].running),
      direct: keep(work[runner].direct),
      waiting: keep(work[runner].waiting),
      line: work[runner].waiting,
    }))
    .filter((group) => group.running.length + group.direct.length + group.waiting.length > 0);
  const row = (group: (typeof groups)[number], entry: HeavyQueueEntry, position: number | null) => (
    <QueueRow
      key={entry.id}
      environmentId={environmentId}
      line={group.line}
      entry={entry}
      runner={group.runner}
      state={state}
      position={position}
      actions={actions}
      now={now}
      scopeProjectId={projectId}
    />
  );
  return groups.map((group) => {
    const moveAll = moveAlls.find((action) => action.runner !== group.runner);
    return (
      <Fragment key={group.runner}>
        {showNames ? (
          <View className="flex-row items-center gap-1.5 px-4 pt-3 pb-1">
            <View
              accessible
              accessibilityRole="header"
              accessibilityLabel={MACHINE[group.runner].name}
              className="min-w-0 flex-1 flex-row items-center gap-1.5"
            >
              <Glyph name={MACHINE[group.runner].icon} />
              <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
                {MACHINE[group.runner].name}
              </Text>
            </View>
            {moveAll === undefined ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={moveAll.label}
                accessibilityState={{ disabled: !actions.canRouteAll }}
                disabled={!actions.canRouteAll}
                hitSlop={8}
                onPress={() => actions.moveAll(moveAll.runner)}
                className="flex-row items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1 active:opacity-70"
              >
                <Glyph name={MACHINE[moveAll.runner].icon} />
                <Text textRole="footnote" className="font-t3-medium text-foreground">
                  {moveAll.label}
                </Text>
              </Pressable>
            )}
          </View>
        ) : null}
        {group.running.map((entry) => row(group, entry, null))}
        {group.direct.map((command) => (
          <HeavyCommandRow
            key={heavyCommandKey(command)}
            environmentId={environmentId}
            command={command}
            cpuCount={props.cpuCount}
            stop={stop}
            now={now}
            scopeProjectId={projectId}
          />
        ))}
        {group.waiting.map((entry) =>
          row(group, entry, group.line.findIndex((waiter) => waiter.id === entry.id) + 1),
        )}
      </Fragment>
    );
  });
}

/** "Mac 1/3 · Linux 2/2": each machine's running jobs against its slots, as the rows count them. */
function heavyWorkCounts(state: HeavyQueueState, work: ReturnType<typeof heavyWork>) {
  const linuxSlots = machineSummaries(state).linux?.slots ?? null;
  const showLinux =
    linuxSlots !== null || work.linux.running.length + work.linux.waiting.length > 0;
  const count = (name: string, running: number, slots: number | null) =>
    `${name} ${running}${slots === null ? "" : `/${slots}`}`;
  return [
    count("Mac", work.mac.running.length, state.enabled ? state.maxRunning : null),
    ...(showLinux ? [count("Linux", work.linux.running.length, linuxSlots)] : []),
  ].join(" · ");
}

/**
 * The Resource Manager's Heavy work: per-machine counts and the queue's pause in its header.
 * Hidden while nothing runs or waits and the queue is simply on.
 */
export function HeavyWorkSection(props: {
  readonly environmentId: EnvironmentId;
  readonly state: HeavyQueueState;
  readonly commands: ReadonlyArray<HeavyCommand>;
  readonly cpuCount: number;
}) {
  const { environmentId, state } = props;
  const actions = useHeavyQueueActions(environmentId, state);
  const work = heavyWork(state, props.commands);
  const count = heavyWorkItems(work).length;
  if (count === 0 && state.enabled && !state.paused) return null;
  return (
    <SettingsSection
      title="Heavy work"
      trailing={
        <View className="flex-row items-center gap-3 pr-2">
          <Text textRole="footnote" className="text-foreground-muted tabular-nums">
            {heavyWorkCounts(state, work)}
          </Text>
          {state.enabled ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Pause the heavy work queue"
              accessibilityState={{ selected: state.paused, disabled: !actions.canChange }}
              accessibilityHint={
                state.paused
                  ? "Paused: nothing new starts. Press to resume."
                  : "Pause the queue: running jobs finish, nothing new starts."
              }
              disabled={!actions.canChange}
              hitSlop={8}
              onPress={() => actions.setPaused(!state.paused)}
              className="h-7 w-7 items-center justify-center rounded-full active:opacity-70"
            >
              <SymbolView
                name="pause"
                size={14}
                tintColorClassName={
                  state.paused ? "accent-warning-foreground" : "accent-icon-muted"
                }
                type="monochrome"
              />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityHint={machineSummaries(state).mac.note ?? undefined}
              disabled={!actions.canChange}
              hitSlop={8}
              onPress={() => actions.setEnabled(true)}
              className="rounded-full bg-subtle px-2.5 py-1 active:opacity-70"
            >
              <Text textRole="footnote" className="font-t3-medium text-foreground">
                Turn on
              </Text>
            </Pressable>
          )}
        </View>
      }
    >
      {count === 0 ? <ListRowLayout icon="checkmark" label="Nothing queued." /> : null}
      <HeavyWorkList
        environmentId={environmentId}
        state={state}
        commands={props.commands}
        cpuCount={props.cpuCount}
      />
    </SettingsSection>
  );
}

/** A project's heavy work, at its places on each machine; pause and limits live in Settings. */
export function ProjectHeavyWork(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
}) {
  const { environmentId, projectId } = props;
  const state = useHeavyQueueState(environmentId);
  const { commands, cpuCount } = useHeavyCommandsState(environmentId);
  const keep = useProjectFilter(environmentId, projectId);
  const count = keep(heavyWorkItems(heavyWork(state, commands))).length;
  return (
    <SettingsSection title="Heavy work">
      {count === 0 ? (
        <ListRowLayout
          icon="checkmark"
          label="No heavy work in this project"
          description="Tests, builds and other heavy commands from this project show here while they run or wait."
        />
      ) : (
        <HeavyWorkList
          environmentId={environmentId}
          state={state}
          commands={commands}
          cpuCount={cpuCount}
          projectId={projectId}
        />
      )}
    </SettingsSection>
  );
}
