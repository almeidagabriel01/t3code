import { useAtomValue } from "@effect/atom-react";
import {
  MAC_PERMISSION_ROWS,
  macPermissionStatusLabel,
} from "@t3tools/client-runtime/state/mac-permissions";
import type { EnvironmentId, MacPermissionPane } from "@t3tools/contracts";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useMacEnvironmentIds } from "../../state/macPermissions";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsScreen } from "./components/SettingsScreen";

const PANE_ICONS: Record<MacPermissionPane, AppSymbolName> = {
  "screen-recording": "desktopcomputer",
  accessibility: "eye",
  automation: "gearshape",
};

function MacEnvironment(props: { readonly environmentId: EnvironmentId; readonly title?: string }) {
  const { environmentId } = props;
  const query = useEnvironmentQuery(serverEnvironment.macPermissions({ environmentId, input: {} }));
  const canOpen = useAtomValue(serverEnvironment.openMacSettings.permissionAtom(environmentId));
  const openSettings = useAtomCommand(serverEnvironment.openMacSettings);
  const permissions = query.data;
  const suffix = props.title ? ` · ${props.title}` : "";
  return (
    <View className="gap-5">
      <ListSection title={`Permissions${suffix}`}>
        {permissions === null ? (
          <ListRowLayout
            icon="arrow.clockwise"
            label={query.error === null ? "Checking..." : "Could not check the permissions"}
            description={query.error ?? undefined}
          />
        ) : (
          MAC_PERMISSION_ROWS.map((row) => (
            <ListRowLayout
              key={row.key}
              icon={PANE_ICONS[row.pane]}
              label={row.label}
              description={row.description}
              detail={macPermissionStatusLabel(permissions[row.key])}
            />
          ))
        )}
        <SettingsActionRow
          icon="arrow.clockwise"
          label="Check again"
          disabled={query.isPending}
          onPress={query.refresh}
        />
      </ListSection>
      <ListSection title={`Open on the Mac${suffix}`}>
        {MAC_PERMISSION_ROWS.map((row) => (
          <SettingsActionRow
            key={row.pane}
            icon={PANE_ICONS[row.pane]}
            label={`Open ${row.label} settings`}
            disabled={!canOpen}
            onPress={() => void openSettings({ environmentId, input: { pane: row.pane } })}
          />
        ))}
      </ListSection>
    </View>
  );
}

export function SettingsMacPermissionsRouteScreen() {
  const environmentIds = useMacEnvironmentIds();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Mac permissions">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text textRole="footnote" className="px-4 text-foreground-muted">
          What macOS lets T3 Code do on the Mac that runs it. Agents can take screenshots, and click
          or type only after you approve each action. Grant the permissions in System Settings on
          that Mac.
        </Text>
        {environmentIds.length === 0 ? (
          <EmptyState
            variant="plain"
            title="Mac permissions are not available"
            detail="Connect an environment whose server runs on a Mac."
          />
        ) : (
          environmentIds.map((environmentId) => (
            <MacEnvironment
              key={environmentId}
              environmentId={environmentId}
              title={
                environmentIds.length > 1
                  ? savedConnectionsById[environmentId]?.environmentLabel
                  : undefined
              }
            />
          ))
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
