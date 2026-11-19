import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../../../components/ui/AppText";
import { ListChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { APPEARANCE_COPY, TOOL_CALL_VISIBILITY_OPTIONS } from "../appearanceCopy";
import { SettingsSection } from "../../components/SettingsSection";

export function ToolCallsAppearanceSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const selected = AsyncResult.isSuccess(preferences)
    ? (preferences.value.toolCallVisibility ?? "showAll")
    : null;

  return (
    <View className="gap-3">
      <SettingsSection title={APPEARANCE_COPY.toolCalls.title}>
        {TOOL_CALL_VISIBILITY_OPTIONS.map((option, index) => (
          <ListChoiceRow
            key={option.value}
            label={option.label}
            selected={selected === option.value}
            separated={index > 0}
            disabled={selected === null}
            onPress={() => savePreferences({ toolCallVisibility: option.value })}
          />
        ))}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">{APPEARANCE_COPY.toolCalls.footer}</Text>
    </View>
  );
}
