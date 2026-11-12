import {
  heavyModeLine,
  linuxLine,
  RUNNER_DEADLINE_LABEL,
  RUNNER_POLICY_LABEL,
  RUNNER_WHERE_LABEL,
} from "@t3tools/client-runtime/state/runnerModel";
import {
  RUNNER_DEFAULTS,
  RUNNER_LIMITS,
  runnerHostError,
  runnerNumberError,
  runnerPatterns,
  runnerPatternsError,
  type HeavyQueueState,
  type RunnerNumberKey,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { useState, type ReactNode } from "react";

import { useHeavyQueue } from "../../state/heavyQueue";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

type ChoiceKey = "runnerWhere" | "runnerUnavailable" | "runnerDropped" | "runnerDeadlineAction";
type PatternKey = "runnerLinuxCommands" | "runnerMacOnly";
type RunnerKey = keyof typeof RUNNER_DEFAULTS;

/** The queue × Runner sentence, from this scope's effective Runner values. */
export function useHeavyModeLine(queue: Pick<HeavyQueueState, "enabled" | "paused">) {
  const runnerEnabled = useScopedSettings((settings) => settings.runnerEnabled);
  const where = useScopedSettings((settings) => settings.runnerWhere);
  const overflow = useScopedSettings((settings) => settings.runnerOverflow);
  return heavyModeLine({
    queueEnabled: queue.enabled,
    queuePaused: queue.paused,
    runnerEnabled,
    where,
    overflow,
  });
}

/** Back to the built-in value outside project scope; SettingsRow resets project overrides itself. */
function useResetAction(key: RunnerKey, label: string) {
  const value = useScopedSettings((settings) => settings[key]);
  const mixed = useScopedSettingsMixed([key]);
  const update = useUpdateScopedSettings();
  return mixed || !Equal.equals(value, RUNNER_DEFAULTS[key]) ? (
    <SettingResetButton label={label} onClick={() => update({ [key]: RUNNER_DEFAULTS[key] })} />
  ) : null;
}

/** A typed value that saves on blur only when `error` finds nothing wrong with it. */
function useDraft(saved: string) {
  const [draft, setDraft] = useState(saved);
  const [synced, setSynced] = useState(saved);
  // A saved value that changes elsewhere replaces the draft.
  if (synced !== saved) {
    setSynced(saved);
    setDraft(saved);
  }
  return [draft, setDraft] as const;
}

function ChoiceRow<K extends ChoiceKey>({
  settingKey,
  searchId,
  description,
  labels,
}: {
  readonly settingKey: K;
  readonly searchId: SettingsSearchItemId;
  readonly description: ReactNode;
  readonly labels: Record<(typeof RUNNER_DEFAULTS)[K], string>;
}) {
  const value = useScopedSettings((settings) => settings[settingKey]);
  const mixed = useScopedSettingsMixed([settingKey]);
  const update = useUpdateScopedSettings();
  const { title } = searchableSetting(searchId);
  const options = Object.keys(labels) as Array<(typeof RUNNER_DEFAULTS)[K]>;
  return (
    <SettingsRow
      {...searchableSetting(searchId)}
      serverScoped
      settingKeys={[settingKey]}
      description={description}
      resetAction={useResetAction(settingKey, title)}
      control={
        <Select
          value={mixed ? null : value}
          onValueChange={(next) => {
            const option = options.find((candidate) => candidate === next);
            if (option !== undefined) update({ [settingKey]: option });
          }}
        >
          <SelectTrigger size="sm" aria-label={title}>
            <SelectValue>
              {(current: (typeof RUNNER_DEFAULTS)[K] | null) =>
                current === null ? "Mixed" : labels[current]
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {labels[option]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function NumberRow({
  settingKey,
  searchId,
  description,
  machine = false,
}: {
  readonly settingKey: RunnerNumberKey;
  readonly searchId: SettingsSearchItemId;
  readonly description: ReactNode;
  readonly machine?: boolean;
}) {
  const value = useScopedSettings((settings) => settings[settingKey]);
  const mixed = useScopedSettingsMixed([settingKey]);
  const update = useUpdateScopedSettings();
  const saved = mixed ? "" : String(value);
  const [draft, setDraft] = useDraft(saved);
  const { title } = searchableSetting(searchId);
  const typed = draft.trim();
  const error =
    mixed && typed === ""
      ? null
      : runnerNumberError(settingKey, typed === "" ? Number.NaN : Number(typed));
  const reset = useResetAction(settingKey, title);
  const projectScope = useIsProjectScope();
  return (
    <SettingsRow
      {...searchableSetting(searchId)}
      serverScoped
      settingKeys={[settingKey]}
      description={description}
      status={error === null ? undefined : <span className="text-destructive">{error}</span>}
      resetAction={machine && projectScope ? null : reset}
      control={
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            className="w-20"
            inputMode="numeric"
            aria-label={title}
            aria-invalid={error !== null || undefined}
            placeholder={mixed ? "Mixed" : undefined}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (error !== null || typed === "" || typed === saved) return;
              update({ [settingKey]: Number(typed) }, { onFailed: () => setDraft(saved) });
            }}
          />
          <span className="text-xs text-muted-foreground">{RUNNER_LIMITS[settingKey].unit}</span>
        </div>
      }
    />
  );
}

function useIsProjectScope() {
  const { scope } = useSettingsScope();
  return scope.kind === "project" || scope.kind === "checkout";
}

function PatternsRow({
  settingKey,
  searchId,
  description,
}: {
  readonly settingKey: PatternKey;
  readonly searchId: SettingsSearchItemId;
  readonly description: ReactNode;
}) {
  const value = useScopedSettings((settings) => settings[settingKey]);
  const mixed = useScopedSettingsMixed([settingKey]);
  const update = useUpdateScopedSettings();
  const saved = mixed ? "" : value.join("\n");
  const [draft, setDraft] = useDraft(saved);
  const { title } = searchableSetting(searchId);
  const patterns = runnerPatterns(draft.split("\n"));
  const error = runnerPatternsError(patterns);
  return (
    <SettingsRow
      {...searchableSetting(searchId)}
      serverScoped
      settingKeys={[settingKey]}
      description={description}
      status={error === null ? undefined : <span className="text-destructive">{error}</span>}
      resetAction={useResetAction(settingKey, title)}
    >
      <div className="mt-3 max-w-2xl pb-3.5">
        <Textarea
          aria-label={title}
          aria-invalid={error !== null || undefined}
          autoCapitalize="none"
          spellCheck={false}
          rows={4}
          placeholder={mixed ? "Mixed. Enter patterns to apply to all selected targets." : ""}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (error !== null || (mixed && patterns.length === 0)) return;
            const normalized = patterns.join("\n");
            setDraft(normalized);
            if (normalized === saved) return;
            update({ [settingKey]: patterns }, { onFailed: () => setDraft(saved) });
          }}
        />
      </div>
    </SettingsRow>
  );
}

function HostRow({ linux }: { readonly linux: HeavyQueueState["linux"] }) {
  const value = useScopedSettings((settings) => settings.runnerHost);
  const update = useUpdateScopedSettings();
  const [draft, setDraft] = useDraft(value);
  const { title } = searchableSetting("runner-host");
  const typed = draft.trim();
  const error = runnerHostError(typed);
  const reset = useResetAction("runnerHost", title);
  const projectScope = useIsProjectScope();
  return (
    <SettingsRow
      {...searchableSetting("runner-host")}
      serverScoped
      settingKeys={["runnerHost"]}
      description="The Linux PC, as an alias from ~/.ssh/config or user@host."
      status={
        error !== null ? (
          <span className="text-destructive">{error}</span>
        ) : linux === null ? undefined : (
          linuxLine(linux)
        )
      }
      resetAction={projectScope ? null : reset}
      control={
        <Input
          size="sm"
          aria-label={title}
          aria-invalid={error !== null || undefined}
          autoCapitalize="none"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (error === null && typed !== value) {
              update({ runnerHost: typed }, { onFailed: () => setDraft(value) });
            }
          }}
        />
      }
    />
  );
}

