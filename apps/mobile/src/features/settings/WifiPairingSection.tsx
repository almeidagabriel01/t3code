import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { WIFI_PAIRING_PHONE_STEPS, wifiPairingView } from "@t3tools/client-runtime/state/device";
import {
  type DeviceServiceState,
  type EnvironmentId,
  LOCAL_DEVICE_HOST_ID,
} from "@t3tools/contracts";
import { qrCodePath } from "@t3tools/shared/qrCodePath";
import { useRef, useState } from "react";
import { View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { uuidv4 } from "../../lib/uuid";
import { deviceEnvironment } from "../../state/device";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";

function PairingCode(props: { readonly value: string }) {
  const { size, path } = qrCodePath(props.value, "M", 2);
  return (
    // A white tile keeps the code readable for the phone's camera in every theme.
    <View className="self-center rounded-xl bg-white p-2">
      <Svg
        width={196}
        height={196}
        viewBox={`0 0 ${size} ${size}`}
        accessibilityLabel="Wi-Fi pairing code"
      >
        <Rect width={size} height={size} fill="#fff" />
        <Path d={path} fill="#000" />
      </Svg>
    </View>
  );
}

/** Pair an Android phone with this environment's device host by QR code. */
export function WifiPairingSection(props: {
  readonly environmentId: EnvironmentId;
  readonly state: DeviceServiceState;
  readonly suffix: string;
}) {
  const { environmentId, state } = props;
  const canPair = useAtomValue(deviceEnvironment.wifiPairStart.permissionAtom(environmentId));
  const start = useAtomCommand(deviceEnvironment.wifiPairStart, { reportFailure: false });
  const cancel = useAtomCommand(deviceEnvironment.wifiPairCancel);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState<{
    attemptId: string;
    qrPayload: string;
    revision: number;
  } | null>(null);
  // Closing before the start answers must still release the environment's one attempt.
  const closed = useRef(false);
  const [startError, setStartError] = useState<string | null>(null);
  if (state.supportsWifiPairing !== true) return null;

  const hostLabel =
    state.hosts.find((host) => host.id === LOCAL_DEVICE_HOST_ID)?.label ?? "this environment";
  const view = wifiPairingView({ state, attempt, startError });
  const dismiss = (attemptId: string | undefined) =>
    attemptId ? cancel({ environmentId, input: { attemptId } }) : Promise.resolve();
  const begin = async () => {
    setAttempt(null);
    setStartError(null);
    setOpen(true);
    closed.current = false;
    const result = await start({ environmentId, input: { requestId: uuidv4() } });
    if (result._tag === "Success") {
      if (closed.current) void dismiss(result.value.attemptId);
      else
        setAttempt({
          attemptId: result.value.attemptId,
          qrPayload: result.value.qrPayload,
          revision: result.value.state.revision,
        });
      return;
    }
    const failure = squashAtomCommandFailure(result);
    setStartError(
      typeof failure === "object" &&
        failure !== null &&
        "_tag" in failure &&
        failure._tag === "DeviceWifiPairingBusyError"
        ? "busy"
        : failure instanceof Error
          ? failure.message
          : "Could not start pairing.",
    );
  };
  // Closing stops a running attempt and clears a finished one for every client.
  const close = () => {
    setOpen(false);
    closed.current = true;
    void dismiss(attempt?.attemptId);
  };

  const title = `Phone over Wi-Fi${props.suffix}`;
  if (!open) {
    return (
      <ListSection
        title={title}
        footer={`Pair an Android phone on the same Wi-Fi network as ${hostLabel}.`}
      >
        <SettingsActionRow
          icon="wifi"
          label="Connect a phone over Wi-Fi"
          disabled={!canPair}
          onPress={() => void begin()}
        />
      </ListSection>
    );
  }
  return (
    <ListSection title={title}>
      <View className="gap-4 p-4">
        {view.kind === "waiting" || view.kind === "pairing" || view.kind === "connecting" ? (
          <>
            <Text textRole="footnote" className="text-foreground-muted">
              {`Scan this code with the Android phone you want to connect. It must be on the same Wi-Fi network as ${hostLabel}. To connect the phone you are holding, open this screen on another device.`}
            </Text>
            <PairingCode value={view.qrPayload} />
            <View className="gap-2">
              {WIFI_PAIRING_PHONE_STEPS.map((step, index) => (
                <Text key={step} className="text-sm">{`${index + 1}. ${step}`}</Text>
              ))}
            </View>
          </>
        ) : null}
        <ListRowLayout
          icon={
            view.kind === "connected"
              ? "checkmark.circle"
              : view.kind === "failed" || view.kind === "elsewhere"
                ? "exclamationmark.triangle"
                : "wifi"
          }
          label={
            view.kind === "starting"
              ? "Preparing a pairing code…"
              : view.kind === "elsewhere"
                ? "Another device is pairing a phone. Cancel that attempt to start one here."
                : view.label
          }
          description={view.kind === "failed" ? view.detail : undefined}
        />
        <View className="flex-row flex-wrap justify-end gap-2">
          {view.kind === "connected" ? (
            <Button label="Done" tone="primary" size="compact" onPress={close} />
          ) : view.kind === "failed" ? (
            <>
              <Button label="Close" size="compact" onPress={close} />
              <Button
                label="Try again"
                tone="primary"
                size="compact"
                onPress={() => void dismiss(attempt?.attemptId).then(begin)}
              />
            </>
          ) : view.kind === "elsewhere" ? (
            <>
              <Button label="Close" size="compact" onPress={close} />
              <Button
                label="Cancel that attempt"
                tone="primary"
                size="compact"
                onPress={() => void dismiss(view.attemptId).then(begin)}
              />
            </>
          ) : (
            <Button label="Cancel" size="compact" onPress={close} />
          )}
        </View>
      </View>
    </ListSection>
  );
}
