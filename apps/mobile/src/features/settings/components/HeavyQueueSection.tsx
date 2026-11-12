import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  formatDuration,
  formatFreeMemory,
  HEAVY_COMMAND_SOURCE_LABEL,
  heavyCommandKey,
  heavyItemsInProject,
  jobPriority,
  machineSummaries,
  moveTarget,
  ordinal,
  PRIORITY_CHANGE,
  projectForCommand,
  PRIORITY_LABEL,
  projectForCwd,
  readableLabel,
  ruleForRoot,
  runningUsageLine,
  usageLine,
  type MachineSummary,
  type MoveAction,
  type PriorityChange,
} from "@t3tools/client-runtime/state/heavyQueueModel";
import {
  ASK_TITLE,
  askRemaining,
  heavyLimitIdle,
  heavyModeLine,
  RUNNER_PHASE_LABEL,
  RUNNER_POLICY_LABEL,
  routeActions,
  runnerBadge,
  type RouteAction,
  RUNNER_UNCONFIRMED_NOTE,
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
  HEAVY_QUEUE_LIMITS,
  type HeavyQueueLimitKey,
  type HeavyRunner,
  type RunnerWhere,
} from "@t3tools/contracts";
import { Fragment, useEffect, useState } from "react";
import { Alert, Platform, Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { NumberField } from "../../../components/ui/NumberField";
import { RowMenuButton } from "../../../components/ui/RowMenuButton";
import { useProjects, useQuietThreadShells, useThreadShell } from "../../../state/entities";
import {
  heavyQueueEnvironment,
  useHeavyCommandsState,
  useHeavyQueueState,
} from "../../../state/heavyQueue";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../../layout/workspace/useSelectWorkspaceDetail";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

const MAX_LIMIT = 8;
const IDLE_MINUTES = [0, 10, 20, 30, 60] as const;
const PRIORITY_CHANGE_ROW: Record<PriorityChange, { icon: string; label: string }> = {
  "high-now": { icon: "bolt.horizontal.circle", label: "High priority now" },
  normal: { icon: "gauge.with.dots.needle.50percent", label: "Normal priority" },
  lower: { icon: "arrow.down.circle", label: "Lower priority" },
};

/** Keeps the items that belong to `projectId`, matched by cwd or by their thread's project. */
function useProjectItems(environmentId: EnvironmentId, projectId: string | undefined) {
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

type Commands = {
  readonly move: (id: string, beforeId: string | null) => void;
  readonly startNow: (entry: HeavyQueueEntry) => void;
  readonly cancel: (entry: HeavyQueueEntry) => void;
  readonly setPriority: (id: string, priority: "low" | "high") => void;
  readonly setRule: (root: string, priority: "first" | "last" | null) => void;
  readonly route: (entry: HeavyQueueEntry, action: RouteAction) => void;
};

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
  readonly actions: ReadonlyArray<RouteAction>;
  readonly canRoute: boolean;
  readonly canChange: boolean;
  readonly commands: Commands;
}) {
  const { entry, commands } = props;
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one-second countdown while the question is on screen
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // Running here may need the confirmation routeActions gives a run Linux has not confirmed stopped.
  const mac = props.actions.find((action) => action.runner === "mac") ?? ASK_MAC;
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
        disabled={!props.canRoute}
        onPress={() => commands.route(entry, mac)}
      />
      <SettingsActionRow
        icon="hourglass"
        label={ASK_WAIT.label}
        disabled={!props.canRoute}
        onPress={() => commands.route(entry, ASK_WAIT)}
      />
      <SettingsActionRow
        icon="xmark"
        label="Cancel"
        tone="danger"
        disabled={!props.canChange}
        onPress={() => commands.cancel(entry)}
      />
    </>
  );
}

const MACHINE = {
  mac: { name: "This Mac", icon: "laptopcomputer" },
  linux: { name: "Linux", icon: "server.rack" },
} as const satisfies Record<HeavyRunner, { name: string; icon: AppSymbolName }>;

const RULE_ICON = { first: "chevron.up", last: "chevron.down" } as const;

/** A small icon whose meaning lives in the row's accessible label and its details. */
function Glyph(props: { readonly name: AppSymbolName }) {
  return (
    <SymbolView
      name={props.name}
      size={13}
      tintColorClassName="accent-icon-subtle"
      type="monochrome"
    />
  );
}

