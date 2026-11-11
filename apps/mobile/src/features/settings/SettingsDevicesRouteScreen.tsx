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
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
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
  return (
    <View className="gap-5">
      {devices.map((device) => {
        const policy = deviceAccessPolicy(state.access, device);
        const host = state.hosts.find((candidate) => candidate.id === device.hostId);
        const save = (next: DeviceAccessPolicy | null) =>
          void setAccess({
            environmentId,
            input: { hostId: device.hostId, deviceId: device.id, policy: next },
          });
        return (
          <ListSection
            key={`${device.hostId}:${device.id}`}
            title={`${device.name}${device.physical ? " · Physical" : ""}${suffix}`}
            footer={`${host?.label ?? "Device host"} · ${device.version}${device.connection ? ` · ${DEVICE_CONNECTION_LABELS[device.connection]}` : ""}`}
          >
            {POLICIES.map((option, index) => (
              <ListChoiceRow
                key={option}
                label={DEVICE_ACCESS_POLICY_LABELS[option].label}
                description={DEVICE_ACCESS_POLICY_LABELS[option].description}
                selected={policy === option}
                separated={index > 0}
                disabled={!canEdit}
                onPress={() => save(option)}
              />
            ))}
            {storedDeviceAccessPolicy(state.access, device) !== undefined ? (
              <SettingsActionRow
                icon="arrow.counterclockwise"
                label={`Reset ${device.name} to default`}
                disabled={!canEdit}
                onPress={() => save(null)}
              />
            ) : null}
            {findDeviceHold(state.holds, device) ? (
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
            ) : null}
            {device.connection === "wifi" ? (
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
            ) : null}
          </ListSection>
        );
      })}
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
