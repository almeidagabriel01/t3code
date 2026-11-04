import { KEEP_AWAKE_MODES, type KeepAwakeMode } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { useKeepAwakeStatus } from "../../state/keepAwake";
import { Radio, RadioGroup } from "../ui/radio-group";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const KEEP_AWAKE_LABELS: Record<KeepAwakeMode, string> = {
  off: "Off",
  "while-working": "While agents are working",
  always: "Always",
};

const KEEP_AWAKE_DESCRIPTION =
  "Your computer can't run agents while it sleeps. Closing a laptop lid still puts it to sleep unless it is plugged in with an external display.";

const KEEP_AWAKE_UNSUPPORTED = "Not available on this system";

export function KeepAwakeSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const canWrite = useScopedSettingsWriteAllowed();
  const mixed = useScopedSettingsMixed(["keepAwake"]);
  const { scope, environment } = useSettingsScope();
  const environmentId =
    scope.environmentIds.length === 1 ? (environment?.environmentId ?? null) : null;
  const unsupported = useKeepAwakeStatus(environmentId)?.supported === false;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["keepAwake"]}
      id={searchableSetting("keep-awake").id}
      title={searchableSetting("keep-awake").title}
      description={KEEP_AWAKE_DESCRIPTION}
      status={unsupported ? KEEP_AWAKE_UNSUPPORTED : null}
      resetAction={
        settings.keepAwake !== DEFAULT_UNIFIED_SETTINGS.keepAwake ? (
          <SettingResetButton
            label="keep this computer awake"
            onClick={() => updateSettings({ keepAwake: DEFAULT_UNIFIED_SETTINGS.keepAwake })}
          />
        ) : null
      }
    >
      <div className="pt-2 pb-2">
        <RadioGroup
          aria-label="Keep this computer awake"
          value={mixed ? null : settings.keepAwake}
          disabled={!canWrite || unsupported}
          onValueChange={(value) => {
            const mode = KEEP_AWAKE_MODES.find((candidate) => candidate === value);
            if (mode !== undefined) updateSettings({ keepAwake: mode });
          }}
        >
          {KEEP_AWAKE_MODES.map((mode) => (
            <label
              key={mode}
              className="flex w-fit cursor-pointer items-center gap-2 text-sm has-data-disabled:cursor-default"
            >
              <Radio value={mode} aria-label={KEEP_AWAKE_LABELS[mode]} />
              {KEEP_AWAKE_LABELS[mode]}
            </label>
          ))}
        </RadioGroup>
      </div>
    </SettingsRow>
  );
}
