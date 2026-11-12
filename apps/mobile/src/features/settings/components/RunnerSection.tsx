import {
  heavyModeLine,
  linuxLine,
  RUNNER_DEADLINE_LABEL,
  RUNNER_POLICY_LABEL,
  RUNNER_WHERE_LABEL,
  RUNNER_SETTING_COPY,
} from "@t3tools/client-runtime/state/runnerModel";
import {
  RUNNER_LIMITS,
  RUNNER_PROJECT_KEYS,
  RunnerDeadlineAction,
  RunnerUnavailablePolicy,
  RunnerWhere,
  runnerHostError,
  runnerNumberError,
  runnerPatterns,
  runnerPatternsError,
  type EnvironmentId,
  type RunnerKey,
  type RunnerNumberKey,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { View } from "react-native";

import type { AppSymbolName } from "../../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { useHeavyQueueState } from "../../../state/heavyQueue";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export type RunnerProjectKey = (typeof RUNNER_PROJECT_KEYS)[number];
type Check = { readonly error: string } | { readonly patch: ServerSettingsPatch | null };

const patchOf = (key: RunnerKey, value: unknown) => ({ [key]: value }) as ServerSettingsPatch;
const isProjectKey = (key: RunnerKey): key is RunnerProjectKey =>
  RUNNER_PROJECT_KEYS.includes(key as RunnerProjectKey);
const range = (key: RunnerNumberKey) =>
  `${RUNNER_LIMITS[key].min} to ${RUNNER_LIMITS[key].max} ${RUNNER_LIMITS[key].unit}.`;

/** A typed value, checked as typed and saved on end editing or when the screen closes. */
function DraftField(props: {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly multiline?: boolean;
  readonly numeric?: boolean;
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
      <AppTextInput
        key={props.mixed ? null : props.value}
        accessibilityLabel={props.label}
        defaultValue={props.mixed ? "" : props.value}
        placeholder={props.mixed ? "Mixed" : undefined}
        editable={!props.disabled}
        multiline={props.multiline}
        keyboardType={props.numeric ? "number-pad" : "default"}
        autoCapitalize="none"
        autoCorrect={false}
        className={
          props.multiline
            ? "min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
            : "min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        }
        onChangeText={(text) => {
          draft.current = { text, over: props.value };
          const result = props.check(text);
          setError("error" in result ? result.error : null);
        }}
        onEndEditing={commit}
      />
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

const patternsCheck =
  (key: "runnerLinuxCommands" | "runnerMacOnly", saved: ReadonlyArray<string> | null) =>
  (text: string): Check => {
    const next = runnerPatterns(text.split("\n"));
    const error = runnerPatternsError(next);
    if (error !== null) return { error };
    return { patch: next.join("\n") === saved?.join("\n") ? null : patchOf(key, next) };
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
}) {
  const { settings, projectSelected } = props;
  const state = useHeavyQueueState(props.environmentId);
  const scoped = (key: RunnerKey, text: string) => {
    if (!projectSelected) return text;
    if (!isProjectKey(key))
      return `${text} Environment-wide setting. Select All projects to change it.`;
    return `${text} ${props.overridden(key) ? "Set for this project." : "Inherited from the environment."}`;
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
  const choices = <
    K extends "runnerWhere" | "runnerUnavailable" | "runnerDropped" | "runnerDeadlineAction",
  >(
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
        disabled={props.disabledFor(key)}
        numeric
        mixed={props.mixed(key)}
        check={numberCheck(key, props.mixed(key) ? null : settings[key])}
        onSave={props.write}
      />
      {isProjectKey(key) ? resetRow(key) : null}
    </>
  );
  const patterns = (key: "runnerLinuxCommands" | "runnerMacOnly") => (
    <>
      <DraftField
        label={RUNNER_SETTING_COPY[key].title}
        description={scoped(key, RUNNER_SETTING_COPY[key].description)}
        value={settings[key].join("\n")}
        disabled={props.disabledFor(key)}
        multiline
        mixed={props.mixed(key)}
        check={patternsCheck(key, props.mixed(key) ? null : settings[key])}
        onSave={props.write}
      />
      {resetRow(key)}
    </>
  );
  return (
    <>
      <SettingsSection title="Runner">
        <ListRowLayout
          icon="arrow.left.arrow.right"
          label={heavyModeLine({
            queueEnabled: state.enabled,
            queuePaused: state.paused,
            runnerEnabled: settings.runnerEnabled,
            where: settings.runnerWhere,
            overflow: settings.runnerOverflow,
          })}
        />
        {state.linux === null ? null : (
          <ListRowLayout icon="server.rack" label={linuxLine(state.linux)} />
        )}
        <SettingsSwitchRow
          icon="desktopcomputer"
          label={RUNNER_SETTING_COPY.runnerEnabled.title}
          subtitle={scoped("runnerEnabled", RUNNER_SETTING_COPY.runnerEnabled.description)}
          value={props.mixed("runnerEnabled") ? null : settings.runnerEnabled}
          disabled={props.disabledFor("runnerEnabled")}
          onValueChange={(value) => props.write({ runnerEnabled: value })}
        />
        {resetRow("runnerEnabled")}
        {choices("runnerWhere", "laptopcomputer", RunnerWhere.literals, RUNNER_WHERE_LABEL)}
        {number("runnerOverflow")}
      </SettingsSection>
      <SettingsSection title="Runner commands">
        {patterns("runnerLinuxCommands")}
        {patterns("runnerMacOnly")}
      </SettingsSection>
      <SettingsSection title="When Linux is unavailable">
        {choices(
          "runnerUnavailable",
          "wifi.slash",
          RunnerUnavailablePolicy.literals,
          RUNNER_POLICY_LABEL,
        )}
        {choices(
          "runnerDropped",
          "exclamationmark.triangle",
          RunnerUnavailablePolicy.literals,
          RUNNER_POLICY_LABEL,
        )}
        {number("runnerAskMinutes")}
        {choices(
          "runnerDeadlineAction",
          "timer",
          RunnerDeadlineAction.literals,
          RUNNER_DEADLINE_LABEL,
        )}
      </SettingsSection>
      <SettingsSection title="Linux PC" footer="These apply to every project on this environment.">
        <DraftField
          label={RUNNER_SETTING_COPY.runnerHost.title}
          description={scoped("runnerHost", RUNNER_SETTING_COPY.runnerHost.description)}
          value={settings.runnerHost}
          disabled={props.disabledFor("runnerHost")}
          mixed={props.mixed("runnerHost")}
          check={hostCheck(props.mixed("runnerHost") ? null : settings.runnerHost)}
          onSave={props.write}
        />
        {number("runnerLinuxSlots")}
        {number("runnerHeartbeatSeconds")}
        {number("runnerOfflineAfterFailures")}
        {number("runnerSshTimeoutSeconds")}
        {number("runnerStopWaitSeconds")}
      </SettingsSection>
    </>
  );
}
