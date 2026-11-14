import {
  heavyModeLine,
  linuxLine,
  RUNNER_DEADLINE_LABEL,
  RUNNER_FAILED_POLICY_LABEL,
  RUNNER_POLICY_LABEL,
  RUNNER_SETTING_COPY,
  RUNNER_WHERE_LABEL,
  runnerEverythingOn,
  runnerFieldIdle,
  runnerModeFieldApplies,
  runnerWhereLine,
  type RunnerChoices,
} from "@t3tools/client-runtime/state/runnerModel";
import {
  RUNNER_DEFAULTS,
  RUNNER_LIMITS,
  runnerHostError,
  runnerPatterns,
  runnerPatternsError,
  type HeavyQueueState,
  type RunnerKey,
  type RunnerNumberKey,
  type UnifiedSettings,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { ChevronRightIcon, InfoIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useHeavyQueue } from "../../state/heavyQueue";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsGroup } from "./SettingsGroup";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

type ChoiceKey = "runnerWhere" | "runnerUnavailable" | "runnerDropped" | "runnerDeadlineAction";
type PatternKey = "runnerLinuxCommands" | "runnerMacOnly";

/** The queue × Runner sentence, from this scope's effective Runner values. */
export function useHeavyModeLine(queue: Pick<HeavyQueueState, "enabled" | "paused">) {
  const runnerEnabled = useScopedSettings((settings) => settings.runnerEnabled);
  const where = useScopedSettings((settings) => settings.runnerWhere);
  return heavyModeLine({
    queueEnabled: queue.enabled,
    queuePaused: queue.paused,
    runnerEnabled,
    where,
  });
}

/** A choice's effective value, or null where the selected targets disagree. */
function useChoice<K extends keyof RunnerChoices>(key: K): RunnerChoices[K] {
  const value = useScopedSettings((settings) => settings[key]);
  const mixed = useScopedSettingsMixed([key]);
  return mixed ? null : value;
}

function useRunnerChoices(): RunnerChoices {
  return {
    runnerEnabled: useChoice("runnerEnabled"),
    runnerWhere: useChoice("runnerWhere"),
    runnerUnavailable: useChoice("runnerUnavailable"),
    runnerDropped: useChoice("runnerDropped"),
  };
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

function useIsProjectScope() {
  const { scope } = useSettingsScope();
  return scope.kind === "project" || scope.kind === "checkout";
}

/** A typed value whose saved copy can change elsewhere; that change replaces the draft. */
function useDraft(saved: string) {
  const [draft, setDraft] = useState(saved);
  const [synced, setSynced] = useState(saved);
  if (synced !== saved) {
    setSynced(saved);
    setDraft(saved);
  }
  return [draft, setDraft] as const;
}

/** Shown on a field a search reached while the current choices leave it idle. */
export function IdleNote({ children }: { readonly children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <InfoIcon aria-hidden className="size-3.5 shrink-0" />
      {children}
    </span>
  );
}

export function RunnerGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className="space-y-1.5">
      <div id={headingId} className="px-3 text-xs font-medium text-muted-foreground sm:px-4">
        {title}
      </div>
      <SettingsGroup>{children}</SettingsGroup>
    </div>
  );
}

