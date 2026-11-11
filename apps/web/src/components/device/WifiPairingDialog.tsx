import { useAtomValue } from "@effect/atom-react";
import { WIFI_PAIRING_PHONE_STEPS, wifiPairingView } from "@t3tools/client-runtime/state/device";
import {
  DEVICE_CONNECTION_LABELS,
  type DeviceServiceState,
  type DeviceSummary,
  type EnvironmentId,
  LOCAL_DEVICE_HOST_ID,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { CircleAlert, CircleCheck, Wifi, WifiOff } from "lucide-react";
import { useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { QRCodeSvg } from "~/components/ui/qr-code";
import { Spinner } from "~/components/ui/spinner";
import { deviceEnvironment } from "~/state/device";
import { randomUUID } from "~/lib/utils";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

const isBusy = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "DeviceWifiPairingBusyError"
  );
};

/** "Connect a phone over Wi-Fi": opens the pairing dialog and starts an attempt. */
export function WifiPairingButton(props: {
  readonly environmentId: EnvironmentId;
  readonly state: DeviceServiceState;
  readonly className?: string;
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

  const view = wifiPairingView({ state, attempt, startError });
  const hostLabel =
    state.hosts.find((host) => host.id === LOCAL_DEVICE_HOST_ID)?.label ?? "this environment";
  const dismiss = (attemptId: string | undefined) =>
    attemptId ? cancel({ environmentId, input: { attemptId } }) : Promise.resolve();

  const begin = async () => {
    setAttempt(null);
    setStartError(null);
    setOpen(true);
    closed.current = false;
    const result = await start({ environmentId, input: { requestId: randomUUID() } });
    if (result._tag === "Failure")
      setStartError(isBusy(result.cause) ? "busy" : formatEnvironmentQueryError(result.cause));
    else if (closed.current) void dismiss(result.value.attemptId);
    else
      setAttempt({
        attemptId: result.value.attemptId,
        qrPayload: result.value.qrPayload,
        revision: result.value.state.revision,
      });
  };
  // Closing stops a running attempt and clears a finished one for every client.
  const close = () => {
    setOpen(false);
    closed.current = true;
    void dismiss(attempt?.attemptId);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <Button
        className={props.className}
        variant="outline"
        size="sm"
        disabled={!canPair}
        onClick={() => void begin()}
      >
        <Wifi />
        Connect a phone over Wi-Fi
      </Button>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect a phone over Wi-Fi</DialogTitle>
          <DialogDescription>
            {`Android 11 or later. The phone must be on the same Wi-Fi network as ${hostLabel}.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {view.kind === "waiting" || view.kind === "pairing" || view.kind === "connecting" ? (
            <div className="flex flex-col items-center gap-5">
              <div className="rounded-xl bg-white p-2 shadow-sm">
                <QRCodeSvg
                  value={view.qrPayload}
                  size={184}
                  level="M"
                  marginSize={2}
                  title="Wi-Fi pairing code"
                />
              </div>
              <ol className="w-full space-y-2 text-sm text-foreground">
                {WIFI_PAIRING_PHONE_STEPS.map((step, index) => (
                  <li key={step} className="flex gap-3">
                    <span className="grid size-5 shrink-0 place-items-center rounded-full border border-foreground/16 text-xs text-muted-foreground">
                      {index + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              <p
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 self-start text-sm text-muted-foreground"
              >
                <Spinner size="xs" />
                {view.label}
              </p>
            </div>
          ) : view.kind === "starting" ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="xs" />
              Preparing a pairing code…
            </p>
          ) : view.kind === "elsewhere" ? (
            <Alert variant="warning" role="status">
              <CircleAlert />
              <AlertTitle>Another device is pairing a phone</AlertTitle>
              <AlertDescription>
                Only one phone can pair at a time. Cancel that attempt to start one here.
              </AlertDescription>
            </Alert>
          ) : view.kind === "connected" ? (
            <p role="status" className="flex items-center gap-2 text-sm text-foreground">
              <CircleCheck className="size-4 text-success" />
              {view.label}
            </p>
          ) : (
            <Alert variant="error" role="status">
              <CircleAlert />
              <AlertTitle>{view.label}</AlertTitle>
              {view.kind === "failed" && view.detail ? (
                <AlertDescription className="break-words">{view.detail}</AlertDescription>
              ) : null}
            </Alert>
          )}
        </DialogPanel>
        <DialogFooter>
          {view.kind === "connected" ? (
            <Button onClick={close}>Done</Button>
          ) : view.kind === "failed" ? (
            <>
              <Button variant="outline" onClick={close}>
                Close
              </Button>
              <Button onClick={() => void dismiss(attempt?.attemptId).then(begin)}>
                Try again
              </Button>
            </>
          ) : view.kind === "elsewhere" ? (
            <>
              <Button variant="outline" onClick={close}>
                Close
              </Button>
              <Button onClick={() => void dismiss(view.attemptId).then(begin)}>
                Cancel that attempt
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Disconnects a phone paired over Wi-Fi. Render it only for one (`connection: "wifi"`). */
export function ForgetWifiDeviceButton(props: {
  readonly environmentId: EnvironmentId;
  readonly device: DeviceSummary;
}) {
  const canForget = useAtomValue(deviceEnvironment.forget.permissionAtom(props.environmentId));
  const forget = useAtomCommand(deviceEnvironment.forget);
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={!canForget || pending}
      aria-label={`Forget ${props.device.name}`}
      onClick={() => {
        setPending(true);
        void forget({
          environmentId: props.environmentId,
          input: { hostId: props.device.hostId, deviceId: props.device.id },
        }).finally(() => setPending(false));
      }}
    >
      {pending ? <Spinner size="xs" /> : <WifiOff />}
      Forget
    </Button>
  );
}

/** "USB" or "Wi-Fi" for a physical Android phone, for the line under its name. */
export const deviceConnectionLabel = (device: DeviceSummary) =>
  device.connection ? ` · ${DEVICE_CONNECTION_LABELS[device.connection]}` : "";
