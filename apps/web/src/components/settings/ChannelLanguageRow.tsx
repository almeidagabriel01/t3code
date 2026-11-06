import {
  CHANNEL_LANGUAGE_DESCRIPTION,
  CHANNEL_LANGUAGE_OPTIONS,
  type EnvironmentId,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";

/** One server setting, shown in both the iMessage and the Telegram settings. */
export function ChannelLanguageRow(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const language = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.channelLanguage,
  );
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  return (
    <SettingsRow
      title="Language"
      description={CHANNEL_LANGUAGE_DESCRIPTION}
      control={
        <Select
          value={language}
          disabled={props.disabled}
          onValueChange={(value) => {
            const option = CHANNEL_LANGUAGE_OPTIONS.find((candidate) => candidate.value === value);
            if (option !== undefined) updateSettings({ channelLanguage: option.value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Language">
            <SelectValue>
              {CHANNEL_LANGUAGE_OPTIONS.find((option) => option.value === language)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {CHANNEL_LANGUAGE_OPTIONS.map((option) => (
              <SelectItem hideIndicator key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
