import {
  CHANNEL_LANGUAGE_DESCRIPTION,
  CHANNEL_LANGUAGE_OPTIONS,
  type EnvironmentId,
} from "@t3tools/contracts";

import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { useChannelLanguage } from "../../../state/channelLanguage";
import { SettingsSection } from "./SettingsSection";

/** One server setting, shown in both the iMessage and the Telegram settings. */
export function ChannelLanguageSection(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const { language, set } = useChannelLanguage(props.environmentId);
  return (
    <SettingsSection title="Language" footer={CHANNEL_LANGUAGE_DESCRIPTION}>
      {CHANNEL_LANGUAGE_OPTIONS.map((option, index) => (
        <ListChoiceRow
          key={option.value}
          label={option.label}
          selected={language === option.value}
          separated={index > 0}
          disabled={props.disabled}
          onPress={() => void set(option.value)}
        />
      ))}
    </SettingsSection>
  );
}