export function RunnerSettingsSection() {
  const { scope, environment } = useSettingsScope();
  const environmentId =
    scope.environmentIds.length === 1 ? (environment?.environmentId ?? null) : null;
  const queue = useHeavyQueue(environmentId);
  const modeLine = useHeavyModeLine(queue);
  const enabled = useScopedSettings((settings) => settings.runnerEnabled);
  const update = useUpdateScopedSettings();
  const { title } = searchableSetting("runner-enabled");
  return (
    <SettingsSection id="runner" title="Runner">
      <SettingsRow
        {...searchableSetting("runner-enabled")}
        serverScoped
        settingKeys={["runnerEnabled"]}
        description="Runs heavy jobs on a Linux PC over SSH as well as on this Mac. Works with the queue on or off."
        status={environmentId === null ? undefined : modeLine}
        resetAction={useResetAction("runnerEnabled", title)}
        control={
          <ScopedSwitch
            settingKeys={["runnerEnabled"]}
            checked={enabled}
            onCheckedChange={(checked) => update({ runnerEnabled: Boolean(checked) })}
            aria-label={title}
          />
        }
      />
      <ChoiceRow
        settingKey="runnerWhere"
        searchId="runner-where"
        labels={RUNNER_WHERE_LABEL}
        description="This Mac keeps everything here. Linux sends the listed commands there. Automatic keeps work here until this Mac has the number of jobs below, then sends listed commands to Linux."
      />
      <NumberRow
        settingKey="runnerOverflow"
        searchId="runner-overflow"
        description="Automatic sends work to Linux once this Mac has this many heavy jobs, running and waiting."
      />
      <PatternsRow
        settingKey="runnerLinuxCommands"
        searchId="runner-linux-commands"
        description="One per line. A heavy command that contains one of these may run on Linux. Builds are left out because their output would stay on the PC."
      />
      <PatternsRow
        settingKey="runnerMacOnly"
        searchId="runner-mac-only"
        description="One per line. A heavy command that contains one of these always runs on this Mac, such as simulators and native builds."
      />
      <ChoiceRow
        settingKey="runnerUnavailable"
        searchId="runner-unavailable"
        labels={RUNNER_POLICY_LABEL}
        description="What a job headed for Linux does while Linux is offline."
      />
      <ChoiceRow
        settingKey="runnerDropped"
        searchId="runner-dropped"
        labels={RUNNER_POLICY_LABEL}
        description="What a job does when Linux goes away while it runs there."
      />
      <NumberRow
        settingKey="runnerAskMinutes"
        searchId="runner-ask-minutes"
        description="How long Ask me waits for your answer. An agent's foreground command gives up after 10 minutes, so a longer wait only helps background commands."
      />
      <ChoiceRow
        settingKey="runnerDeadlineAction"
        searchId="runner-deadline"
        labels={RUNNER_DEADLINE_LABEL}
        description="What happens when nobody answers in time."
      />
      <HostRow linux={queue.linux} />
      <NumberRow
        machine
        settingKey="runnerLinuxSlots"
        searchId="runner-linux-slots"
        description="How many heavy jobs Linux runs at the same time."
      />
      <NumberRow
        machine
        settingKey="runnerHeartbeatSeconds"
        searchId="runner-heartbeat"
        description="How often this Mac checks that Linux is reachable and how busy it is."
      />
      <NumberRow
        machine
        settingKey="runnerOfflineAfterFailures"
        searchId="runner-offline-after"
        description="Failed checks in a row before Linux counts as offline."
      />
      <NumberRow
        machine
        settingKey="runnerSshTimeoutSeconds"
        searchId="runner-ssh-timeout"
        description="How long one SSH check waits before it counts as failed."
      />
      <NumberRow
        machine
        settingKey="runnerStopWaitSeconds"
        searchId="runner-stop-wait"
        description="How long a stopped Linux job gets to exit before it is killed."
      />
    </SettingsSection>
  );
}