function QueueEntryRows(props: {
  readonly environmentId: EnvironmentId;
  /** The waiters of this row's machine, in run order: places and moves stay inside its group. */
  readonly waiting: ReadonlyArray<HeavyQueueEntry>;
  readonly entry: HeavyQueueEntry;
  readonly runner: HeavyRunner;
  readonly state: HeavyQueueState;
  readonly canRoute: boolean;
  readonly position: number | null;
  readonly canChange: boolean;
  readonly commands: Commands;
  readonly now: number;
  readonly scoped: boolean;
}) {
  const { entry, waiting, position, commands, state } = props;
  const projects = useProjects().filter((p) => p.environmentId === props.environmentId);
  const selectDetail = useSelectWorkspaceDetail();
  const thread = useThreadShell(
    entry.threadId === null
      ? null
      : scopeThreadRef(props.environmentId, ThreadId.make(entry.threadId)),
  );
  const project = projectForCommand(entry, projects, () => thread?.projectId);
  const rule = project === undefined ? undefined : ruleForRoot(state.rules, project.workspaceRoot);
  const name = heavyEntryName(entry);
  const folder = project?.title ?? entry.cwd.split(/[\\/]/).findLast(Boolean) ?? entry.cwd;
  const running = position === null;
  const routes = routeActions(entry, state);
  const priority = jobPriority(entry);
  const usage = usageLine(entry, state);
  const phase =
    entry.startedAt !== null && entry.phase !== undefined ? RUNNER_PHASE_LABEL[entry.phase] : null;
  const time =
    entry.startedAt === null
      ? `${ordinal(position ?? 0)} · ${formatDuration(entry.createdAt, props.now)}`
      : `${phase === null ? "" : `${phase} · `}${formatDuration(entry.startedAt, props.now)}`;
  const detail = [
    state.reasons[entry.id],
    entry.note,
    running || entry.unconfirmed !== true ? undefined : RUNNER_UNCONFIRMED_NOTE,
  ]
    .filter(Boolean)
    .join(" · ");
  // Everything the compact row turns into icons, for its accessible label and its details.
  const facts = [
    readableLabel(entry.label) === name ? undefined : entry.label,
    entry.startedAt === null
      ? `${ordinal(position ?? 0)} on ${MACHINE[props.runner].name} · Waiting ${formatDuration(entry.createdAt, props.now)}`
      : `Running ${formatDuration(entry.startedAt, props.now)} on ${MACHINE[props.runner].name}${phase === null ? "" : ` · ${phase}`}`,
    `Project: ${folder}`,
    `Folder: ${entry.cwd}`,
    thread?.title === undefined ? undefined : `Thread: ${thread.title}`,
    rule === undefined ? undefined : `Project priority: ${PRIORITY_LABEL[rule.priority]}`,
    priority.label ?? undefined,
    usage ?? undefined,
    detail === "" ? undefined : detail,
  ].filter((fact): fact is string => fact !== undefined);
  const openThread = () => {
    if (entry.threadId !== null)
      selectDetail({
        name: "Thread",
        params: { environmentId: String(props.environmentId), threadId: entry.threadId },
      });
  };
  const move = (action: MoveAction) => {
    const target = moveTarget(waiting, entry.id, action);
    if (target !== undefined) commands.move(entry.id, target);
  };
  const can = (action: MoveAction) =>
    props.canChange && moveTarget(waiting, entry.id, action) !== undefined;
  const item = (id: string, title: string, image: string, disabled = false): MenuAction => ({
    id,
    title,
    image,
    attributes: { disabled },
  });
  const actions: MenuAction[] = [
    ...(entry.ask === undefined
      ? routes.map((route) =>
          item(
            `route:${route.runner}`,
            route.label,
            route.runner === "mac" ? "laptopcomputer" : "server.rack",
            !props.canRoute,
          ),
        )
      : []),
    ...(running
      ? []
      : [
          item("next", "Run next", "arrow.up.circle", !can("next")),
          {
            ...item("start-now", "Start now", "bolt.circle", !props.canChange),
            subtitle: "Ignores how busy the Mac is",
          },
          item("up", "Move up", "arrow.up", !can("up")),
          item("down", "Move down", "arrow.down", !can("down")),
          item("end", "Move to end", "arrow.down.to.line", !can("end")),
        ]),
    ...priority.changes.map((change) =>
      item(
        `priority:${change}`,
        PRIORITY_CHANGE_ROW[change].label,
        PRIORITY_CHANGE_ROW[change].icon,
        !props.canChange,
      ),
    ),
    ...(entry.threadId === null ? [] : [item("thread", "Open thread", "bubble.left")]),
    ...(project === undefined
      ? []
      : [item("rule", "Priority for this project", "tag", !props.canChange)]),
    ...((running && entry.server === true) || entry.ask !== undefined
      ? []
      : [
          {
            ...item(
              "cancel",
              running ? "Stop" : "Remove",
              running ? "xmark" : "trash",
              !props.canChange,
            ),
            attributes: { disabled: !props.canChange, destructive: true },
          },
        ]),
  ];
  const run = (id: string) => {
    if (id === "next" || id === "up" || id === "down" || id === "end") move(id);
    else if (id === "start-now") commands.startNow(entry);
    else if (id.startsWith("priority:"))
      commands.setPriority(entry.id, PRIORITY_CHANGE[id.slice(9) as PriorityChange]);
    else if (id === "thread") openThread();
    else if (id === "rule" && project !== undefined)
      Alert.alert("Priority for this project", project.title, [
        {
          text: PRIORITY_LABEL.first,
          onPress: () => commands.setRule(project.workspaceRoot, "first"),
        },
        {
          text: PRIORITY_LABEL.last,
          onPress: () => commands.setRule(project.workspaceRoot, "last"),
        },
        {
          text: PRIORITY_LABEL.normal,
          onPress: () => commands.setRule(project.workspaceRoot, null),
        },
      ]);
    else if (id === "cancel") commands.cancel(entry);
    else {
      const route = routes.find((candidate) => `route:${candidate.runner}` === id);
      if (route !== undefined) commands.route(entry, route);
    }
  };
  // A project-scoped list already names the project.
  const showProject = !(props.scoped && project !== undefined);
  return (
    <>
      <View className="flex-row items-center">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[name, ...facts].join(", ")}
          accessibilityHint="Shows the details"
          onPress={() => Alert.alert(name, facts.join("\n"))}
          className="min-w-0 flex-1 flex-row items-start gap-3 py-3 pl-4 active:opacity-70"
        >
          <View className="h-6 w-6 items-center justify-center">
            <SymbolView
              name={running ? "play" : "hourglass"}
              size={Platform.OS === "android" ? 20 : 18}
              tintColorClassName="accent-icon"
              type="monochrome"
            />
          </View>
          <View className="min-w-0 flex-1 gap-1">
            <View className="flex-row items-center gap-2">
              <Text textRole="body" className="min-w-0 flex-1 text-foreground" numberOfLines={1}>
                {name}
              </Text>
              <Text textRole="footnote" className="shrink-0 text-foreground-muted tabular-nums">
                {time}
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              {showProject ? (
                <View className="min-w-0 shrink flex-row items-center gap-1">
                  <Glyph name="folder" />
                  <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
                    {folder}
                  </Text>
                </View>
              ) : null}
              {rule === undefined ? null : <Glyph name={RULE_ICON[rule.priority]} />}
              {priority.label === null ? null : <Glyph name="arrow.down.circle" />}
              {entry.threadId === null ? null : (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`Open thread ${thread?.title ?? ""}`.trim()}
                  hitSlop={8}
                  onPress={openThread}
                  className="active:opacity-70"
                >
                  <Glyph name="bubble.left" />
                </Pressable>
              )}
              {usage === null ? null : <Glyph name="chart.bar.xaxis" />}
            </View>
            {detail === "" ? null : (
              <View className="flex-row items-center gap-1">
                <Glyph name="info.circle" />
                <Text
                  textRole="footnote"
                  className="min-w-0 flex-1 text-foreground-muted"
                  numberOfLines={1}
                >
                  {detail}
                </Text>
              </View>
            )}
          </View>
        </Pressable>
        <View className="pr-2 pl-1">
          <RowMenuButton label={`Actions for ${name}`} actions={actions} onAction={run} />
        </View>
      </View>
      {entry.ask === undefined ? null : (
        <RunnerAskRows
          entry={entry}
          ask={entry.ask}
          actions={routes}
          canRoute={props.canRoute}
          canChange={props.canChange}
          commands={commands}
        />
      )}
    </>
  );
}

