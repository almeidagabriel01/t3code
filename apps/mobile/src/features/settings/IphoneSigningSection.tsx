import { useAtomValue } from "@effect/atom-react";
import {
  isAppleBundleId,
  isAppleTeamId,
  type EnvironmentId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useState } from "react";
import { Keyboard, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

export const IPHONE_SIGNING_INTRO =
  "Agents need your Apple Team ID to sign the on-device runner that drives a USB iPhone. The first run asks you to trust the developer profile on the phone (Settings > General > VPN & Device Management) and to turn on Developer Mode.";
const TEAM_ID_ERROR = "A Team ID is 10 uppercase letters and digits, such as ABCDE12345.";
const BUNDLE_ID_ERROR = "A bundle id is reverse-DNS, such as com.yourname.agentdevice.runner.";

/** Empty clears a field; anything else must be valid before either field is saved. */
export function iphoneSigningDraft(
  saved: { readonly teamId: string; readonly bundleId: string },
  draft: { readonly teamId: string; readonly bundleId: string },
) {
  const teamId = draft.teamId.trim();
  const bundleId = draft.bundleId.trim();
  const teamError = teamId === "" || isAppleTeamId(teamId) ? null : TEAM_ID_ERROR;
  const bundleError = bundleId === "" || isAppleBundleId(bundleId) ? null : BUNDLE_ID_ERROR;
  const patch: ServerSettingsPatch = {
    ...(teamId !== saved.teamId ? { appleTeamId: teamId } : {}),
    ...(bundleId !== saved.bundleId ? { appleRunnerBundleId: bundleId } : {}),
  };
  return { teamError, bundleError, patch: teamError || bundleError ? {} : patch };
}

function Field(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly error: string | null;
  readonly editable: boolean;
  readonly capitalize: "characters" | "none";
  readonly onChangeText: (text: string) => void;
}) {
  return (
    <View className="gap-1.5 px-4 py-3">
      <Text className="text-sm font-t3-medium">{props.label}</Text>
      <AppTextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        editable={props.editable}
        autoCapitalize={props.capitalize}
        autoCorrect={false}
        className="min-h-10 py-2"
      />
      {props.error ? <Text className="text-xs text-destructive">{props.error}</Text> : null}
    </View>
  );
}

function SigningForm(props: {
  readonly environmentId: EnvironmentId;
  readonly suffix: string;
  readonly saved: { readonly teamId: string; readonly bundleId: string };
}) {
  const allowed = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [draft, setDraft] = useState(props.saved);
  const [busy, setBusy] = useState(false);
  const { teamError, bundleError, patch } = iphoneSigningDraft(props.saved, draft);
  const save = () => {
    Keyboard.dismiss();
    setBusy(true);
    void update({ environmentId: props.environmentId, input: { patch } }).finally(() =>
      setBusy(false),
    );
  };
  return (
    <SettingsSection title={`iPhone signing${props.suffix}`}>
      <Text textRole="footnote" className="px-4 pt-3 text-foreground-muted">
        {IPHONE_SIGNING_INTRO}
      </Text>
      <Field
        label="Apple Team ID"
        value={draft.teamId}
        placeholder="ABCDE12345"
        error={teamError}
        editable={allowed && !busy}
        capitalize="characters"
        onChangeText={(teamId) => setDraft({ ...draft, teamId })}
      />
      <Field
        label="Runner bundle id (optional)"
        value={draft.bundleId}
        placeholder="com.yourname.agentdevice.runner"
        error={bundleError}
        editable={allowed && !busy}
        capitalize="none"
        onChangeText={(bundleId) => setDraft({ ...draft, bundleId })}
      />
      <View className="items-start px-4 pb-3">
        <Button
          label="Save iPhone signing"
          tone="secondary"
          disabled={!allowed || busy || Object.keys(patch).length === 0}
          onPress={save}
        />
      </View>
    </SettingsSection>
  );
}

/** The Apple Team ID agents sign the on-device iPhone runner with. */
export function IphoneSigningSection(props: {
  readonly environmentId: EnvironmentId;
  readonly suffix: string;
}) {
  const settings = useAtomValue(serverEnvironment.configValueAtom(props.environmentId))?.settings;
  if (!settings) return null;
  const saved = { teamId: settings.appleTeamId, bundleId: settings.appleRunnerBundleId };
  // A saved or externally changed value remounts the form, dropping a draft typed over the old one.
  return (
    <SigningForm
      key={`${saved.teamId}\n${saved.bundleId}`}
      environmentId={props.environmentId}
      suffix={props.suffix}
      saved={saved}
    />
  );
}