/** A group that starts folded; a search landing on one of its rows opens it. */
function FoldedRunnerGroup({
  title,
  searchIds,
  children,
}: {
  readonly title: string;
  readonly searchIds: ReadonlyArray<SettingsSearchItemId>;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const target = useSettingsSearchTargetId();
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (target !== null && target !== openedFor && searchIds.some((id) => id === target)) {
    setOpenedFor(target);
    setOpen(true);
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex min-h-6 cursor-pointer items-center gap-1 rounded-md px-3 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4">
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        {title}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pt-1.5">
          <SettingsGroup>{children}</SettingsGroup>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function SegmentedRow<K extends ChoiceKey>({
  settingKey,
  searchId,
  labels,
  description,
  idle = null,
}: {
  readonly settingKey: K;
  readonly searchId: SettingsSearchItemId;
  readonly labels: Record<UnifiedSettings[K], string>;
  readonly description: (value: UnifiedSettings[K] | null) => ReactNode;
  readonly idle?: string | null;
}) {
  const value = useScopedSettings((settings) => settings[settingKey]);
  const mixed = useScopedSettingsMixed([settingKey]);
  const update = useUpdateScopedSettings();
  const { title } = searchableSetting(searchId);
  const options = Object.keys(labels) as Array<UnifiedSettings[K]>;
  return (
    <SettingsRow
      {...searchableSetting(searchId)}
      serverScoped
      settingKeys={[settingKey]}
      description={description(mixed ? null : value)}
      status={idle === null ? undefined : <IdleNote>{idle}</IdleNote>}
      resetAction={useResetAction(settingKey, title)}
      control={
        <ToggleGroup
          aria-label={title}
          variant="segmented"
          className="w-full flex-wrap @min-[32rem]/settings-row:w-fit"
          value={mixed ? [] : [value]}
          onValueChange={(next) => {
            const option = options.find((candidate) => candidate === next[0]);
            if (option !== undefined) update({ [settingKey]: option });
          }}
        >
          {options.map((option) => (
            <Toggle
              key={option}
              value={option}
              className="flex-auto @min-[32rem]/settings-row:flex-none"
            >
              {labels[option]}
            </Toggle>
          ))}
        </ToggleGroup>
      }
    />
  );
}

const UNIT_SUFFIX: Partial<Record<string, string>> = { percent: "%", seconds: "s" };

/** A whole-number stepper with its unit; commits only a changed integer. Null value reads "Mixed". */
export function UnitStepper({
  title,
  min,
  max,
  unit,
  value,
  disabled = false,
  onCommit,
}: {
  readonly title: string;
  readonly min: number;
  readonly max: number;
  readonly unit: string;
  readonly value: number | null;
  readonly disabled?: boolean;
  readonly onCommit: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <NumberField
        size="sm"
        className="w-28"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onValueCommitted={(next) => {
          if (next === null || !Number.isInteger(next) || next === value) return;
          onCommit(next);
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label={`Decrease ${title}`} />
          <NumberFieldInput aria-label={title} placeholder={value === null ? "Mixed" : undefined} />
          <NumberFieldIncrement aria-label={`Increase ${title}`} />
        </NumberFieldGroup>
      </NumberField>
      <span className="w-12 text-xs text-muted-foreground">{UNIT_SUFFIX[unit] ?? unit}</span>
    </div>
  );
}

function NumberRow({
  settingKey,
  searchId,
  machine = false,
  idle = null,
}: {
  readonly settingKey: RunnerNumberKey;
  readonly searchId: SettingsSearchItemId;
  readonly machine?: boolean;
  readonly idle?: string | null;
}) {
  const value = useScopedSettings((settings) => settings[settingKey]);
  const mixed = useScopedSettingsMixed([settingKey]);
  const update = useUpdateScopedSettings();
  const { title } = searchableSetting(searchId);
  const { min, max, unit } = RUNNER_LIMITS[settingKey];
  const reset = useResetAction(settingKey, title);
  const projectScope = useIsProjectScope();
  return (
    <SettingsRow
      {...searchableSetting(searchId)}
      serverScoped
      settingKeys={[settingKey]}
      description={RUNNER_SETTING_COPY[settingKey].description}
      status={idle === null ? undefined : <IdleNote>{idle}</IdleNote>}
      resetAction={machine && projectScope ? null : reset}
      control={
        <UnitStepper
          title={title}
          min={min}
          max={max}
          unit={unit}
          value={mixed ? null : value}
          onCommit={(next) => update({ [settingKey]: next })}
        />
      }
    />
  );
}

function SwitchRow({
  settingKey,
  searchId,
  idle = null,
  titleOnly = false,
}: {
  readonly settingKey: "runnerLinuxEverything" | "runnerBringBack";
  readonly searchId: SettingsSearchItemId;
  readonly idle?: string | null;
  readonly titleOnly?: boolean;
}) {
  const value = useScopedSettings((settings) => settings[settingKey]);
  const update = useUpdateScopedSettings();
  const { title } = searchableSetting(searchId);
  return (
    <SettingsRow
      {...searchableSetting(searchId)}
      serverScoped
      settingKeys={[settingKey]}
      description={titleOnly ? undefined : RUNNER_SETTING_COPY[settingKey].description}
      status={idle === null ? undefined : <IdleNote>{idle}</IdleNote>}
      resetAction={useResetAction(settingKey, title)}
      control={
        <ScopedSwitch
          settingKeys={[settingKey]}
          checked={value}
          onCheckedChange={(checked) => update({ [settingKey]: Boolean(checked) })}
          aria-label={title}
        />
      }
    />
  );
}

/** Commands as removable chips, with a field that adds one on Enter. */
function CommandsRow({
  settingKey,
  searchId,
  idle = null,
}: {
  readonly settingKey: PatternKey;
  readonly searchId: SettingsSearchItemId;
  readonly idle?: string | null;
}) {
  const value = useScopedSettings((settings) => settings[settingKey]);
  const mixed = useScopedSettingsMixed([settingKey]);
  const update = useUpdateScopedSettings();
  const { title } = searchableSetting(searchId);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = (next: ReadonlyArray<string>) => {
    const patterns = runnerPatterns(next);
    const problem = runnerPatternsError(patterns);
    setError(problem);
    if (problem === null) update({ [settingKey]: patterns });
    return problem === null;
  };
  const add = () => {
    const command = typed.trim();
    if (command === "") return;
    if (value.includes(command)) {
      setTyped("");
      return;
    }
    if (save([...value, command])) setTyped("");
  };
  return (
    <SettingsRow
      {...searchableSetting(searchId)}
      serverScoped
      settingKeys={[settingKey]}
      description={RUNNER_SETTING_COPY[settingKey].description}
      status={
        error !== null ? (
          <span className="text-destructive">{error}</span>
        ) : idle === null ? undefined : (
          <IdleNote>{idle}</IdleNote>
        )
      }
      resetAction={useResetAction(settingKey, title)}
    >
      <div className="flex flex-wrap items-center gap-1.5 pt-2.5 pb-3">
        {mixed ? (
          <span className="text-xs text-muted-foreground">
            Differs across the selected targets. Reset to use the defaults everywhere.
          </span>
        ) : (
          value.map((command) => (
            <span
              key={command}
              className="inline-flex h-6 items-center gap-0.5 rounded-md border border-foreground/12 bg-foreground/4 ps-2 pe-0.5 font-mono text-xs text-foreground/90"
            >
              {command}
              <Button
                variant="ghost-muted"
                size="icon-micro"
                aria-label={`Remove ${command} from ${title}`}
                onClick={() => save(value.filter((candidate) => candidate !== command))}
              >
                <XIcon aria-hidden />
              </Button>
            </span>
          ))
        )}
        {mixed ? null : (
          <div className="flex items-center gap-1">
            <Input
              size="sm"
              className="w-36"
              aria-label={`Add a command to ${title}`}
              aria-invalid={error !== null || undefined}
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Add command"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
            />
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label={`Add to ${title}`}
              disabled={typed.trim() === ""}
              onClick={add}
            >
              <PlusIcon aria-hidden />
            </Button>
          </div>
        )}
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
          <LinuxStatus linux={linux} detail />
        )
      }
      resetAction={projectScope ? null : reset}
      control={
        <Input
          size="sm"
          className="w-full @min-[32rem]/settings-row:w-44"
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

/** A colored dot and the Linux state; `detail` adds slots, load and memory. */
function LinuxStatus({
  linux,
  detail = false,
}: {
  readonly linux: NonNullable<HeavyQueueState["linux"]>;
  readonly detail?: boolean;
}) {
  const text = detail
    ? linuxLine(linux)
    : linux.online === null
      ? "Checking Linux"
      : linux.online
        ? "Linux online"
        : "Linux offline";
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          linux.online === null
            ? "bg-muted-foreground/60"
            : linux.online
              ? "bg-success"
              : "bg-destructive",
        )}
      />
      <span className="truncate">{text}</span>
    </span>
  );
}

const CONNECTION_SEARCH_IDS = [
  "runner-heartbeat",
  "runner-offline-after",
  "runner-ssh-timeout",
  "runner-stop-wait",
] as const satisfies ReadonlyArray<SettingsSearchItemId>;

const SEARCH_ID: Partial<Record<RunnerKey, SettingsSearchItemId>> = {
  runnerWhere: "runner-where",
  runnerMacFirstAfter: "runner-mac-first-after",
  runnerLinuxEverything: "runner-linux-everything",
  runnerBringBack: "runner-bring-back",
  runnerLinuxCommands: "runner-linux-commands",
  runnerMacOnly: "runner-mac-only",
  runnerHost: "runner-host",
  runnerLinuxSlots: "runner-linux-slots",
  runnerLinuxCpuCeilingPercent: "runner-linux-cpu-ceiling",
  runnerLinuxMemoryFloorPercent: "runner-linux-memory-floor",
  runnerUnavailable: "runner-unavailable",
  runnerDropped: "runner-dropped",
  runnerAskMinutes: "runner-ask-minutes",
  runnerDeadlineAction: "runner-deadline",
  runnerHeartbeatSeconds: "runner-heartbeat",
  runnerOfflineAfterFailures: "runner-offline-after",
  runnerSshTimeoutSeconds: "runner-ssh-timeout",
  runnerStopWaitSeconds: "runner-stop-wait",
};

export function RunnerSettingsSection() {
  const { scope, environment } = useSettingsScope();
  const environmentId =
    scope.environmentIds.length === 1 ? (environment?.environmentId ?? null) : null;
  const queue = useHeavyQueue(environmentId);
  const enabled = useScopedSettings((settings) => settings.runnerEnabled);
  const update = useUpdateScopedSettings();
  const choices = useRunnerChoices();
  const everythingValue = useScopedSettings((settings) => settings.runnerLinuxEverything);
  const everythingMixed = useScopedSettingsMixed(["runnerLinuxEverything"]);
  const everythingSet = everythingMixed ? null : everythingValue;
  const everythingOn = runnerEverythingOn(choices.runnerWhere, everythingSet);
  const target = useSettingsSearchTargetId();
  const { title } = searchableSetting("runner-enabled");
  /** A field shows when it applies, or when a search lands on it (then with why it is idle). */
  const field = (key: RunnerKey) => {
    const idle = runnerFieldIdle(key, choices);
    const applies = runnerModeFieldApplies(key, choices.runnerWhere, everythingSet);
    return { shown: (idle === null && applies) || target === SEARCH_ID[key], idle };
  };
  const macFirstAfter = field("runnerMacFirstAfter");
  const everything = field("runnerLinuxEverything");
  const linuxCommands = field("runnerLinuxCommands");
  const askMinutes = field("runnerAskMinutes");
  const deadline = field("runnerDeadlineAction");
  const machine = field("runnerHost");
  const anyShown = (...keys: ReadonlyArray<RunnerKey>) => keys.some((key) => field(key).shown);
  const linux = environmentId === null ? null : queue.linux;
  return (
    <SettingsSection
      id="runner"
      title="Runner"
      variant="plain"
      headerAction={linux === null ? null : <LinuxStatus linux={linux} />}
    >
      <div className="space-y-5">
        <SettingsGroup>
          <SettingsRow
            {...searchableSetting("runner-enabled")}
            serverScoped
            settingKeys={["runnerEnabled"]}
            description={RUNNER_SETTING_COPY.runnerEnabled.description}
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
        </SettingsGroup>
        {anyShown("runnerWhere", "runnerLinuxCommands", "runnerMacOnly") ? (
          <RunnerGroup title="Where jobs run">
            <SegmentedRow
              settingKey="runnerWhere"
              searchId="runner-where"
              labels={RUNNER_WHERE_LABEL}
              idle={field("runnerWhere").idle}
              description={(value) => runnerWhereLine(value, everythingSet)}
            />
            {macFirstAfter.shown ? (
              <NumberRow
                settingKey="runnerMacFirstAfter"
                searchId="runner-mac-first-after"
                idle={macFirstAfter.idle}
              />
            ) : null}
            {everything.shown ? (
              <SwitchRow
                settingKey="runnerLinuxEverything"
                searchId="runner-linux-everything"
                idle={everything.idle}
                titleOnly={everythingOn}
              />
            ) : null}
            {linuxCommands.shown ? (
              <CommandsRow
                settingKey="runnerLinuxCommands"
                searchId="runner-linux-commands"
                idle={linuxCommands.idle}
              />
            ) : null}
            <CommandsRow
              settingKey="runnerMacOnly"
              searchId="runner-mac-only"
              idle={field("runnerMacOnly").idle}
            />
            <SwitchRow
              settingKey="runnerBringBack"
              searchId="runner-bring-back"
              idle={field("runnerBringBack").idle}
            />
          </RunnerGroup>
        ) : null}
        {anyShown(
          "runnerHost",
          "runnerLinuxSlots",
          "runnerLinuxCpuCeilingPercent",
          "runnerLinuxMemoryFloorPercent",
        ) ? (
          <RunnerGroup title="Linux PC">
            <HostRow linux={linux} />
            <NumberRow
              machine
              settingKey="runnerLinuxSlots"
              searchId="runner-linux-slots"
              idle={machine.idle}
            />
            <NumberRow
              machine
              settingKey="runnerLinuxCpuCeilingPercent"
              searchId="runner-linux-cpu-ceiling"
              idle={machine.idle}
            />
            <NumberRow
              machine
              settingKey="runnerLinuxMemoryFloorPercent"
              searchId="runner-linux-memory-floor"
              idle={machine.idle}
            />
          </RunnerGroup>
        ) : null}
        {anyShown(
          "runnerUnavailable",
          "runnerDropped",
          "runnerAskMinutes",
          "runnerDeadlineAction",
        ) ? (
          <RunnerGroup title="If Linux is unavailable">
            <SegmentedRow
              settingKey="runnerUnavailable"
              searchId="runner-unavailable"
              labels={RUNNER_POLICY_LABEL}
              idle={field("runnerUnavailable").idle}
              description={() => RUNNER_SETTING_COPY.runnerUnavailable.description}
            />
            <SegmentedRow
              settingKey="runnerDropped"
              searchId="runner-dropped"
              labels={RUNNER_FAILED_POLICY_LABEL}
              idle={field("runnerDropped").idle}
              description={() => RUNNER_SETTING_COPY.runnerDropped.description}
            />
            {askMinutes.shown ? (
              <NumberRow
                settingKey="runnerAskMinutes"
                searchId="runner-ask-minutes"
                idle={askMinutes.idle}
              />
            ) : null}
            {deadline.shown ? (
              <SegmentedRow
                settingKey="runnerDeadlineAction"
                searchId="runner-deadline"
                labels={RUNNER_DEADLINE_LABEL}
                idle={deadline.idle}
                description={() => RUNNER_SETTING_COPY.runnerDeadlineAction.description}
              />
            ) : null}
          </RunnerGroup>
        ) : null}
        {anyShown(
          "runnerHeartbeatSeconds",
          "runnerOfflineAfterFailures",
          "runnerSshTimeoutSeconds",
          "runnerStopWaitSeconds",
        ) ? (
          <FoldedRunnerGroup title="Connection checks" searchIds={CONNECTION_SEARCH_IDS}>
            <NumberRow
              machine
              settingKey="runnerHeartbeatSeconds"
              searchId="runner-heartbeat"
              idle={field("runnerHeartbeatSeconds").idle}
            />
            <NumberRow
              machine
              settingKey="runnerOfflineAfterFailures"
              searchId="runner-offline-after"
              idle={field("runnerOfflineAfterFailures").idle}
            />
            <NumberRow
              machine
              settingKey="runnerSshTimeoutSeconds"
              searchId="runner-ssh-timeout"
              idle={field("runnerSshTimeoutSeconds").idle}
            />
            <NumberRow
              machine
              settingKey="runnerStopWaitSeconds"
              searchId="runner-stop-wait"
              idle={field("runnerStopWaitSeconds").idle}
            />
          </FoldedRunnerGroup>
        ) : null}
      </div>
    </SettingsSection>
  );
}