const LINUX_STATUS = (online: boolean | null) =>
  online === null
    ? { text: "checking", dot: "bg-foreground-muted" }
    : online
      ? { text: "online", dot: "bg-adaptive-emerald-600-400" }
      : { text: "offline", dot: "bg-danger" };

/** A machine's name, status and readings; its note follows only when there is something to say. */
function MachineHeader(props: {
  readonly runner: HeavyRunner;
  readonly summary: MachineSummary | null;
  readonly host: string | null;
  readonly queueOn: boolean;
}) {
  const { runner, summary } = props;
  const { name, icon } = MACHINE[runner];
  // A job can outlive the Runner on Linux; with no heartbeat there is no status to show.
  const status = runner === "linux" && summary !== null ? LINUX_STATUS(summary.online) : null;
  // Linux's readings are stale while it is offline or unchecked; the Mac's slots mean nothing with the queue off.
  const live = summary !== null && summary.online === true;
  const load = summary?.load ?? null;
  const cpuCount = summary?.cpuCount ?? null;
  const readings: ReadonlyArray<{ icon: AppSymbolName; label: string; text: string }> =
    summary === null || !live
      ? []
      : [
          ...(runner === "linux" || props.queueOn
            ? [
                {
                  icon: "play" as const,
                  label: `${summary.running} of ${summary.slots} running`,
                  text: `${summary.running}/${summary.slots}`,
                },
              ]
            : []),
          ...(summary.cpuPercent === null
            ? []
            : [
                {
                  icon: "gauge.with.dots.needle.50percent" as const,
                  label: `CPU ${summary.cpuPercent}%`,
                  text: `${summary.cpuPercent}%`,
                },
              ]),
          ...(load === null
            ? []
            : [
                {
                  icon: "gauge.with.dots.needle.50percent" as const,
                  label: `load ${load.toFixed(1)}${cpuCount === null ? "" : ` on ${cpuCount} cores`}`,
                  text: `${load.toFixed(1)}${cpuCount === null ? "" : `/${cpuCount}`}`,
                },
              ]),
          ...(summary.freeBytes === null
            ? []
            : [
                {
                  icon: "internaldrive" as const,
                  label: `${formatFreeMemory(summary.freeBytes)} free`,
                  text: formatFreeMemory(summary.freeBytes),
                },
              ]),
        ];
  const note = summary?.note ?? null;
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={[name, props.host, status?.text, ...readings.map((r) => r.label), note]
        .filter(Boolean)
        .join(", ")}
      className="gap-1 px-4 pt-3 pb-1"
    >
      <View className="flex-row items-center gap-2">
        <SymbolView
          name={icon}
          size={15}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <Text textRole="footnote" className="font-semibold text-foreground">
          {name}
        </Text>
        {props.host === null ? null : (
          <Text textRole="footnote" className="shrink text-foreground-muted" numberOfLines={1}>
            {props.host}
          </Text>
        )}
        {status === null ? null : <View className={`size-2 rounded-full ${status.dot}`} />}
        <View className="flex-1" />
        {readings.map((reading) => (
          <View key={reading.label} className="flex-row items-center gap-1">
            <Glyph name={reading.icon} />
            <Text textRole="footnote" className="text-foreground-muted tabular-nums">
              {reading.text}
            </Text>
          </View>
        ))}
      </View>
      {note === null ? null : (
        <View className="flex-row items-start gap-1.5">
          <Glyph name="info.circle" />
          <Text textRole="footnote" className="min-w-0 flex-1 text-foreground-muted">
            {note}
          </Text>
        </View>
      )}
    </View>
  );
}

