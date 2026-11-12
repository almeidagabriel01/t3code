import {
  heavyModeLine,
  linuxLine,
  RUNNER_DEADLINE_LABEL,
  RUNNER_POLICY_LABEL,
  RUNNER_SETTING_COPY,
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
      description={RUNNER_SETTING_COPY.runnerHost.description}
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
        description={RUNNER_SETTING_COPY.runnerEnabled.description}
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
        description={RUNNER_SETTING_COPY.runnerWhere.description}
      />
      <NumberRow
        settingKey="runnerOverflow"
        searchId="runner-overflow"
        description={RUNNER_SETTING_COPY.runnerOverflow.description}
      />
      <PatternsRow
        settingKey="runnerLinuxCommands"
        searchId="runner-linux-commands"
        description={RUNNER_SETTING_COPY.runnerLinuxCommands.description}
      />
      <PatternsRow
        settingKey="runnerMacOnly"
        searchId="runner-mac-only"
        description={RUNNER_SETTING_COPY.runnerMacOnly.description}
      />
      <ChoiceRow
        settingKey="runnerUnavailable"
        searchId="runner-unavailable"
        labels={RUNNER_POLICY_LABEL}
        description={RUNNER_SETTING_COPY.runnerUnavailable.description}
      />
      <ChoiceRow
        settingKey="runnerDropped"
        searchId="runner-dropped"
        labels={RUNNER_POLICY_LABEL}
        description={RUNNER_SETTING_COPY.runnerDropped.description}
      />
      <NumberRow
        settingKey="runnerAskMinutes"
        searchId="runner-ask-minutes"
        description={RUNNER_SETTING_COPY.runnerAskMinutes.description}
      />
      <ChoiceRow
        settingKey="runnerDeadlineAction"
        searchId="runner-deadline"
        labels={RUNNER_DEADLINE_LABEL}
        description={RUNNER_SETTING_COPY.runnerDeadlineAction.description}
      />
      <HostRow linux={queue.linux} />
      <NumberRow
        machine
        settingKey="runnerLinuxSlots"
        searchId="runner-linux-slots"
        description={RUNNER_SETTING_COPY.runnerLinuxSlots.description}
      />
      <NumberRow
        machine
        settingKey="runnerHeartbeatSeconds"
        searchId="runner-heartbeat"
        description={RUNNER_SETTING_COPY.runnerHeartbeatSeconds.description}
      />
      <NumberRow
        machine
        settingKey="runnerOfflineAfterFailures"
        searchId="runner-offline-after"
        description={RUNNER_SETTING_COPY.runnerOfflineAfterFailures.description}
      />
      <NumberRow
        machine
        settingKey="runnerSshTimeoutSeconds"
        searchId="runner-ssh-timeout"
        description={RUNNER_SETTING_COPY.runnerSshTimeoutSeconds.description}
      />
      <NumberRow
        machine
        settingKey="runnerStopWaitSeconds"
        searchId="runner-stop-wait"
        description={RUNNER_SETTING_COPY.runnerStopWaitSeconds.description}
      />
    </SettingsSection>
  );
}
