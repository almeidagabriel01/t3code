import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListRow } from "../../components/ui/ListRow";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import {
  usageAlertMenuActions,
  usageAlertPatch,
  usageAlertSections,
  usageAlertValueLabel,
} from "./SettingsUsageAlertsRouteScreen.logic";

export function SettingsUsageAlertsRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const targets = selectedTargets.filter(
    (target) => target.serverConfig.environment.capabilities.usageLimitAlerts === true,
  );
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Limit alerts" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {targets.length === 0 ? (
          <Text className="text-foreground-muted">Select a connected environment.</Text>
        ) : (
          targets.map((environment) => (
            <EnvironmentAlerts
              key={environment.environmentId}
              environment={environment}
              showEnvironment={targets.length > 1}
            />
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function EnvironmentAlerts(props: {
  readonly environment: SettingsTarget;
  readonly showEnvironment: boolean;
}) {
  const environmentId: EnvironmentId = props.environment.environmentId;
  const navigation = useNavigation();
  const providers = useAtomValue(environmentPresentations.providersByEnvironmentAtom).get(
    environmentId,
  );
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "usage limit alert update",
    reportFailure: true,
  });
  const sections = usageAlertSections(providers ?? [], settings?.usageLimitAlerts);
  const suffix = props.showEnvironment ? ` · ${props.environment.label}` : "";
  return (
    <>
      {sections.length === 0 ? (
        <Text className="text-foreground-muted">{`No subscription limits reported yet.${suffix}`}</Text>
      ) : (
        sections.map((section) => (
          <SettingsSection key={section.instanceId} title={`${section.title}${suffix}`}>
            {section.rows.map((row, index) => (
              <View
                key={row.windowId}
                className={index > 0 ? "border-t border-border-subtle" : undefined}
              >
                <Menu
                  // Android keeps a mounted menu's old items, so the key carries the chosen value.
                  key={`${row.windowId}:${row.threshold}`}
                  title={row.label}
                  actions={usageAlertMenuActions(row.threshold)}
                  onPressAction={({ nativeEvent }) => {
                    const patch = usageAlertPatch({
                      instanceId: section.instanceId,
                      windowId: row.windowId,
                      choiceId: nativeEvent.event,
                      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    });
                    if (!allowed || patch === null) return;
                    void update({ environmentId, input: { patch } });
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${row.label}, ${usageAlertValueLabel(row.threshold)}`}
                    accessibilityState={{ disabled: !allowed }}
                    disabled={!allowed}
                    className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
                  >
                    <View className="min-w-0 flex-1">
                      <Text textRole="body" className="text-foreground">
                        {row.label}
                      </Text>
                      <Text textRole="footnote" className="text-foreground-muted">
                        Your assistant tells you once, in the app and on Telegram, when this much is
                        left.
                      </Text>
                    </View>
                    <Text textRole="footnote" className="tabular-nums text-foreground-muted">
                      {usageAlertValueLabel(row.threshold)}
                    </Text>
                  </Pressable>
                </Menu>
              </View>
            ))}
          </SettingsSection>
        ))
      )}
      {sections.length > 0 && settings?.autonomy.enabled === false ? (
        <View className="overflow-hidden rounded-2xl">
          <ListRow
            icon="bell.badge"
            label="Assistant notifications are paused"
            description="Turn on Autonomy in Assistants settings to receive these alerts."
            onPress={() => navigation.navigate("SettingsAssistants")}
          />
        </View>
      ) : null}
    </>
  );
}
