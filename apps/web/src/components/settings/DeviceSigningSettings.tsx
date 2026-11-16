import { isAppleBundleId, isAppleTeamId, type ServerSettings } from "@t3tools/contracts";
import { useState } from "react";

import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting, settingCopy } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function SigningField(props: {
  readonly settingKey: "appleTeamId" | "appleRunnerBundleId";
  readonly title: string;
  readonly description?: string;
  readonly placeholder: string;
  readonly invalidMessage: string;
  readonly isValid: (value: string) => boolean;
  readonly value: string;
  readonly normalize?: (value: string) => string;
}) {
  const updateSettings = useUpdateScopedSettings();
  const [draft, setDraft] = useState(props.value);
  const [syncedValue, setSyncedValue] = useState(props.value);
  // A saved value that changes elsewhere replaces the draft.
  if (syncedValue !== props.value) {
    setSyncedValue(props.value);
    setDraft(props.value);
  }
  const value = draft.trim();
  const invalid = value !== "" && !props.isValid(value);
  const settingKeys: readonly (keyof ServerSettings)[] = [props.settingKey];
  return (
    <SettingsRow
      serverScoped
      settingKeys={settingKeys}
      title={props.title}
      description={props.description}
      status={
        invalid ? <span className="text-destructive">{props.invalidMessage}</span> : undefined
      }
      control={
        <Input
          aria-label={props.title}
          aria-invalid={invalid || undefined}
          autoCapitalize="none"
          spellCheck={false}
          placeholder={props.placeholder}
          value={draft}
          onChange={(event) =>
            setDraft(props.normalize ? props.normalize(event.target.value) : event.target.value)
          }
          onBlur={() => {
            if (!invalid && value !== props.value)
              updateSettings(
                { [props.settingKey]: value },
                { onFailed: () => setDraft(props.value) },
              );
          }}
        />
      }
    />
  );
}

export function DeviceSigningSettings() {
  const settings = useScopedSettings();
  return (
    <SettingsSection {...searchableSetting("device-signing")}>
      <SigningField
        settingKey="appleTeamId"
        {...settingCopy("apple-team-id")}
        placeholder="ABCDE12345"
        invalidMessage="A Team ID is 10 uppercase letters and digits, such as ABCDE12345."
        isValid={isAppleTeamId}
        normalize={(value) => value.toUpperCase()}
        value={settings.appleTeamId}
      />
      <SigningField
        settingKey="appleRunnerBundleId"
        {...settingCopy("apple-runner-bundle-id")}
        placeholder="com.yourname.agentdevice.runner"
        invalidMessage="A bundle id is reverse-DNS, such as com.yourname.agentdevice.runner."
        isValid={isAppleBundleId}
        value={settings.appleRunnerBundleId}
      />
      <SettingsRow {...settingCopy("device-first-run")} />
    </SettingsSection>
  );
}
