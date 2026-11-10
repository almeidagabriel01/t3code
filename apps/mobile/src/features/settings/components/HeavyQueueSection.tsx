import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  formatDuration,
  moveTarget,
  PRIORITY_LABEL,
  projectForCwd,
  queueSummary,
  readableLabel,
  ruleForRoot,
  usageLine,
  type MoveAction,
} from "@t3tools/client-runtime/state/heavyQueueModel";
import { heavyEntryName } from "@t3tools/shared/heavyEntryName";
import { ThreadId, type EnvironmentId, type HeavyQueueEntry } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Alert } from "react-native";

import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { useProjects, useThreadShell } from "../../../state/entities";
import { heavyQueueEnvironment, useHeavyQueueState } from "../../../state/heavyQueue";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../../layout/workspace/useSelectWorkspaceDetail";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

const MAX_LIMIT = 8;

type Commands = {
  readonly move: (id: string, beforeId: string | null) => void;
  readonly startNow: (entry: HeavyQueueEntry) => void;
  readonly cancel: (entry: HeavyQueueEntry) => void;
  readonly setRule: (root: string, priority: "first" | "last" | null) => void;
};

function QueueEntryRows(props: {
  readonly environmentId: EnvironmentId;
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  readonly entry: HeavyQueueEntry;
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
  const description = [
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
      {running && entry.server === true ? null : (
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

export function HeavyQueueSection(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const state = useHeavyQueueState(environmentId);
  const canChange = useAtomValue(heavyQueueEnvironment.move.permissionAtom(environmentId));
  const move = useAtomCommand(heavyQueueEnvironment.move);
  const startNow = useAtomCommand(heavyQueueEnvironment.startNow);
  const cancel = useAtomCommand(heavyQueueEnvironment.cancel);
  const setEnabled = useAtomCommand(heavyQueueEnvironment.setEnabled);
  const setPaused = useAtomCommand(heavyQueueEnvironment.setPaused);
  const setRule = useAtomCommand(heavyQueueEnvironment.setRule);
  const setMaxRunning = useAtomCommand(heavyQueueEnvironment.setMaxRunning);
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const commands: Commands = {
    move: (id, beforeId) => void move({ environmentId, input: { id, beforeId } }),
    setRule: (root, priority) => void setRule({ environmentId, input: { root, priority } }),
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
        subtitle="Off: heavy jobs start right away and agents do not ask first."
        value={state.enabled}
        disabled={!canChange}
        onValueChange={(enabled) => void setEnabled({ environmentId, input: { enabled } })}
      />
      <ListRowLayout icon="timer" label={queueSummary(state)} />
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
