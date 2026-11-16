import { PRIORITY_LABEL, projectForCwd } from "@t3tools/client-runtime/state/heavyQueueModel";
import { heavyLimitDescription, heavyLimitIdle } from "@t3tools/client-runtime/state/runnerModel";
import {
  HEAVY_QUEUE_ADMISSION_KEYS,
  HEAVY_QUEUE_DEFAULTS,
  HEAVY_QUEUE_LIMITS,
  heavyQueueLimitRange,
  type EnvironmentId,
  type HeavyQueueAdmissionKey,
  type HeavyQueueLimitKey,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { useProjects } from "../../state/entities";
import { useHeavyQueue } from "../../state/heavyQueue";
import { useHeavyQueueActions } from "../statusBar/useKillTarget";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { HeavyNoticesRow } from "./HeavyNoticesRow";
import { IdleNote, RunnerGroup, UnitStepper, useHeavyModeLine } from "./RunnerSettings";
import { SettingsGroup } from "./SettingsGroup";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
  useSettingsSearchRevealedId,
} from "./settingsLayout";
import { searchableSetting, settingCopy, type SettingsSearchItemId } from "./settingsSearch";
import { MAINTENANCE_SETTINGS_COPY } from "./settingsSearchMaintenanceItems";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const MAX_RUNNING = { min: 1, max: 8 } as const;
const IDLE_MINUTES = [0, 10, 20, 30, 60] as const;
const idleLabel = (minutes: number) => (minutes === 0 ? "Off" : `${minutes} min`);
const QUEUE_OFF_NOTE = "Only applies while the heavy work queue is on.";

const LIMIT_ROWS: ReadonlyArray<{
  readonly key: HeavyQueueLimitKey;
  readonly searchId: SettingsSearchItemId;
}> = [
  { key: "macCpuCeilingPercent", searchId: "heavy-work-cpu-ceiling" },
  { key: "macMemoryFloorPercent", searchId: "heavy-work-memory-floor" },
  { key: "heavyOverLimitSeconds", searchId: "heavy-work-over-limit" },
  { key: "lightJobMegabytes", searchId: "heavy-work-light-job" },
  { key: "unseenHeavyMegabytes", searchId: "heavy-work-unseen-heavy" },
  { key: "unseenMediumMegabytes", searchId: "heavy-work-unseen-medium" },
  { key: "historyCommands", searchId: "heavy-work-history" },
  { key: "headPatienceMinutes", searchId: "heavy-work-head-patience" },
];
const isAdmission = (key: HeavyQueueLimitKey): key is HeavyQueueAdmissionKey =>
  (HEAVY_QUEUE_ADMISSION_KEYS as ReadonlyArray<HeavyQueueLimitKey>).includes(key);