export interface RunnerMode {
  readonly enabled: boolean;
  readonly where: RunnerWhere;
}

const LIMIT_ROWS = [
  {
    key: "macCpuCeilingPercent",
    icon: "gauge.with.dots.needle.50percent",
    label: "CPU limit",
    description: "A new job waits while this Mac's CPU is busier than this.",
  },
  {
    key: "macMemoryFloorPercent",
    icon: "internaldrive",
    label: "Keep memory free",
    description: "A new job waits while less than this share of this Mac's memory is free.",
  },
  {
    key: "heavyOverLimitSeconds",
    icon: "clock",
    label: "Over the limit for",
    description:
      "A machine counts as over its limits, or back under them, only once its readings stay there this long.",
  },
] as const satisfies ReadonlyArray<{
  key: HeavyQueueLimitKey;
  icon: AppSymbolName;
  label: string;
  description: string;
}>;
const UNIT: Record<(typeof HEAVY_QUEUE_LIMITS)[HeavyQueueLimitKey]["unit"], string> = {
  percent: "%",
  seconds: "s",
};

/** The machine's heavy queue; with `projectId`, only that project's jobs and none of the machine-wide controls. */
export function HeavyQueueSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId?: string;
  /** Effective Runner settings, for the line that says what the queue and the Runner do together. */
  readonly runner?: RunnerMode;
  /** Names the machine when Settings shows several environments' queues. */
  readonly machine?: string;
}) {
  const { environmentId, projectId, runner } = props;
  const inProject = useProjectItems(environmentId, projectId);
  const state = useHeavyQueueState(environmentId);
  const canChange = useAtomValue(heavyQueueEnvironment.move.permissionAtom(environmentId));
  const canRoute = useAtomValue(heavyQueueEnvironment.route.permissionAtom(environmentId));
  const route = useAtomCommand(heavyQueueEnvironment.route);
  const move = useAtomCommand(heavyQueueEnvironment.move);
  const startNow = useAtomCommand(heavyQueueEnvironment.startNow);
  const cancel = useAtomCommand(heavyQueueEnvironment.cancel);
  const setEnabled = useAtomCommand(heavyQueueEnvironment.setEnabled);
  const setPaused = useAtomCommand(heavyQueueEnvironment.setPaused);
  const setRule = useAtomCommand(heavyQueueEnvironment.setRule);
  const setMaxRunning = useAtomCommand(heavyQueueEnvironment.setMaxRunning);
  const setPriority = useAtomCommand(heavyQueueEnvironment.setPriority);
  const setClaudeHook = useAtomCommand(heavyQueueEnvironment.setClaudeHook);
  const setDeviceIdleMinutes = useAtomCommand(heavyQueueEnvironment.setDeviceIdleMinutes);
  const setMacMemoryFloorPercent = useAtomCommand(heavyQueueEnvironment.setMacMemoryFloorPercent);
  const setMacCpuCeilingPercent = useAtomCommand(heavyQueueEnvironment.setMacCpuCeilingPercent);
  const setHeavyOverLimitSeconds = useAtomCommand(heavyQueueEnvironment.setHeavyOverLimitSeconds);
  const setLimit = (key: HeavyQueueLimitKey, value: number) => {
    switch (key) {
      case "macMemoryFloorPercent":
        return void setMacMemoryFloorPercent({
          environmentId,
          input: { macMemoryFloorPercent: value },
        });
      case "macCpuCeilingPercent":
        return void setMacCpuCeilingPercent({
          environmentId,
          input: { macCpuCeilingPercent: value },
        });
      case "heavyOverLimitSeconds":
        return void setHeavyOverLimitSeconds({
          environmentId,
          input: { heavyOverLimitSeconds: value },
        });
    }
  };
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const commands: Commands = {
    setPriority: (id, priority) => void setPriority({ environmentId, input: { id, priority } }),
    move: (id, beforeId) => void move({ environmentId, input: { id, beforeId } }),
    setRule: (root, priority) => void setRule({ environmentId, input: { root, priority } }),
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
      Alert.alert("Start now?", `${heavyEntryName(entry)} starts even if the Mac is busy.`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Start now",
          onPress: () => void startNow({ environmentId, input: { id: entry.id } }),
        },
      ]),
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
  const { entries } = state;
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- coarse timer for the elapsed times
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const shown = inProject(entries);
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
  const rows = (
    <>
      {groups.map((group) => (
        <Fragment key={group.runner}>
          <MachineHeader
            runner={group.runner}
            summary={group.summary}
            host={group.runner === "linux" ? (state.linux?.host ?? null) : null}
            queueOn={state.enabled}
          />
          {group.rows.map((entry) => (
            <QueueEntryRows
              key={entry.id}
              environmentId={environmentId}
              waiting={group.waiting}
              entry={entry}
              runner={group.runner}
              state={state}
              canRoute={canRoute}
              position={
                entry.startedAt === null
                  ? group.waiting.findIndex((w) => w.id === entry.id) + 1
                  : null
              }
              now={now}
              canChange={canChange}
              commands={commands}
              scoped={projectId !== undefined}
            />
          ))}
        </Fragment>
      ))}
      {shown.length === 0 ? (
        <ListRowLayout
          icon="checkmark"
          label={projectId === undefined ? "Nothing queued." : "Nothing queued for this project."}
        />
      ) : null}
    </>
  );
  if (projectId !== undefined) {
    return (
      <SettingsSection
        title="Queue"
        footer="Places count every job on its machine, This Mac or Linux. Pause and limits live in Settings."
      >
        {rows}
      </SettingsSection>
    );
  }
  return (
    <SettingsSection
      title={
        props.machine === undefined ? "Heavy work queue" : `Heavy work queue · ${props.machine}`
      }
      footer="Agents queue tests, builds and simulators here. Up to the limit run at once, and the next one starts only when the machine has room."
    >
      <SettingsSwitchRow
        icon="list.number"
        label="Heavy work queue"
        subtitle={
          state.enabled
            ? "On: heavy jobs take turns, and agents ask before adding to a busy machine."
            : "Off: heavy jobs start right away and agents do not ask first."
        }
        value={state.enabled}
        disabled={!canChange}
        onValueChange={(enabled) => void setEnabled({ environmentId, input: { enabled } })}
      />
      {runner === undefined ? null : (
        <ListRowLayout
          icon="arrow.left.arrow.right"
          label={heavyModeLine({
            queueEnabled: state.enabled,
            queuePaused: state.paused,
            runnerEnabled: runner.enabled,
            where: runner.where,
          })}
        />
      )}
      {/* Pause, slots and rules act only on the queue; the limits follow heavyLimitIdle. */}
      {state.enabled ? (
        <>
          <SettingsSwitchRow
            icon="pause"
            label="Pause queue"
            subtitle="Nothing new starts while paused. Running jobs continue."
            value={state.paused}
            disabled={!canChange}
            onValueChange={(paused) => void setPaused({ environmentId, input: { paused } })}
          />
          <ListRowLayout
            icon="checklist.unchecked"
            label={`Run up to ${state.maxRunning} at once`}
          />
          <SettingsActionRow
            icon="plus"
            label="Allow one more"
            disabled={!canChange || state.maxRunning >= MAX_LIMIT}
            onPress={() =>
              void setMaxRunning({ environmentId, input: { maxRunning: state.maxRunning + 1 } })
            }
          />
          <SettingsActionRow
            icon="minus"
            label="Allow one fewer"
            disabled={!canChange || state.maxRunning <= 1}
            onPress={() =>
              void setMaxRunning({ environmentId, input: { maxRunning: state.maxRunning - 1 } })
            }
          />
          {state.rules.map((rule) => {
            const project = projectForCwd(projects, rule.root);
            return (
              <SettingsActionRow
                key={rule.root}
                icon="xmark"
                label={`${project?.title ?? rule.root}: ${PRIORITY_LABEL[rule.priority]}`}
                description="Remove this priority rule"
                disabled={!canChange}
                onPress={() => commands.setRule(rule.root, null)}
              />
            );
          })}
        </>
      ) : null}
      {LIMIT_ROWS.filter(
        (row) =>
          heavyLimitIdle(row.key, {
            queueEnabled: state.enabled,
            runnerEnabled: runner?.enabled ?? null,
            runnerWhere: runner?.where ?? null,
          }) === null,
      ).map((row) => {
        const { min, max, unit } = HEAVY_QUEUE_LIMITS[row.key];
        return (
          <ListRowLayout
            key={row.key}
            icon={row.icon}
            label={row.label}
            description={row.description}
            accessory={
              <View className="flex-row items-center gap-1">
                <NumberField
                  label={row.label}
                  min={min}
                  max={max}
                  value={state[row.key]}
                  formatValue={(value) => `${value}${UNIT[unit]}`}
                  disabled={!canChange}
                  onValueChange={(value) => setLimit(row.key, value)}
                />
                <Text className="text-base text-foreground-muted">{UNIT[unit]}</Text>
              </View>
            }
          />
        );
      })}
      <SettingsSwitchRow
        icon="link"
        label="Claude Code hook"
        subtitle="Adds a hook to your Claude Code settings so heavy Bash commands in Claude sessions outside T3 Code wait in this queue too. Sessions T3 Code starts already do."
        value={state.claudeHookInstalled}
        disabled={!canChange}
        onValueChange={(installed) => void setClaudeHook({ environmentId, input: { installed } })}
      />
      <ListRowLayout
        icon="moon"
        label="Power off idle simulators"
        description="Emulators and simulators T3 Code used power off after this long without use. Opening one boots it again."
      />
      {IDLE_MINUTES.map((minutes) => (
        <ListChoiceRow
          key={minutes}
          label={minutes === 0 ? "Off" : `${minutes} min`}
          selected={state.deviceIdleMinutes === minutes}
          disabled={!canChange}
          onPress={() => void setDeviceIdleMinutes({ environmentId, input: { minutes } })}
        />
      ))}
      {rows}
    </SettingsSection>
  );
}

