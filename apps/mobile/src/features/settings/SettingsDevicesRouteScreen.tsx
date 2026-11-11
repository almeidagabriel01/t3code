import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  deviceLinkedUse,
  groupDevicesBySource,
  linkedDeviceSources,
} from "@t3tools/client-runtime/state/device";
import {
  DEVICE_ACCESS_POLICY_LABELS,
  DEVICE_CONNECTION_LABELS,
  DEVICE_ISSUES,
  deviceAccessPolicy,
  findDeviceHold,
  storedDeviceAccessPolicy,
  type DeviceAccessPolicy,
  type DeviceServiceState,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import {
  deviceEnvironment,
  deviceHostProbeAtom,
  useDeviceEnvironmentIds,
} from "../../state/device";
import { useLinkedEnvironments } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { deviceIssueRows } from "../devices/threadDevicePreviews";
import { IphoneSigningSection } from "./IphoneSigningSection";
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
  const navigation = useNavigation();
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
    <>
      <IphoneSigningSection environmentId={environmentId} suffix={suffix} />
      <WifiPairingSection environmentId={environmentId} state={state} suffix={suffix} />
      {state.supportsLinkedDevices === true ? (
        <LinkedDeviceSections environmentId={environmentId} state={state} suffix={suffix} />
      ) : null}
    </>
  );
  // A linked environment's devices follow its own access settings, set there.
  const own = groupDevicesBySource(state).find((source) => source.linked === null);
  const ownDevices = own?.groups.flatMap((group) => group.devices) ?? [];
  if (state.supportsDeviceControl !== true || ownDevices.length === 0) {
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
  const devices = [...ownDevices].sort(
    (a, b) => Number(b.physical) - Number(a.physical) || a.name.localeCompare(b.name),
  );
  const describe = (device: (typeof devices)[number]) => {
    const host = state.hosts.find((candidate) => candidate.id === device.hostId);
    const hold = findDeviceHold(state.holds, device);
    return [
      host?.label ?? "Device host",
      device.version,
      device.physical && device.platform !== "desktop" ? "Physical" : null,
      device.connection ? DEVICE_CONNECTION_LABELS[device.connection] : null,
      hold?.linked ? `${hold.linked.label} is in control` : hold ? "In your control" : null,
      deviceLinkedUse(state, device),
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
          const issues = deviceIssueRows(device);
          const hold = findDeviceHold(state.holds, device);
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
                  icon={device.platform === "desktop" ? "desktopcomputer" : "iphone"}
                  label={device.name}
                  description={describe(device)}
                  detail={DEVICE_ACCESS_POLICY_LABELS[policy].label}
                  disabled={!canEdit}
                />
              </Menu>
              {issues.map((issue) => (
                <View key={issue.reason} className="border-t border-border-subtle">
                  {DEVICE_ISSUES[issue.reason].macPermission === "screen-recording" ? (
                    <ListRow
                      icon="exclamationmark.triangle"
                      label={issue.title}
                      description={issue.action}
                      onPress={() => navigation.navigate("SettingsMacPermissions")}
                    />
                  ) : (
                    <ListRowLayout
                      icon="exclamationmark.triangle"
                      label={issue.title}
                      description={issue.action}
                    />
                  )}
                </View>
              ))}
              {hold ? (
                <View className="border-t border-border-subtle">
                  <SettingsActionRow
                    icon="arrow.uturn.backward"
                    label={
                      hold.linked
                        ? `End ${hold.linked.label}'s control of ${device.name}`
                        : `Hand ${device.name} back to the agent`
                    }
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

/** Link requests and users of this environment's devices, and the linked environments' devices. */
function LinkedDeviceSections(props: {
  readonly environmentId: EnvironmentId;
  readonly state: DeviceServiceState;
  readonly suffix: string;
}) {
  const { environmentId, state, suffix } = props;
  const canAnswer = useAtomValue(deviceEnvironment.answerLinkRequest.permissionAtom(environmentId));
  const canBlock = useAtomValue(deviceEnvironment.setLinkBlocked.permissionAtom(environmentId));
  const canHide = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const answer = useAtomCommand(deviceEnvironment.answerLinkRequest);
  const setBlocked = useAtomCommand(deviceEnvironment.setLinkBlocked);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const hidden =
    useAtomValue(environmentServerConfigsAtom).get(environmentId)?.settings
      .hiddenLinkedDeviceSources ?? [];
  const links = useLinkedEnvironments(environmentId);
  const sources = linkedDeviceSources({ links, hidden, state });
  const requests = state.linkRequests ?? [];
  const clients = state.linkClients ?? [];
  return (
    <>
      {requests.length > 0 ? (
        <ListSection title={`Device requests${suffix}`}>
          {requests.map((request) => (
            <View key={request.requestId}>
              <ListRowLayout
                icon="link"
                label={`${request.linkLabel} wants ${request.deviceName}`}
                description={request.threadTitle ? `For “${request.threadTitle}”` : undefined}
              />
              {([true, false] as const).map((allow) => (
                <SettingsActionRow
                  key={String(allow)}
                  icon={allow ? "checkmark.circle" : "xmark.circle.fill"}
                  label={`${allow ? "Allow" : "Don't allow"} ${request.linkLabel} to use ${request.deviceName}`}
                  disabled={!canAnswer}
                  onPress={() =>
                    void answer({ environmentId, input: { requestId: request.requestId, allow } })
                  }
                />
              ))}
            </View>
          ))}
        </ListSection>
      ) : null}
      {clients.length > 0 ? (
        <ListSection
          title={`Linked environments using devices here${suffix}`}
          footer="A blocked environment cannot list, watch or drive any device here."
        >
          {clients.map((client) => (
            <SettingsActionRow
              key={client.linkId}
              icon={client.blocked ? "person.fill.checkmark" : "person.fill.xmark"}
              label={client.blocked ? `Let ${client.label} back in` : `Block ${client.label}`}
              disabled={!canBlock}
              onPress={() =>
                void setBlocked({
                  environmentId,
                  input: { linkId: client.linkId, label: client.label, blocked: !client.blocked },
                })
              }
            />
          ))}
        </ListSection>
      ) : null}
      {sources.map((source) => {
        const devices = source.hidden
          ? []
          : (groupDevicesBySource(state)
              .find((group) => group.linked?.environmentId === source.environmentId)
              ?.groups.flatMap((group) => group.devices) ?? []);
        return (
          <ListSection
            key={source.environmentId}
            title={`Devices on ${source.label}${suffix}`}
            footer={
              source.hidden
                ? "Hidden: its devices are not listed here or offered to agents."
                : (source.status ?? "Listed when it next answers.")
            }
          >
            {devices.map((device) => (
              <ListRowLayout
                key={device.id}
                icon={device.platform === "desktop" ? "desktopcomputer" : "iphone"}
                label={`${device.name}${device.physical ? " · Physical" : ""}`}
                description={device.version}
              />
            ))}
            <SettingsActionRow
              icon={source.hidden ? "eye" : "eye.slash"}
              label={`${source.hidden ? "Show" : "Hide"} devices from ${source.label}`}
              disabled={!canHide}
              onPress={() =>
                void update({
                  environmentId,
                  input: {
                    patch: {
                      hiddenLinkedDeviceSources: source.hidden
                        ? hidden.filter((id) => id !== source.environmentId)
                        : [...hidden, source.environmentId],
                    },
                  },
                })
              }
            />
          </ListSection>
        );
      })}
    </>
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
