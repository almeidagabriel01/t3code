import { useAtomValue } from "@effect/atom-react";
import { PRIORITY_LABEL, projectForCwd } from "@t3tools/client-runtime/state/heavyQueueModel";
import {
  HEAVY_OVER_LIMIT_DESCRIPTION,
  heavyLimitIdle,
  heavyModeLine,
} from "@t3tools/client-runtime/state/runnerModel";
import {
  type EnvironmentId,
  HEAVY_QUEUE_LIMITS,
  type HeavyQueueLimitKey,
  type RunnerWhere,
} from "@t3tools/contracts";
import { Platform, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { NumberField } from "../../../components/ui/NumberField";
import { useProjects } from "../../../state/entities";
import { heavyQueueEnvironment, useHeavyQueueState } from "../../../state/heavyQueue";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

const MAX_LIMIT = 8;
const IDLE_MINUTES = [0, 10, 20, 30, 60] as const;
export interface RunnerMode {
  readonly enabled: boolean;
  readonly where: RunnerWhere;
  readonly everything: boolean;
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
    description:
      "A new job waits while less than this share of this Mac's memory is free, unless it usually uses under 512 MB.",
  },
  {
    key: "heavyOverLimitSeconds",
    icon: "clock",
    label: "Over the limit for",
    description: HEAVY_OVER_LIMIT_DESCRIPTION,
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

/** The machine's heavy queue settings; what runs and waits shows in the Resource Manager. */
export function HeavyQueueSection(props: {
  readonly environmentId: EnvironmentId;
  /** Effective Runner settings, for the line that says what the queue and the Runner do together. */
  readonly runner?: RunnerMode;
  /** Names the machine when Settings shows several environments' queues. */
  readonly machine?: string;
  /** The server setting that slows agents' running jobs while this Mac stays over its CPU limit. */
  readonly slowAgentJobs?: {
    readonly value: boolean;
    readonly disabled: boolean;
    readonly onChange: (value: boolean) => void;
  };
}) {
  const { slowAgentJobs } = props;
  const { environmentId, runner } = props;
  const state = useHeavyQueueState(environmentId);
  const canChange = useAtomValue(heavyQueueEnvironment.move.permissionAtom(environmentId));
  const setEnabled = useAtomCommand(heavyQueueEnvironment.setEnabled);
  const setPaused = useAtomCommand(heavyQueueEnvironment.setPaused);
  const setRuleCommand = useAtomCommand(heavyQueueEnvironment.setRule);
  const setMaxRunning = useAtomCommand(heavyQueueEnvironment.setMaxRunning);
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
  const setRule = (root: string) =>
    void setRuleCommand({ environmentId, input: { root, priority: null } });
  const limitRow = (row: (typeof LIMIT_ROWS)[number]) => {
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
  };
  const limits = LIMIT_ROWS.filter(
    (row) =>
      heavyLimitIdle(row.key, {
        queueEnabled: state.enabled,
        runnerEnabled: runner?.enabled ?? null,
        runnerWhere: runner?.where ?? null,
      }) === null,
  );
  const macLimits = limits.filter((row) => row.key !== "heavyOverLimitSeconds");
  const sharedLimits = limits.filter((row) => row.key === "heavyOverLimitSeconds");
  const named = (title: string) =>
    props.machine === undefined ? title : `${title} · ${props.machine}`;
  return (
    <>
      <SettingsSection
        title={named("Heavy work queue")}
        footer="Agents queue tests, builds and simulators here. Each machine runs up to its own limit at once, and starts the next job only when it has room."
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
          // A summary, not a setting: set like the switch's subtitle above it, with no title.
          <View className="flex-row items-center gap-3 px-4 py-3">
            <View className="size-6 items-center justify-center">
              <SymbolView
                name="arrow.left.arrow.right"
                size={Platform.OS === "android" ? 24 : 22}
                tintColorClassName="accent-icon"
              />
            </View>
            <Text textRole="footnote" className="min-w-0 flex-1 text-foreground-muted">
              {heavyModeLine({
                queueEnabled: state.enabled,
                queuePaused: state.paused,
                runnerEnabled: runner.enabled,
                where: runner.where,
                everything: runner.everything,
              })}
            </Text>
          </View>
        )}
        {/* Pause and rules act only on the queue; the limits follow heavyLimitIdle. */}
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
            {state.rules.map((rule) => {
              const project = projectForCwd(projects, rule.root);
              return (
                <SettingsActionRow
                  key={rule.root}
                  icon="xmark"
                  label={`${project?.title ?? rule.root}: ${PRIORITY_LABEL[rule.priority]}`}
                  description="Remove this priority rule"
                  disabled={!canChange}
                  onPress={() => setRule(rule.root)}
                />
              );
            })}
          </>
        ) : null}
        {/* Times both machines' limits, so it stays out of the This Mac section. */}
        {sharedLimits.map(limitRow)}
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
      </SettingsSection>
      {state.enabled || macLimits.length > 0 ? (
        <SettingsSection title={named("This Mac")}>
          {state.enabled ? (
            <>
              <ListRowLayout
                icon="checklist.unchecked"
                label={`Run up to ${state.maxRunning} at once on this Mac`}
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
            </>
          ) : null}
          {macLimits.map(limitRow)}
          {state.enabled && slowAgentJobs !== undefined ? (
            <SettingsSwitchRow
              icon="hourglass"
              label="Slow down agent jobs when the Mac is busy"
              subtitle="While this Mac stays over its CPU limit, agents' running jobs and the build daemons they use drop to background priority, and speed up again once there is room. Your own jobs keep their speed."
              value={slowAgentJobs.value}
              disabled={slowAgentJobs.disabled}
              onValueChange={slowAgentJobs.onChange}
            />
          ) : null}
        </SettingsSection>
      ) : null}
    </>
  );
}
