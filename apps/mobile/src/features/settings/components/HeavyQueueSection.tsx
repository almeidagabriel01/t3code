import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  formatDuration,
  HEAVY_COMMAND_SOURCE_LABEL,
  heavyCommandKey,
  moveTarget,
  projectForCommand,
  PRIORITY_LABEL,
  projectForCwd,
  queueSummary,
  readableLabel,
  ruleForRoot,
  runningUsageLine,
  usageLine,
  type MoveAction,
} from "@t3tools/client-runtime/state/heavyQueueModel";
import {
  ASK_TITLE,
  askRemaining,
  heavyModeLine,
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
  type RunnerWhere,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Alert } from "react-native";

import type { AppSymbolName } from "../../../components/ui/AppSymbol";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { useProjects, useThreadShell } from "../../../state/entities";
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

function QueueEntryRows(props: {
  readonly environmentId: EnvironmentId;
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  readonly entry: HeavyQueueEntry;
  readonly state: HeavyQueueState;
  readonly canRoute: boolean;
  readonly position: number | null;
  readonly reason: string | undefined;
  readonly usage: string | null;
  readonly rules: ReadonlyArray<{ readonly root: string; readonly priority: "first" | "last" }>;
  readonly canChange: boolean;
  readonly commands: Commands;
  readonly now: number;
}) {
  const { entry, entries, position, commands } = props;
  const projects = useProjects().filter((p) => p.environmentId === props.environmentId);
  const project = projectForCwd(projects, entry.cwd);
  const rule = project === undefined ? undefined : ruleForRoot(props.rules, project.workspaceRoot);
  const selectDetail = useSelectWorkspaceDetail();
  const thread = useThreadShell(
    entry.threadId === null
      ? null
      : scopeThreadRef(props.environmentId, ThreadId.make(entry.threadId)),
  );
  const origin = thread?.title ?? entry.cwd.split(/[\\/]/).findLast(Boolean) ?? entry.cwd;
  const running = position === null;
  const badge = runnerBadge(entry, props.state);
  const actions = routeActions(entry, props.state);
  const description = [
    badge?.label,
    readableLabel(entry.label),
    props.usage,
    project?.title,
    origin,
    rule === undefined ? undefined : PRIORITY_LABEL[rule.priority],
    running && entry.startedAt !== null
      ? `Running ${formatDuration(entry.startedAt, props.now)}`
      : `Waiting ${formatDuration(entry.createdAt, props.now)}`,
    props.reason,
    entry.note,
    entry.unconfirmed === true ? RUNNER_UNCONFIRMED_NOTE : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const move = (action: MoveAction) => {
    const target = moveTarget(entries, entry.id, action);
    if (target !== undefined) commands.move(entry.id, target);
  };
  const can = (action: MoveAction) =>
    props.canChange && moveTarget(entries, entry.id, action) !== undefined;
  return (
    <>
      <ListRowLayout
        icon={running ? "play" : "hourglass"}
        label={heavyEntryName(entry)}
        description={description}
        {...(position === null ? {} : { detail: `#${position}` })}
      />
      {entry.ask === undefined ? (
        actions.map((action) => (
          <SettingsActionRow
            key={action.runner}
            icon={action.runner === "mac" ? "laptopcomputer" : "server.rack"}
            label={action.label}
            disabled={!props.canRoute}
            onPress={() => commands.route(entry, action)}
          />
        ))
      ) : (
        <RunnerAskRows
          entry={entry}
          ask={entry.ask}
          actions={actions}
          canRoute={props.canRoute}
          canChange={props.canChange}
          commands={commands}
        />
      )}
      {running ? null : (
        <>
          <SettingsActionRow
            icon="arrow.up.circle"
            label="Run next"
            disabled={!can("next")}
            onPress={() => move("next")}
          />
          <SettingsActionRow
            icon="bolt.circle"
            label="Start now"
            description="Ignores how busy the Mac is"
            disabled={!props.canChange}
            onPress={() => commands.startNow(entry)}
          />
          <SettingsActionRow
            icon="arrow.up"
            label="Move up"
            disabled={!can("up")}
            onPress={() => move("up")}
          />
          <SettingsActionRow
            icon="arrow.down"
            label="Move down"
            disabled={!can("down")}
            onPress={() => move("down")}
          />
          <SettingsActionRow
            icon="arrow.down.to.line"
            label="Move to end"
            disabled={!can("end")}
            onPress={() => move("end")}
          />
        </>
      )}
      {entry.priority === "high" ? null : (
        <SettingsActionRow
          icon="bolt.horizontal.circle"
          label="High priority now"
          disabled={!props.canChange}
          onPress={() => commands.setPriority(entry.id, "high")}
        />
      )}
      {running ? (
        <SettingsActionRow
          icon="arrow.down.circle"
          label="Lower priority"
          disabled={!props.canChange}
          onPress={() => commands.setPriority(entry.id, "low")}
        />
      ) : null}
      {entry.threadId === null ? null : (
        <SettingsActionRow
          icon="bubble.left"
          label="Open thread"
          onPress={() =>
            selectDetail({
              name: "Thread",
              params: { environmentId: String(props.environmentId), threadId: entry.threadId! },
            })
          }
        />
      )}
      {project === undefined ? null : (
        <SettingsActionRow
          icon="tag"
          label="Priority for this project"
          disabled={!props.canChange}
          onPress={() =>
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
            ])
          }
        />
      )}
      {(running && entry.server === true) || entry.ask !== undefined ? null : (
        <SettingsActionRow
          icon={running ? "xmark" : "trash"}
          label={running ? "Stop" : "Remove"}
          tone="danger"
          disabled={!props.canChange}
          onPress={() => commands.cancel(entry)}
        />
      )}
    </>
  );
}