const COMMAND_ICON = {
  queue: "list.number",
  agent: "bubble.left",
  terminal: "chevron.left.forwardslash.chevron.right",
  detached: "terminal",
} as const satisfies Record<HeavyCommand["source"], AppSymbolName>;

function HeavyCommandRows(props: {
  readonly environmentId: EnvironmentId;
  readonly command: HeavyCommand;
  readonly cpuCount: number;
  readonly canStop: boolean;
  readonly now: number;
  readonly onStop: (command: HeavyCommand) => void;
  readonly scoped: boolean;
}) {
  const { command, environmentId } = props;
  const { threadId } = command;
  const thread = useThreadShell(
    threadId === null ? null : scopeThreadRef(environmentId, ThreadId.make(threadId)),
  );
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const project = projectForCommand(command, projects, () => thread?.projectId);
  const selectDetail = useSelectWorkspaceDetail();
  const program = readableLabel(command.label);
  const description = [
    program === command.name ? undefined : program,
    runningUsageLine(command, props.cpuCount),
    props.scoped ? undefined : project?.title,
    thread?.title,
    HEAVY_COMMAND_SOURCE_LABEL[command.source],
    `Running ${formatDuration(command.startedAt, props.now)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const actions: MenuAction[] = [
    ...(threadId === null ? [] : [{ id: "thread", title: "Open thread", image: "bubble.left" }]),
    ...(command.stoppable
      ? [
          {
            id: "stop",
            title: "Stop",
            image: "stop.fill",
            attributes: { disabled: !props.canStop, destructive: true },
          },
        ]
      : []),
  ];
  const run = (id: string) => {
    if (id === "thread" && threadId !== null)
      selectDetail({ name: "Thread", params: { environmentId: String(environmentId), threadId } });
    else if (id === "stop") props.onStop(command);
  };
  return (
    <ListRowLayout
      icon={COMMAND_ICON[command.source]}
      label={command.name}
      description={description}
      {...(actions.length === 0
        ? {}
        : {
            accessory: (
              <RowMenuButton
                label={`Actions for ${command.name}`}
                actions={actions}
                onAction={run}
              />
            ),
          })}
    />
  );
}

/** Every heavy command running now, queued or run directly; nothing while none runs. */
export function HeavyCommandsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId?: string;
  /** Names the machine when Settings shows several environments' commands. */
  readonly machine?: string;
}) {
  const { environmentId } = props;
  const inProject = useProjectItems(environmentId, props.projectId);
  const state = useHeavyCommandsState(environmentId);
  const commands = inProject(state.commands);
  const { cpuCount } = state;
  const canStop = useAtomValue(heavyQueueEnvironment.stopCommand.permissionAtom(environmentId));
  const stopCommand = useAtomCommand(heavyQueueEnvironment.stopCommand);
  const cancel = useAtomCommand(heavyQueueEnvironment.cancel);
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- coarse timer for the elapsed times
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  if (commands.length === 0) return null;
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
  return (
    <SettingsSection
      title={
        props.projectId !== undefined
          ? "Running now"
          : props.machine === undefined
            ? "Heavy commands"
            : `Heavy commands · ${props.machine}`
      }
      footer="Commands running now that use at least half a core or 1 GB, queued or started directly by agents and terminals."
    >
      {commands.map((command) => (
        <HeavyCommandRows
          key={heavyCommandKey(command)}
          environmentId={environmentId}
          command={command}
          cpuCount={cpuCount}
          canStop={canStop}
          now={now}
          onStop={stop}
          scoped={props.projectId !== undefined}
        />
      ))}
    </SettingsSection>
  );
}
