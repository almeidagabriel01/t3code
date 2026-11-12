import { PRIORITY_LABEL, projectForCwd } from "@t3tools/client-runtime/state/heavyQueueModel";
import {
  HEAVY_QUEUE_LIMITS,
  type EnvironmentId,
  type HeavyQueueLimitKey,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { useProjects } from "../../state/entities";
import { useHeavyQueue } from "../../state/heavyQueue";
import { useHeavyQueueActions } from "../statusBar/useKillTarget";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { IdleNote, RunnerGroup, UnitStepper, useHeavyModeLine } from "./RunnerSettings";
import { SettingsGroup } from "./SettingsGroup";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection, useSettingsSearchTargetId } from "./settingsLayout";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";

const MAX_RUNNING = { min: 1, max: 8 } as const;
const IDLE_MINUTES = [0, 10, 20, 30, 60] as const;
const idleLabel = (minutes: number) => (minutes === 0 ? "Off" : `${minutes} min`);
const QUEUE_OFF_NOTE = "Only applies while the heavy work queue is on.";

const LIMIT_ROWS: ReadonlyArray<{
  readonly key: HeavyQueueLimitKey;
  readonly searchId: SettingsSearchItemId;
  readonly description: string;
}> = [
  {
    key: "macCpuCeilingPercent",
    searchId: "heavy-work-cpu-ceiling",
    description: "A new heavy job waits while this Mac's CPU stays above this.",
  },
  {
    key: "macMemoryFloorPercent",
    searchId: "heavy-work-memory-floor",
    description: "A new heavy job waits while less than this much of this Mac's memory is free.",
  },
  {
    key: "heavyOverLimitSeconds",
    searchId: "heavy-work-over-limit",
    description:
      "How long this Mac or Linux must stay past a limit, or back under it, before jobs wait or move. A short spike changes nothing.",
  },
];

function Controls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const state = useHeavyQueue(environmentId);
  const actions = useHeavyQueueActions(environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const modeLine = useHeavyModeLine(state);
  const target = useSettingsSearchTargetId();
  const readOnly = !actions.canChange;
  /** Queue rows show while the queue is on, or when a search lands on one (then with why). */
  const queueRow = (searchId: SettingsSearchItemId) => ({
    shown: state.enabled || target === searchableSetting(searchId).id,
    status: state.enabled ? undefined : <IdleNote>{QUEUE_OFF_NOTE}</IdleNote>,
  });
  const max = queueRow("heavy-work-max");
  const pause = queueRow("heavy-work-pause");
  const rulesRow = queueRow("heavy-work-rules");
  const limits = LIMIT_ROWS.map((row) => ({ ...row, ...queueRow(row.searchId) }));
  const setLimit: Record<HeavyQueueLimitKey, (value: number) => Promise<unknown>> = {
    macCpuCeilingPercent: actions.setMacCpuCeilingPercent,
    macMemoryFloorPercent: actions.setMacMemoryFloorPercent,
    heavyOverLimitSeconds: actions.setHeavyOverLimitSeconds,
  };
  const maxTitle = searchableSetting("heavy-work-max").title;
  return (
    <div className="space-y-5">
      <SettingsGroup>
        <SettingsRow
          {...searchableSetting("heavy-work-enabled")}
          description="On: tests, builds and simulators take turns, and agents ask before adding to a busy machine. Off: heavy jobs start right away and agents do not ask first."
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
            description="While paused nothing new starts. Jobs already running continue."
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
      {max.shown || limits.some((row) => row.shown) ? (
        <RunnerGroup title="This Mac">
          {max.shown ? (
            <SettingsRow
              {...searchableSetting("heavy-work-max")}
              description="With 1, heavy jobs run strictly one at a time. With more, the next one starts only while this Mac is under its limits."
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
          {limits.map((row) =>
            row.shown ? (
              <SettingsRow
                key={row.key}
                {...searchableSetting(row.searchId)}
                description={row.description}
                status={row.status}
                control={
                  <UnitStepper
                    title={searchableSetting(row.searchId).title}
                    {...HEAVY_QUEUE_LIMITS[row.key]}
                    value={state[row.key]}
                    disabled={readOnly || !state.enabled}
                    onCommit={(next) => void setLimit[row.key](next)}
                  />
                }
              />
            ) : null,
          )}
        </RunnerGroup>
      ) : null}
      <SettingsGroup>
        {rulesRow.shown ? (
          <SettingsRow
            {...searchableSetting("heavy-work-rules")}
            status={rulesRow.status}
            description={
              state.rules.length === 0
                ? "No project has a fixed priority. Set one from a queued job's menu in the Resource Manager."
                : "Jobs from these projects go ahead of, or behind, the others. Jobs already queued keep their place."
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
          description="Adds a hook to your Claude Code settings so heavy Bash commands in Claude sessions outside T3 Code wait in this queue too. Sessions T3 Code starts already do."
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
          description="Emulators and simulators T3 Code used power off after this long without use. Opening one boots it again."
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
    <SettingsSection id="heavy-work" title="Heavy work" variant="plain">
      {environmentId === null ? (
        <SettingsGroup>
          <SettingsRow
            title="Heavy work queue"
            description="Choose one environment to manage its queue."
          />
        </SettingsGroup>
      ) : (
        <Controls environmentId={environmentId} />
      )}
    </SettingsSection>
  );
}
