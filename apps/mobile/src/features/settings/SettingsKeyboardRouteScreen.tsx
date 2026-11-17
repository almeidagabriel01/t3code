import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { DEFAULT_COMPOSER_ENTER_BEHAVIOR } from "../../lib/composerEnterBehavior";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { enterBehaviorOptions, KEYBOARD_COPY } from "./keyboardCopy";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsKeyboardRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedBehavior = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.composerEnterBehavior ?? DEFAULT_COMPOSER_ENTER_BEHAVIOR)
    : null;

  return (
    <SettingsScreen title="Keyboard">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={KEYBOARD_COPY.returnKey}>
          {enterBehaviorOptions(Platform.OS === "android" ? "Ctrl" : "Command").map(
            (option, index) => (
              <SettingsChoiceRow
                key={option.behavior}
                label={option.label}
                description={option.description}
                selected={selectedBehavior === option.behavior}
                separated={index > 0}
                disabled={!preferencesReady}
                onPress={() => savePreferences({ composerEnterBehavior: option.behavior })}
              />
            ),
          )}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">{KEYBOARD_COPY.footer}</Text>
      </ScrollView>
    </SettingsScreen>
  );
}
