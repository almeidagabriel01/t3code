import {
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
  RUNNER_PROJECT_KEYS,
  RunnerDeadlineAction,
  RunnerFailedPolicy,
  RunnerUnavailablePolicy,
  runnerHostError,
  runnerNumberError,
  runnerPatterns,
  runnerPatternsError,
  type EnvironmentId,
  type RunnerKey,
  type RunnerNumberKey,
  type RunnerWhere,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { View } from "react-native";

import type { AppSymbolName } from "../../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { Chip } from "../../../components/ui/Chip";
import { IconButton } from "../../../components/ui/IconButton";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { SegmentedControl } from "../../../components/ui/SegmentedControl";
import { useHeavyQueueState } from "../../../state/heavyQueue";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export type RunnerProjectKey = (typeof RUNNER_PROJECT_KEYS)[number];
type Check = { readonly error: string } | { readonly patch: ServerSettingsPatch | null };
type PatternKey = "runnerLinuxCommands" | "runnerMacOnly";

const patchOf = (key: RunnerKey, value: unknown) => ({ [key]: value }) as ServerSettingsPatch;
const isProjectKey = (key: RunnerKey): key is RunnerProjectKey =>
  RUNNER_PROJECT_KEYS.includes(key as RunnerProjectKey);
const UNIT: Record<(typeof RUNNER_LIMITS)[RunnerNumberKey]["unit"], string> = {
  minutes: "min",
  jobs: "jobs",
  seconds: "s",
  failures: "failures",
  percent: "%",
};
const range = (key: RunnerNumberKey) =>
  `${RUNNER_LIMITS[key].min} to ${RUNNER_LIMITS[key].max} ${RUNNER_LIMITS[key].unit}.`;
/** In the order the choice shows them: from all-local to all-remote. */
const WHERE_OPTIONS = (Object.keys(RUNNER_WHERE_LABEL) as RunnerWhere[]).map((value) => ({
  value,
  label: RUNNER_WHERE_LABEL[value],
}));

/** A typed value, checked as typed and saved on end editing or when the screen closes. */
function DraftField(props: {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly unit?: string;
  readonly numeric?: boolean;
  /** A line under the field, such as the Linux status. */
  readonly status?: string;
  /** Selected targets disagree: the field starts empty and any valid entry saves. */
  readonly mixed: boolean;
  readonly check: (text: string) => Check;
  readonly onSave: (patch: ServerSettingsPatch) => void;
}) {
  const draft = useRef<{ text: string; over: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commit = () => {
    const current = draft.current;
    draft.current = null;
    // A draft typed over an older saved value is stale: the new value remounted the input.
    if (current === null || current.over !== props.value) return;
    const result = props.check(current.text);
    if ("error" in result) return setError(result.error);
    setError(null);
    if (result.patch !== null) props.onSave(result.patch);
  };
  // Save on exit too: Android Back hides the keyboard without ending editing.
  const commitOnExit = useEffectEvent(commit);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves an unsent draft to server settings when the section unmounts
  useEffect(() => () => commitOnExit(), []);
  return (
    <View className="gap-2 px-4 py-3">
      <Text className="text-base text-foreground">{props.label}</Text>
      <Text className="text-sm text-foreground-muted">{props.description}</Text>
      <View className="flex-row items-center gap-2">
        <AppTextInput
          key={props.mixed ? null : props.value}
          accessibilityLabel={props.label}
          defaultValue={props.mixed ? "" : props.value}
          placeholder={props.mixed ? "Mixed" : undefined}
          editable={!props.disabled}
          keyboardType={props.numeric ? "number-pad" : "default"}
          autoCapitalize="none"
          autoCorrect={false}
          className="min-h-10 flex-1 rounded-xl px-3 py-2 text-base text-foreground"
          onChangeText={(text) => {
            draft.current = { text, over: props.value };
            const result = props.check(text);
            setError("error" in result ? result.error : null);
          }}
          onEndEditing={commit}
        />
        {props.unit === undefined ? null : (
          <Text className="text-base text-foreground-muted">{props.unit}</Text>
        )}
      </View>
      {error === null ? null : (
        <Text className="text-sm text-danger-foreground" accessibilityRole="alert">
          {error}
        </Text>
      )}
      {error !== null || props.status === undefined ? null : (
        <Text className="text-sm text-foreground-muted">{props.status}</Text>
      )}
    </View>
  );
}

/** Commands as removable chips, with a field that adds one. */
function CommandsField(props: {
  readonly label: string;
  readonly description: string;
  readonly value: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly mixed: boolean;
  readonly onSave: (next: ReadonlyArray<string>) => void;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = (next: ReadonlyArray<string>) => {
    const patterns = runnerPatterns(next);
    const problem = runnerPatternsError(patterns);
    setError(problem);
    if (problem === null) props.onSave(patterns);
    return problem === null;
  };
  const add = () => {
    const command = typed.trim();
    if (command === "") return;
    if (props.value.includes(command) || save([...props.value, command])) setTyped("");
  };
  return (
    <View className="gap-2 px-4 py-3">
      <Text className="text-base text-foreground">{props.label}</Text>
      <Text className="text-sm text-foreground-muted">{props.description}</Text>
      {props.mixed ? null : (
        <>
          <View className="flex-row flex-wrap gap-2">
            {props.value.map((command) => (
              <Chip
                key={command}
                label={command}
                trailingIcon="xmark"
                accessibilityLabel={`Remove ${command} from ${props.label}`}
                disabled={props.disabled}
                onPress={() => save(props.value.filter((candidate) => candidate !== command))}
              />
            ))}
          </View>
          <View className="flex-row items-center gap-2">
            <AppTextInput
              accessibilityLabel={`Add a command to ${props.label}`}
              placeholder="Add command"
              value={typed}
              editable={!props.disabled}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              className="min-h-10 flex-1 rounded-xl px-3 py-2 text-base text-foreground"
              onChangeText={(text) => {
                setTyped(text);
                setError(null);
              }}
              onSubmitEditing={add}
            />
            <IconButton
              icon="plus"
              accessibilityLabel={`Add to ${props.label}`}
              disabled={props.disabled || typed.trim() === ""}
              onPress={add}
            />
          </View>
        </>
      )}
      {error === null ? null : (
        <Text className="text-sm text-danger-foreground" accessibilityRole="alert">
          {error}
        </Text>
      )}
    </View>
  );
}

const numberCheck =
  (key: RunnerNumberKey, saved: number | null) =>
  (text: string): Check => {
    const value = text.trim() === "" ? Number.NaN : Number(text.trim());
    const error = runnerNumberError(key, value);
    if (error !== null) return { error };
    return { patch: value === saved ? null : patchOf(key, value) };
  };

const hostCheck =
  (saved: string | null) =>
  (text: string): Check => {
    const host = text.trim();
    const error = runnerHostError(host);
    if (error !== null) return { error };
    return { patch: host === saved ? null : patchOf("runnerHost", host) };
  };

export function RunnerSection(props: {
  readonly environmentId: EnvironmentId;
  /** Effective values: the project's in project scope, the environment's otherwise. */
  readonly settings: Pick<ServerSettings, RunnerKey>;
  readonly projectSelected: boolean;
  /** True when the selected project sets `key` itself instead of inheriting it. */
  readonly overridden: (key: RunnerProjectKey) => boolean;
  /** True when the selected targets hold different values for `key`. */
  readonly mixed: (key: RunnerKey) => boolean;
  readonly disabledFor: (key: RunnerKey) => boolean;
  readonly write: (patch: ServerSettingsPatch) => void;
  /** Drops the project's own value so it inherits the environment's again. */
  readonly reset: (key: RunnerProjectKey) => void;
  /** Several machines selected: each machine's queue section carries its own Linux status. */
  readonly severalMachines?: boolean;
}) {
  const { settings, projectSelected } = props;
  const state = useHeavyQueueState(props.environmentId);
  const [checksOpen, setChecksOpen] = useState(false);
  const choice = <K extends keyof RunnerChoices>(key: K) =>
    (props.mixed(key) ? null : settings[key]) as RunnerChoices[K];
  const choices: RunnerChoices = {
    runnerEnabled: choice("runnerEnabled"),
    runnerWhere: choice("runnerWhere"),
    runnerUnavailable: choice("runnerUnavailable"),
    runnerDropped: choice("runnerDropped"),
  };
  const everything = props.mixed("runnerLinuxEverything") ? null : settings.runnerLinuxEverything;
  const shown = (...keys: ReadonlyArray<RunnerKey>) =>
    keys.some(
      (key) =>
        runnerFieldIdle(key, choices) === null &&
        runnerModeFieldApplies(key, choices.runnerWhere, everything),
    );
  const scoped = (key: RunnerKey, text: string) => {
    if (!projectSelected) return text;
    if (!isProjectKey(key))
      return `${text} Environment-wide setting. Select All projects to change it.`.trim();
    return `${text} ${props.overridden(key) ? "Set for this project." : "Inherited from the environment."}`.trim();
  };
  const resetRow = (key: RunnerProjectKey) =>
    projectSelected && props.overridden(key) ? (
      <SettingsActionRow
        icon="arrow.uturn.backward"
        label="Use environment value"
        disabled={props.disabledFor(key)}
        onPress={() => props.reset(key)}
      />
    ) : null;
  const policy = <K extends "runnerUnavailable" | "runnerDropped" | "runnerDeadlineAction">(
    key: K,
    icon: AppSymbolName,
    options: ReadonlyArray<ServerSettings[K]>,
    labels: Record<ServerSettings[K], string>,
  ) => (
    <>
      <ListRowLayout
        icon={icon}
        label={RUNNER_SETTING_COPY[key].title}
        description={scoped(key, RUNNER_SETTING_COPY[key].description)}
      />
      {options.map((option) => (
        <ListChoiceRow
          key={option}
          label={labels[option]}
          selected={!props.mixed(key) && settings[key] === option}
          disabled={props.disabledFor(key)}
          onPress={() => props.write(patchOf(key, option))}
        />
      ))}
      {resetRow(key)}
    </>
  );
  const number = (key: RunnerNumberKey) => (
    <>
      <DraftField
        label={RUNNER_SETTING_COPY[key].title}
        description={scoped(key, `${RUNNER_SETTING_COPY[key].description} ${range(key)}`)}
        value={String(settings[key])}
        unit={UNIT[RUNNER_LIMITS[key].unit]}
        disabled={props.disabledFor(key)}
        numeric
        mixed={props.mixed(key)}
        check={numberCheck(key, props.mixed(key) ? null : settings[key])}
        onSave={props.write}
      />
      {isProjectKey(key) ? resetRow(key) : null}
    </>
  );
  const commands = (key: PatternKey) => (
    <>
      <CommandsField
        label={RUNNER_SETTING_COPY[key].title}
        description={scoped(
          key,
          props.mixed(key)
            ? `${RUNNER_SETTING_COPY[key].description} Differs across the selected targets.`
            : RUNNER_SETTING_COPY[key].description,
        )}
        value={settings[key]}
        disabled={props.disabledFor(key)}
        mixed={props.mixed(key)}
        onSave={(next) => props.write(patchOf(key, next))}
      />
      {props.mixed(key) ? (
        <SettingsActionRow
          icon="arrow.counterclockwise"
          label="Use the defaults everywhere"
          disabled={props.disabledFor(key)}
          onPress={() => props.write(patchOf(key, RUNNER_DEFAULTS[key]))}
        />
      ) : null}
      {resetRow(key)}
    </>
  );
  const toggle = (key: "runnerLinuxEverything" | "runnerBringBack", icon: AppSymbolName) => (
    <>
      <SettingsSwitchRow
        icon={icon}
        label={RUNNER_SETTING_COPY[key].title}
        subtitle={
          scoped(
            key,
            // With Everything on, the Where line already says what it does.
            key === "runnerLinuxEverything" && runnerEverythingOn(choices.runnerWhere, everything)
              ? ""
              : RUNNER_SETTING_COPY[key].description,
          ) || undefined
        }
        value={props.mixed(key) ? null : settings[key]}
        disabled={props.disabledFor(key)}
        onValueChange={(value) => props.write(patchOf(key, value))}
      />
      {resetRow(key)}
    </>
  );
  const where = choices.runnerWhere;
  const whereDisabled = props.disabledFor("runnerWhere");
  return (
    <>
      <SettingsSection title="Runner">
        <SettingsSwitchRow
          icon="desktopcomputer"
          label={RUNNER_SETTING_COPY.runnerEnabled.title}
          subtitle={scoped("runnerEnabled", RUNNER_SETTING_COPY.runnerEnabled.description)}
          value={props.mixed("runnerEnabled") ? null : settings.runnerEnabled}
          disabled={props.disabledFor("runnerEnabled")}
          onValueChange={(value) => props.write({ runnerEnabled: value })}
        />
        {resetRow("runnerEnabled")}
      </SettingsSection>
      {shown("runnerWhere", "runnerLinuxCommands", "runnerMacOnly") ? (
        <SettingsSection title="Where jobs run">
          <View
            className={whereDisabled ? "gap-2 px-4 py-3 opacity-45" : "gap-2 px-4 py-3"}
            pointerEvents={whereDisabled ? "none" : "auto"}
          >
            <Text className="text-base text-foreground">
              {RUNNER_SETTING_COPY.runnerWhere.title}
            </Text>
            <SegmentedControl
              variant="card"
              options={WHERE_OPTIONS}
              selected={where}
              onSelect={(value) => props.write({ runnerWhere: value })}
            />
            <Text className="text-sm text-foreground-muted">
              {scoped("runnerWhere", runnerWhereLine(where, everything))}
            </Text>
          </View>
          {resetRow("runnerWhere")}
          {shown("runnerMacFirstAfter") ? number("runnerMacFirstAfter") : null}
          {shown("runnerLinuxEverything") ? toggle("runnerLinuxEverything", "server.rack") : null}
          {shown("runnerLinuxCommands") ? commands("runnerLinuxCommands") : null}
          {shown("runnerMacOnly") ? commands("runnerMacOnly") : null}
          {toggle("runnerBringBack", "tray.and.arrow.down")}
        </SettingsSection>
      ) : null}
      {shown(
        "runnerHost",
        "runnerLinuxSlots",
        "runnerLinuxCpuCeilingPercent",
        "runnerLinuxMemoryFloorPercent",
      ) ? (
        <SettingsSection
          title="Linux PC"
          footer="These apply to every project on this environment."
        >
          <DraftField
            label={RUNNER_SETTING_COPY.runnerHost.title}
            description={scoped("runnerHost", RUNNER_SETTING_COPY.runnerHost.description)}
            value={settings.runnerHost}
            disabled={props.disabledFor("runnerHost")}
            mixed={props.mixed("runnerHost")}
            {...(props.severalMachines === true || state.linux === null
              ? {}
              : { status: linuxLine(state.linux) })}
            check={hostCheck(props.mixed("runnerHost") ? null : settings.runnerHost)}
            onSave={props.write}
          />
          {number("runnerLinuxSlots")}
          {number("runnerLinuxCpuCeilingPercent")}
          {number("runnerLinuxMemoryFloorPercent")}
        </SettingsSection>
      ) : null}
      {shown("runnerUnavailable", "runnerDropped", "runnerAskMinutes", "runnerDeadlineAction") ? (
        <SettingsSection title="If Linux is unavailable">
          {shown("runnerUnavailable")
            ? policy(
                "runnerUnavailable",
                "wifi.slash",
                RunnerUnavailablePolicy.literals,
                RUNNER_POLICY_LABEL,
              )
            : null}
          {shown("runnerDropped")
            ? policy(
                "runnerDropped",
                "exclamationmark.triangle",
                RunnerFailedPolicy.literals,
                RUNNER_FAILED_POLICY_LABEL,
              )
            : null}
          {shown("runnerAskMinutes") ? number("runnerAskMinutes") : null}
          {shown("runnerDeadlineAction")
            ? policy(
                "runnerDeadlineAction",
                "timer",
                RunnerDeadlineAction.literals,
                RUNNER_DEADLINE_LABEL,
              )
            : null}
        </SettingsSection>
      ) : null}
      {shown(
        "runnerHeartbeatSeconds",
        "runnerOfflineAfterFailures",
        "runnerSshTimeoutSeconds",
        "runnerStopWaitSeconds",
      ) ? (
        <SettingsSection title="Connection checks">
          <SettingsActionRow
            icon="stethoscope"
            label={checksOpen ? "Hide connection checks" : "Show connection checks"}
            description="How this Mac checks that Linux is reachable."
            onPress={() => setChecksOpen(!checksOpen)}
          />
          {checksOpen ? (
            <>
              {number("runnerHeartbeatSeconds")}
              {number("runnerOfflineAfterFailures")}
              {number("runnerSshTimeoutSeconds")}
              {number("runnerStopWaitSeconds")}
            </>
          ) : null}
        </SettingsSection>
      ) : null}
    </>
  );
}
