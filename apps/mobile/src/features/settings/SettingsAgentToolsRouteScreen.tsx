import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { GlobalSkillsSection } from "./components/GlobalSkillsSection";
import { McpServersSection } from "./components/McpServersSection";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

/** Global MCP servers and skills: what every provider session on an environment gets. */
export function SettingsAgentToolsRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { availableTargets, selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="MCP servers & skills" menus={[environmentMenu]}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length > 0 ? (
          selectedTargets.map((target) => (
            <View key={target.environmentId} className="gap-5">
              <McpServersSection
                environmentId={target.environmentId}
                title={selectedTargets.length > 1 ? target.label : undefined}
              />
              <GlobalSkillsSection
                environmentId={target.environmentId}
                title={selectedTargets.length > 1 ? target.label : undefined}
              />
            </View>
          ))
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            {availableTargets.length === 0
              ? "Connect an environment to manage its MCP servers and skills."
              : "No environments match this filter. Change the filter above."}
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
