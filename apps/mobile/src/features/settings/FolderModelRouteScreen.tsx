import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

export type FolderModelParams = { readonly environmentId: EnvironmentId };

/** Names the folder for a new rule, then hands over to the model picker. */
export function FolderModelRouteScreen({ route }: StaticScreenProps<FolderModelParams>) {
  const navigation = useNavigation();
  const [folder, setFolder] = useState("");
  const trimmed = folder.trim();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Add folder">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="gap-2">
          <Text textRole="footnote" className="px-2 font-t3-medium text-foreground">
            Folder
          </Text>
          <View className="overflow-hidden rounded-2xl bg-grouped-card px-4 py-3">
            <AppTextInput
              accessibilityLabel="Folder"
              value={folder}
              onChangeText={setFolder}
              placeholder="~/projects/work"
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-8 font-sans text-base text-foreground"
            />
          </View>
          <Text textRole="footnote" className="px-2 text-foreground-muted">
            Projects inside this folder use the model you choose next.
          </Text>
        </View>
        <SettingsSection>
          <SettingsRow
            icon="cube"
            label="Choose model"
            disabled={trimmed === ""}
            onPress={() =>
              navigation.navigate("SettingsFolderModelPicker", {
                environmentId: route.params.environmentId,
                folder: trimmed,
              })
            }
          />
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
