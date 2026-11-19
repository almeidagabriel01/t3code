import { View } from "react-native";

import { ListChoiceRow as SettingsChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { SettingsSection } from "../../components/SettingsSection";
import { APPEARANCE_COPY } from "../appearanceCopy";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

export function AndroidNavigationAppearanceSection() {
  const { isReady, androidNavigationStyle, setAndroidNavigationStyle } = useAppearancePreferences();
  return (
    <SettingsSection title={APPEARANCE_COPY.androidNavigation.title}>
      <View accessibilityRole="radiogroup">
        <SettingsChoiceRow
          label={APPEARANCE_COPY.androidNavigation.oneUi.title}
          description={APPEARANCE_COPY.androidNavigation.oneUi.description}
          disabled={!isReady}
          selected={androidNavigationStyle === "one-ui"}
          onPress={() => setAndroidNavigationStyle("one-ui")}
        />
        <SettingsChoiceRow
          label={APPEARANCE_COPY.androidNavigation.material.title}
          description={APPEARANCE_COPY.androidNavigation.material.description}
          disabled={!isReady}
          selected={androidNavigationStyle === "material"}
          onPress={() => setAndroidNavigationStyle("material")}
          separated
        />
      </View>
    </SettingsSection>
  );
}
