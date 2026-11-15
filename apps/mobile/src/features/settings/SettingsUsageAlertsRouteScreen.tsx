import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  usageLimitAlertLabel,
  usageLimitAlertsPaused,
  USAGE_LIMIT_ALERTS_SCOPES,
} from "@t3tools/shared/usageLimitAlerts";
import {
  SCOPE_ACCESS_UNAVAILABLE_MESSAGE,
  scopeAccessLocked,
  scopeAccessShowsBanner,
} from "@t3tools/client-runtime/state/sessionScope";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScopeAccess } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import {
  usageAlertMenuActions,
  usageAlertPatch,
  usageAlertSections,
} from "./SettingsUsageAlertsRouteScreen.logic";

export function SettingsUsageAlertsRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const supported = (target: SettingsTarget) =>
    target.serverConfig.environment.capabilities.usageLimitAlerts === true;
  const targets = selectedTargets.filter(supported);
  const outdated = selectedTargets.filter((target) => !supported(target));
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Limit alerts" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">Select a connected environment.</Text>
        ) : targets.length === 0 ? (
          <EmptyState
            variant="plain"
            title={outdated.length === 1 ? "Update this server" : "Update these servers"}
            detail="Limit alerts need a newer T3 Code server."
          />
        ) : (
          <Text textRole="footnote" className="px-2 text-foreground-muted">
            Your assistant messages you once when this much is left.
          </Text>
        )}
        {targets.map((environment) => (
          <EnvironmentAlerts
            key={environment.environmentId}
            environment={environment}
            showEnvironment={targets.length > 1}
          />
        ))}
        {targets.length > 0 && outdated.length > 0 ? (
          <Text textRole="footnote" className="px-2 text-foreground-muted">
            {`${outdated.map((target) => target.label).join(", ")} ${outdated.length === 1 ? "needs a server update" : "need server updates"} to use limit alerts.`}
          </Text>
        ) : null}
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
  const access = useEnvironmentScopeAccess(environmentId, USAGE_LIMIT_ALERTS_SCOPES);
  const allowed = !scopeAccessLocked(access);
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "usage limit alert update",
    reportFailure: true,
  });
  const sections = usageAlertSections(providers ?? [], settings?.usageLimitAlerts.instances);
  const paused =
    settings !== null &&
    usageLimitAlertsPaused({
      autonomyEnabled: settings.autonomy.enabled,
      alerts: settings.usageLimitAlerts,
      providers: providers ?? [],
    });
  const suffix = props.showEnvironment ? ` · ${props.environment.label}` : "";
  return (
    <>
      {scopeAccessShowsBanner(access) ? (
        <View className="overflow-hidden rounded-2xl bg-grouped-card">
          <ListRowLayout
            icon={{ ios: "lock", android: "lock" }}
            label="Limited permissions"
            description={`This session can view ${props.environment.label}'s providers but can't change their settings.`}
          />
        </View>
      ) : access === "unavailable" ? (
        <Text className="px-2 text-sm text-foreground-muted">
          {SCOPE_ACCESS_UNAVAILABLE_MESSAGE}
        </Text>
      ) : null}
      {paused ? (
        <View className="overflow-hidden rounded-2xl">
          <ListRow
            icon="bell.badge"
            label="Alerts are paused"
            description="Assistant notifications are off, so limit alerts wait. Change it in Assistants."
            onPress={() => navigation.navigate("SettingsAssistants")}
          />
        </View>
      ) : null}
      {sections.length === 0 ? (
        <Text className="text-foreground-muted">{`No subscription limits reported yet.${suffix}`}</Text>
      ) : (
        sections.map((section) => (
          <SettingsSection key={section.instanceId} title={`${section.title}${suffix}`}>
            {section.rows.map((row, index) => {
              const value = usageLimitAlertLabel(row.threshold);
              const content = (
                <RowPressable
                  accessibilityRole="button"
                  accessibilityLabel={`${row.label}, ${value}`}
                  accessibilityState={{ disabled: !allowed }}
                  disabled={!allowed}
                  className="active:opacity-70"
                >
                  <ListRowLayout
                    label={row.label}
                    detail={value}
                    disabled={!allowed}
                    accessory={
                      <SymbolView
                        name="chevron.down"
                        size={14}
                        tintColorClassName="accent-chevron"
                        type="monochrome"
                      />
                    }
                  />
                </RowPressable>
              );
              return (
                <View
                  key={row.windowId}
                  className={index > 0 ? "border-t border-border-subtle" : undefined}
                >
                  {allowed ? (
                    <Menu
                      // Android keeps a mounted menu's old items, so the key carries the chosen value.
                      key={`${row.windowId}:${row.threshold}`}
                      title={row.label}
                      actions={usageAlertMenuActions(row.threshold)}
                      onPressAction={({ nativeEvent }) => {
                        const patch = usageAlertPatch({
                          instanceId: section.instanceId,
                          driver: section.driver,
                          windowId: row.windowId,
                          choiceId: nativeEvent.event,
                          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                        });
                        if (patch !== null) void update({ environmentId, input: { patch } });
                      }}
                    >
                      {content}
                    </Menu>
                  ) : (
                    content
                  )}
                </View>
              );
            })}
          </SettingsSection>
        ))
      )}
    </>
  );
}
