import { useAtomValue } from "@effect/atom-react";
import {
  DEVICE_ACCESS_POLICY_LABELS,
  DEVICE_CONNECTION_LABELS,
  deviceAccessPolicy,
  findDeviceHold,
  storedDeviceAccessPolicy,
  type DeviceAccessPolicy,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import {
  deviceEnvironment,
  deviceHostProbeAtom,
  useDeviceEnvironmentIds,
} from "../../state/device";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { WifiPairingSection } from "./WifiPairingSection";

const POLICIES = ["allow", "ask", "deny"] as const;

function DeviceEnvironment(props: {
  readonly environmentId: EnvironmentId;
  readonly title?: string;
}) {
  const { environmentId } = props;
  const query = useEnvironmentQuery(deviceEnvironment.state({ environmentId, input: {} }));
  const canEdit = useAtomValue(deviceEnvironment.setAccess.permissionAtom(environmentId));
  const canHold = useAtomValue(deviceEnvironment.setHold.permissionAtom(environmentId));
  const setAccess = useAtomCommand(deviceEnvironment.setAccess);
  const setHold = useAtomCommand(deviceEnvironment.setHold);
  const canForget = useAtomValue(deviceEnvironment.forget.permissionAtom(environmentId));
  const forget = useAtomCommand(deviceEnvironment.forget);
  const probing = AsyncResult.isInitial(useAtomValue(deviceHostProbeAtom(environmentId)));
  const state = query.data;
  const suffix = props.title ? ` · ${props.title}` : "";
  if (state === null) {
    return (
      <ListSection title={`Device access${suffix}`}>
        <ListRowLayout
          icon="arrow.clockwise"
          label={query.error === null ? "Finding devices..." : "Could not load the devices"}
          description={query.error ?? undefined}
        />
      </ListSection>
    );
  }
  const pairing = (
    <WifiPairingSection environmentId={environmentId} state={state} suffix={suffix} />
  );
  if (state.supportsDeviceControl !== true || state.devices.length === 0) {
    return (
      <View className="gap-5">
        <ListSection title={`Device access${suffix}`}>
          <ListRowLayout
            icon="iphone"
            label={
              state.supportsDeviceControl === true
                ? probing
                  ? "Finding devices..."
                  : "No devices found"
                : "Update T3 Code on this environment to set device access"
            }
          />
        </ListSection>
        {pairing}
      </View>
    );
  }
  const devices = [...state.devices].sort(
    (a, b) => Number(b.physical) - Number(a.physical) || a.name.localeCompare(b.name),
  );
  const describe = (device: (typeof devices)[number]) => {
    const host = state.hosts.find((candidate) => candidate.id === device.hostId);
    return [
      host?.label ?? "Device host",
      device.version,
      device.physical ? "Physical" : null,
      device.connection ? DEVICE_CONNECTION_LABELS[device.connection] : null,
      findDeviceHold(state.holds, device) ? "In your control" : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  return (
    <View className="gap-5">
      <ListSection title={`Device access${suffix}`}>
        {devices.map((device, index) => {
          const policy = deviceAccessPolicy(state.access, device);
          const stored = storedDeviceAccessPolicy(state.access, device) !== undefined;
          const save = (next: DeviceAccessPolicy | null) =>
            void setAccess({
              environmentId,
              input: { hostId: device.hostId, deviceId: device.id, policy: next },
            });
          return (
            <View
              key={`${device.hostId}:${device.id}`}
              className={index > 0 ? "border-t border-border-subtle" : undefined}
            >
              <Menu
                title={`Agents and ${device.name}`}
                actions={[
                  ...POLICIES.map((option) => ({
                    id: option,
                    title: DEVICE_ACCESS_POLICY_LABELS[option].label,
                    subtitle: DEVICE_ACCESS_POLICY_LABELS[option].description,
                    state: policy === option ? ("on" as const) : ("off" as const),
                    attributes: { disabled: !canEdit },
                  })),
                  ...(stored
                    ? [
                        {
                          id: "reset",
                          title: "Reset to default",
                          attributes: { disabled: !canEdit },
                        },
                      ]
                    : []),
                ]}
                onPressAction={({ nativeEvent }) => {
                  if (!canEdit) return;
                  if (nativeEvent.event === "reset") save(null);
                  const option = POLICIES.find((candidate) => candidate === nativeEvent.event);
                  if (option) save(option);
                }}
              >
                <ListRowLayout
                  icon="iphone"
                  label={device.name}
                  description={describe(device)}
                  detail={DEVICE_ACCESS_POLICY_LABELS[policy].label}
                  disabled={!canEdit}
                />
              </Menu>
              {findDeviceHold(state.holds, device) ? (
                <View className="border-t border-border-subtle">
                  <SettingsActionRow
                    icon="arrow.uturn.backward"
                    label={`Hand ${device.name} back to the agent`}
                    disabled={!canHold}
                    onPress={() =>
                      void setHold({
                        environmentId,
                        input: { hostId: device.hostId, deviceId: device.id, held: false },
                      })
                    }
                  />
                </View>
              ) : null}
              {device.connection === "wifi" ? (
                <View className="border-t border-border-subtle">
                  <SettingsActionRow
                    icon="wifi.slash"
                    label={`Forget ${device.name}`}
                    disabled={!canForget}
                    onPress={() =>
                      void forget({
                        environmentId,
                        input: { hostId: device.hostId, deviceId: device.id },
                      })
                    }
                  />
                </View>
              ) : null}
            </View>
          );
        })}
      </ListSection>
      {pairing}
    </View>
  );
}

export function SettingsDevicesRouteScreen() {
  const environmentIds = useDeviceEnvironmentIds();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Devices">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text textRole="footnote" className="px-4 text-foreground-muted">
          Choose which simulators, emulators and physical devices agents may use. Simulators and
          emulators are allowed by default; a physical device asks first.
        </Text>
        {environmentIds.length === 0 ? (
          <EmptyState
            variant="plain"
            title="Devices are not available"
            detail="Turn on device support in an environment's settings on the web or desktop app."
          />
        ) : (
          environmentIds.map((environmentId) => (
            <DeviceEnvironment
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