function Controls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const state = useHeavyQueue(environmentId);
  const actions = useHeavyQueueActions(environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const modeLine = useHeavyModeLine(state);
  const target = useSettingsSearchRevealedId();
  const readOnly = !actions.canChange;
  /** Queue rows show while the queue is on, or when a search lands on one (then with why). */
  const queueRow = (searchId: SettingsSearchItemId) => ({
    shown: state.enabled || target === searchableSetting(searchId).id,
    status: state.enabled ? undefined : <IdleNote>{QUEUE_OFF_NOTE}</IdleNote>,
  });
  const max = queueRow("heavy-work-max");
  const pause = queueRow("heavy-work-pause");
  const rulesRow = queueRow("heavy-work-rules");
  const slowRow = queueRow("heavy-work-slow-agents");
  const slowAgentJobs = useScopedSettings((settings) => settings.heavySlowAgentJobs);
  const updateSettings = useUpdateScopedSettings();
  const runnerEnabled = useScopedSettings((settings) => settings.runnerEnabled);
  const runnerWhere = useScopedSettings((settings) => settings.runnerWhere);
  const runnerMixed = useScopedSettingsMixed(["runnerEnabled", "runnerWhere"]);
  const limitChoices = {
    queueEnabled: state.enabled,
    runnerEnabled: runnerMixed ? null : runnerEnabled,
    runnerWhere: runnerMixed ? null : runnerWhere,
  };
  // The Mac limits also steer Hybrid without the queue, so they follow the shared rule.
  const limits = LIMIT_ROWS.map((row) => {
    // Letting jobs pass the head is the queue's own; the sizes also steer Hybrid's room on the Mac.
    const idle =
      row.key === "headPatienceMinutes"
        ? state.enabled
          ? null
          : QUEUE_OFF_NOTE
        : heavyLimitIdle(row.key, limitChoices);
    return {
      ...row,
      shown: idle === null || target === searchableSetting(row.searchId).id,
      status: idle === null ? undefined : <IdleNote>{idle}</IdleNote>,
    };
  });
  const setLimit = (key: HeavyQueueLimitKey, value: number) =>
    isAdmission(key)
      ? actions.setAdmissionLimits({ [key]: value })
      : {
          macCpuCeilingPercent: actions.setMacCpuCeilingPercent,
          macMemoryFloorPercent: actions.setMacMemoryFloorPercent,
          heavyOverLimitSeconds: actions.setHeavyOverLimitSeconds,
        }[key](value);
  const limitRow = (row: (typeof limits)[number]) =>
    row.shown ? (
      <SettingsRow
        key={row.key}
        {...searchableSetting(row.searchId)}
        description={heavyLimitDescription(row.key, state.lightJobMegabytes)}
        status={row.status}
        resetAction={
          state[row.key] === HEAVY_QUEUE_DEFAULTS[row.key] ? undefined : (
            <SettingResetButton
              label={searchableSetting(row.searchId).title}
              disabled={readOnly}
              onClick={() => void setLimit(row.key, HEAVY_QUEUE_DEFAULTS[row.key])}
            />
          )
        }
        control={
          <UnitStepper
            title={searchableSetting(row.searchId).title}
            {...HEAVY_QUEUE_LIMITS[row.key]}
            {...heavyQueueLimitRange(row.key, state)}
            value={state[row.key]}
            disabled={readOnly}
            onCommit={(next) => void setLimit(row.key, next)}
          />
        }
      />
    ) : null;
  // The over-the-limit time paces both machines, so it sits outside the This Mac group.
  const macLimits = limits.filter(
    (row) => row.key !== "heavyOverLimitSeconds" && !isAdmission(row.key),
  );
  const sharedLimits = limits.filter((row) => row.key === "heavyOverLimitSeconds");
  const sizingLimits = limits.filter((row) => isAdmission(row.key));
  const maxTitle = searchableSetting("heavy-work-max").title;
  return (
    <div className="space-y-5">
      <SettingsGroup>
        <SettingsRow
          {...searchableSetting("heavy-work-enabled")}
          status={modeLine}
          control={
            <Switch
              checked={state.enabled}
              disabled={readOnly}
              onCheckedChange={(checked) => void actions.setEnabled(Boolean(checked))}
              aria-label="Use the heavy work queue"
            />
          }
        />
        {pause.shown ? (
          <SettingsRow
            {...searchableSetting("heavy-work-pause")}
            status={pause.status}
            control={
              <Switch
                checked={state.paused}
                disabled={readOnly || !state.enabled}
                onCheckedChange={(checked) => void actions.setPaused(Boolean(checked))}
                aria-label="Pause the heavy work queue"
              />
            }
          />
        ) : null}
      </SettingsGroup>
      {max.shown || slowRow.shown || macLimits.some((row) => row.shown) ? (
        <RunnerGroup title="This Mac">
          {max.shown ? (
            <SettingsRow
              {...searchableSetting("heavy-work-max")}
              status={max.status}
              control={
                <UnitStepper
                  title={maxTitle}
                  min={MAX_RUNNING.min}
                  max={MAX_RUNNING.max}
                  unit="jobs"
                  value={state.maxRunning}
                  disabled={readOnly || !state.enabled}
                  onCommit={(next) => void actions.setMaxRunning(next)}
                />
              }
            />
          ) : null}
          {macLimits.map(limitRow)}
          {slowRow.shown ? (
            <SettingsRow
              {...searchableSetting("heavy-work-slow-agents")}
              status={slowRow.status}
              control={
                <Switch
                  checked={slowAgentJobs}
                  disabled={!state.enabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ heavySlowAgentJobs: Boolean(checked) })
                  }
                  aria-label="Slow down agent jobs when the Mac is busy"
                />
              }
            />
          ) : null}
        </RunnerGroup>
      ) : null}
      {sizingLimits.some((row) => row.shown) ? (
        <RunnerGroup title="Job sizing">{sizingLimits.map(limitRow)}</RunnerGroup>
      ) : null}
      {sharedLimits.some((row) => row.shown) ? (
        <SettingsGroup>{sharedLimits.map(limitRow)}</SettingsGroup>
      ) : null}
      <SettingsGroup>
        {rulesRow.shown ? (
          <SettingsRow
            {...searchableSetting("heavy-work-rules")}
            status={rulesRow.status}
            description={
              state.rules.length === 0
                ? MAINTENANCE_SETTINGS_COPY.heavyRulesEmpty
                : settingCopy("heavy-work-rules").description
            }
          >
            {state.rules.length === 0 ? null : (
              <ul className="pb-2">
                {state.rules.map((rule) => {
                  const name = projectForCwd(projects, rule.root)?.title ?? rule.root;
                  return (
                    <li key={rule.root} className="flex items-center gap-2 py-1 text-sm">
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {PRIORITY_LABEL[rule.priority]}
                      </span>
                      <Button
                        variant="ghost-muted"
                        size="icon-micro"
                        aria-label={`Remove the priority rule for ${name}`}
                        disabled={readOnly || !state.enabled}
                        onClick={() => void actions.setRule(rule.root, null)}
                      >
                        <XIcon aria-hidden />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </SettingsRow>
        ) : null}
        <SettingsRow
          {...searchableSetting("heavy-work-claude-hook")}
          control={
            <Switch
              checked={state.claudeHookInstalled}
              disabled={readOnly}
              onCheckedChange={(checked) => void actions.setClaudeHook(Boolean(checked))}
              aria-label="Queue heavy commands from Claude Code sessions outside T3 Code"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("heavy-work-device-idle")}
          control={
            <Select
              value={String(state.deviceIdleMinutes)}
              onValueChange={(next) => {
                if (next !== null) void actions.setDeviceIdleMinutes(Number(next));
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-28"
                aria-label="Power off idle simulators after"
                disabled={readOnly}
              >
                <SelectValue>{idleLabel(state.deviceIdleMinutes)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {IDLE_MINUTES.map((minutes) => (
                  <SelectItem hideIndicator key={minutes} value={String(minutes)}>
                    {idleLabel(minutes)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsGroup>
    </div>
  );
}

export function HeavyWorkSettingsSection() {
  const { scope, environment } = useSettingsScope();
  const environmentId =
    scope.environmentIds.length === 1 ? (environment?.environmentId ?? null) : null;
  return (
    <SettingsSection {...searchableSetting("heavy-work")} variant="plain">
      {environmentId === null ? (
        <SettingsGroup>
          <SettingsRow
            // oxlint-disable-next-line t3code/require-searchable-settings-copy -- pick-an-environment prompt, not a setting
            title="Heavy work queue"
            // oxlint-disable-next-line t3code/require-searchable-settings-copy -- pick-an-environment prompt, not a setting
            description="Choose one environment to manage its queue."
          />
        </SettingsGroup>
      ) : (
        <Controls environmentId={environmentId} />
      )}
      <SettingsGroup>
        <HeavyNoticesRow />
      </SettingsGroup>
    </SettingsSection>
  );
}