export interface RunnerMode {
  readonly enabled: boolean;
  readonly where: RunnerWhere;
  readonly overflow: number;
}

export function HeavyQueueSection(props: {
  readonly environmentId: EnvironmentId;
  /** Effective Runner settings, for the line that says what the queue and the Runner do together. */
  readonly runner: RunnerMode;
}) {
  const { environmentId, runner } = props;
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
  const canTune = canChange && state.enabled;
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- coarse timer for the elapsed times
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <SettingsSection
      title="Heavy work queue"
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
      <ListRowLayout icon="timer" label={queueSummary(state)} />
      <ListRowLayout
        icon="arrow.left.arrow.right"
        label={heavyModeLine({
          queueEnabled: state.enabled,
          queuePaused: state.paused,
          runnerEnabled: runner.enabled,
          where: runner.where,
          overflow: runner.overflow,
        })}
      />
      <SettingsSwitchRow
        icon="pause"
        label="Pause queue"
        subtitle="Nothing new starts while paused. Running jobs continue."
        value={state.paused}
        disabled={!canTune}
        onValueChange={(paused) => void setPaused({ environmentId, input: { paused } })}
      />
      <ListRowLayout
        icon="checklist.unchecked"
        label={`Run up to ${state.maxRunning} at once`}
        disabled={!state.enabled}
      />
      <SettingsActionRow
        icon="plus"
        label="Allow one more"
        disabled={!canTune || state.maxRunning >= MAX_LIMIT}
        onPress={() =>
          void setMaxRunning({ environmentId, input: { maxRunning: state.maxRunning + 1 } })
        }
      />
      <SettingsActionRow
        icon="minus"
        label="Allow one fewer"
        disabled={!canTune || state.maxRunning <= 1}
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
            disabled={!canTune}
            onPress={() => commands.setRule(rule.root, null)}
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
      {entries.length === 0 ? <ListRowLayout icon="checkmark" label="Nothing queued." /> : null}
      {entries.map((entry, index) => {
        const position =
          entry.startedAt === null
            ? entries.slice(0, index + 1).filter((e) => e.startedAt === null).length
            : null;
        return (
          <QueueEntryRows
            key={entry.id}
            environmentId={environmentId}
            entries={entries}
            entry={entry}
            state={state}
            canRoute={canRoute}
            position={position}
            now={now}
            reason={state.reasons[entry.id]}
            usage={usageLine(entry, state)}
            rules={state.rules}
            canChange={canChange}
            commands={commands}
          />
        );
      })}
    </SettingsSection>
  );
}

const COMMAND_ICON = {
  queue: "list.number",
  agent: "bubble.left",
  terminal: "chevron.left.forwardslash.chevron.right",
} as const satisfies Record<HeavyCommand["source"], AppSymbolName>;

function HeavyCommandRows(props: {
  readonly environmentId: EnvironmentId;
  readonly command: HeavyCommand;
  readonly cpuCount: number;
  readonly canStop: boolean;
  readonly now: number;
  readonly onStop: (command: HeavyCommand) => void;
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
    project?.title,
    thread?.title,
    HEAVY_COMMAND_SOURCE_LABEL[command.source],
    `Running ${formatDuration(command.startedAt, props.now)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <ListRowLayout
        icon={COMMAND_ICON[command.source]}
        label={command.name}
        description={description}
      />
      {threadId === null ? null : (
        <SettingsActionRow
          icon="bubble.left"
          label="Open thread"
          onPress={() =>
            selectDetail({
              name: "Thread",
              params: { environmentId: String(environmentId), threadId },
            })
          }
        />
      )}
      {command.stoppable ? (
        <SettingsActionRow
          icon="stop.fill"
          label="Stop"
          tone="danger"
          disabled={!props.canStop}
          onPress={() => props.onStop(command)}
        />
      ) : null}
    </>
  );
}

/** Every heavy command running now, queued or run directly; nothing while none runs. */
export function HeavyCommandsSection(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const { commands, cpuCount } = useHeavyCommandsState(environmentId);
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
      title="Heavy commands"
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
        />
      ))}
    </SettingsSection>
  );
}
