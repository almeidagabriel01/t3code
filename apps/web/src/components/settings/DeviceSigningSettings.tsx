import { isAppleBundleId, isAppleTeamId, type ServerSettings } from "@t3tools/contracts";
import { useState } from "react";

import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function SigningField(props: {
  readonly settingKey: "appleTeamId" | "appleRunnerBundleId";
  readonly title: string;
  readonly description: string;
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
    <SettingsSection id="device-signing" title="iPhone signing">
      <SigningField
        settingKey="appleTeamId"
        title="Apple Team ID"
        description="Agents need your team id to sign the runner they install on a USB iPhone. Find it under Membership in your Apple Developer account."
        placeholder="ABCDE12345"
        invalidMessage="A Team ID is 10 uppercase letters and digits."
        isValid={isAppleTeamId}
        normalize={(value) => value.toUpperCase()}
        value={settings.appleTeamId}
      />
      <SigningField
        settingKey="appleRunnerBundleId"
        title="Runner bundle id (optional)"
        description="Leave empty to use the default. Set it when the default id is taken by another team."
        placeholder="com.yourname.agentdevice.runner"
        invalidMessage="A bundle id is reverse-DNS, such as com.yourname.agentdevice.runner."
        isValid={isAppleBundleId}
        value={settings.appleRunnerBundleId}
      />
      <SettingsRow
        title="First run on the phone"
        description="Trust the developer profile in Settings, General, VPN & Device Management, and turn on Developer Mode in Privacy & Security."
      />
    </SettingsSection>
  );
}
