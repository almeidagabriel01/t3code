import { DeviceHostUpdates } from "./DeviceHostUpdates";
import {
  DEVICE_KIND_LABELS,
  deviceLinkedUse,
  groupDevicesBySource,
  LINKED_DEVICE_STATE_LABELS,
  type DeviceSourceGroup,
} from "@t3tools/client-runtime/state/device";
import {
  findDeviceHold,
  type DevicePlatform,
  type DeviceSummary,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ArrowUpRight, CircleAlert, Link2, Play, Smartphone, Undo2, X } from "lucide-react";
import { useAtomMount } from "@effect/atom-react";
import { type ReactNode, useState } from "react";

import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DiscoveryList } from "~/components/ui/discovery-list";
import { Dialog } from "~/components/ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { WizardPopup } from "~/components/ui/wizard";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { focusPanelTerminalAfterClose } from "~/lib/terminalFocus";
import {
  deviceEnvironment,
  deviceHostProbeAtom,
  NO_DEVICE_PROBE_ATOM,
  useDeviceState,
} from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { DeviceHoldBar, useDeviceHold } from "./DeviceHoldBar";
import { DeviceLinkRequests } from "./DeviceLinkRequests";
import { DeviceLoadingView } from "./DeviceLoadingView";
import {
  DeviceSetup,
  deviceHubReadiness,
  incompleteListings,
  isAndroidDiscoveryUncertain,
} from "./DeviceSetup";
import { DeviceWorkspace } from "./DeviceWorkspace";
import {
  deviceConnectionLabel,
  ForgetWifiDeviceButton,
  WifiPairingButton,
} from "./WifiPairingDialog";
import { PreviewPanelShell, type PreviewPanelMode } from "../preview/PreviewPanelShell";

const deviceKey = (device: Pick<DeviceSummary, "hostId" | "id">) =>
  `${device.hostId}\u0000${device.id}`;

export function DevicePanel(props: {
  readonly mode: PreviewPanelMode;
  readonly threadRef: ScopedThreadRef;
  readonly surface: Extract<RightPanelSurface, { kind: "device" }>;
  readonly visible: boolean;
  readonly onDismissSetup: () => void;
}) {
  const { environmentId, threadId } = props.threadRef;
  const { state, loaded, error: stateError, refresh: refreshState } = useDeviceState(environmentId);
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const open = useAtomCommand(deviceEnvironment.open);
  const close = useAtomCommand(deviceEnvironment.close);
  const { canHold, changeHold } = useDeviceHold(environmentId);
  // The panel stays mounted across thread switches, so an in-flight open or
  // power-off is tagged with the thread it belongs to and only shown there.
  const scope = `${environmentId}\u0000${threadId}`;
  const [operation, setOperation] = useState<{
    readonly scope: string;
    readonly pending: DeviceSummary | null;
    readonly error: string | null;
  } | null>(null);
  const pendingDevice = operation?.scope === scope ? operation.pending : null;
  const operationError = operation?.scope === scope ? operation.error : null;
  const pendingDeviceKey = pendingDevice ? deviceKey(pendingDevice) : null;

  const hostDisabled = state.hostStatus === "disabled";

  useAtomMount(
    props.visible && loaded && !hostDisabled
      ? deviceHostProbeAtom(environmentId)
      : NO_DEVICE_PROBE_ATOM,
  );

  const sessions = state.sessions.filter((session) => session.threadId === threadId);
  const activeSession = props.surface.target
    ? sessions.find(
        (session) =>
          session.deviceId === props.surface.target?.deviceId &&
          session.hostId === props.surface.target.hostId,
      )
    : undefined;
  const activeDevice = activeSession
    ? state.devices.find(
        (device) => device.hostId === activeSession.hostId && device.id === activeSession.deviceId,
      )
    : undefined;
  const activeHost = activeDevice
    ? state.hosts.find((host) => host.id === activeDevice.hostId)
    : undefined;

  const sources = groupDevicesBySource(state);
  const ownDevices = sources
    .find((source) => source.linked === null)
    ?.groups.flatMap((group) => group.devices);

  const startOperation = (pending: DeviceSummary | null) => {
    const started = { scope, pending, error: null };
    setOperation(started);
    // Returning to the same thread can start a newer operation before this one settles.
    return (error: string | null) =>
      setOperation((current) =>
        current === started ? { ...started, pending: null, error } : current,
      );
  };

  const selectDevice = async (value: string) => {
    const device = state.devices.find((candidate) => deviceKey(candidate) === value);
    if (!device) return;
    const settleOperation = startOperation(device);
    const result = await open({
      environmentId,
      input: {
        threadId,
        hostId: device.hostId,
        deviceId: device.id,
        platform: device.platform,
      },
    });
    if (result._tag === "Failure") settleOperation(formatEnvironmentQueryError(result.cause));
    else {
      // The server opened the device for the starting thread, so its tab opens there.
      useRightPanelStore.getState().openDevice(props.threadRef, {
        hostId: result.value.hostId,
        deviceId: result.value.deviceId,
        platform: device.platform,
        name: device.name,
      });
      settleOperation(null);
    }
  };

  const floatActive = () => {
    if (!activeDevice) return;
    usePreviewMiniPlayerStore.getState().open(props.threadRef, {
      kind: "device",
      hostId: activeDevice.hostId,
      deviceId: activeDevice.id,
      platform: activeDevice.platform,
      name: activeDevice.name,
    });
    useRightPanelStore.getState().close(props.threadRef);
  };

  const closeSurface = () => {
    const store = useRightPanelStore.getState();
    const { activeSurfaceId } = selectThreadRightPanelState(store.byThreadKey, props.threadRef);
    store.closeSurface(props.threadRef, props.surface.id);
    focusPanelTerminalAfterClose(props.threadRef, activeSurfaceId);
  };

  const closeActive = (powerOff: boolean) => {
    if (!powerOff) {
      closeSurface();
      return;
    }
    if (!activeSession) return;
    const settleOperation = startOperation(null);
    void close({
      environmentId,
      input: {
        threadId,
        hostId: activeSession.hostId,
        deviceId: activeSession.deviceId,
        shutdown: powerOff,
      },
    }).then((result) => {
      if (result._tag === "Failure") settleOperation(formatEnvironmentQueryError(result.cause));
      else closeSurface();
    });
  };

  const bootingDevices =
    state.bootingDevices?.filter((device) => device.threadId === threadId) ?? [];
  const { ready: hostReady, busy: hostBusy } = deviceHubReadiness(state);
  const loading = !activeDevice && (pendingDevice !== null || hostBusy || !loaded);
  // Without a first snapshot a failed subscription never settles on its own.
  const loadError = loaded ? null : stateError;
  const diagnostics = state.hosts.flatMap((host) => {
    const status = state.hostStatuses[host.id];
    const detail = status?.detail ?? (host.kind === "local" ? state.hostStatusDetail : undefined);
    return detail && (status?.status ?? state.hostStatus) === "ready"
      ? [
          {
            hostId: host.id,
            label: host.label,
            detail,
            incompletePlatforms: incompleteListings(status),
          },
        ]
      : [];
  });
  const unavailablePlatforms = state.hosts.flatMap((host) =>
    host.platforms
      .filter((platform) => !platform.available)
      .map((platform) => ({ ...platform, hostId: host.id, hostLabel: host.label })),
  );

  if (loaded && (!state.onboardingCompleted || hostDisabled)) {
    return (
      <Dialog
        open={props.visible}
        onOpenChange={(isOpen) => {
          if (!isOpen) props.onDismissSetup();
        }}
      >
        <WizardPopup>
          <DeviceSetup environmentId={environmentId} state={state} />
        </WizardPopup>
      </Dialog>
    );
  }

  return (
    <PreviewPanelShell mode={props.mode}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            "shrink-0 surface-glass",
            loading && "absolute inset-x-0 top-0 z-10 max-h-[40%] overflow-y-auto",
          )}
        >
          <div hidden={!!activeDevice}>
            {diagnostics.map((diagnostic) => (
              <DeviceDiscoveryWarning
                key={`${environmentId}\u0000${diagnostic.hostId}`}
                label={diagnostic.label}
                detail={diagnostic.detail}
                incompletePlatforms={diagnostic.incompletePlatforms}
                onRetry={() => list({ environmentId, input: {} })}
              />
            ))}
          </div>
          <DeviceHostUpdates state={state} environmentId={environmentId} />
          <DeviceLinkRequests environmentId={environmentId} state={state} />
          {bootingDevices.length > 0 ? (
            <div role="status" className="border-b px-3 py-2 text-xs text-muted-foreground">
              Starting {bootingDevices.map((device) => device.name).join(", ")}… This can take a
              minute.
            </div>
          ) : null}
          {activeDevice ? (
            <DeviceHoldBar
              environmentId={environmentId}
              state={state}
              device={activeDevice}
              className="border-b border-foreground/12"
            />
          ) : null}
          {operationError ? (
            <DeviceNotice onDismiss={() => setOperation(null)}>{operationError}</DeviceNotice>
          ) : null}
        </div>
        <div className="@container relative flex min-h-0 flex-1">
          {activeDevice && activeSession ? (
            <DeviceWorkspace
              key={`${environmentId}\u0000${deviceKey(activeDevice)}`}
              environmentId={environmentId}
              device={activeDevice}
              hostLabel={activeHost?.label ?? "Device host"}
              hostKind={activeHost?.kind}
              hostDiagnostics={
                diagnostics.find(({ hostId }) => hostId === activeDevice.hostId)?.detail
              }
              visible={props.visible}
              onFloat={floatActive}
              onClose={() => closeActive(false)}
              onPowerOff={activeDevice.physical ? undefined : () => closeActive(true)}
            />
          ) : loading ? (
            <DeviceLoadingView
              name={pendingDevice?.name ?? "Devices"}
              description={
                pendingDevice
                  ? `${state.hosts.find((host) => host.id === pendingDevice.hostId)?.label ?? "Device host"} · ${pendingDevice.version}`
                  : ""
              }
              stage="opening"
              message={
                loadError ??
                (pendingDevice
                  ? pendingDevice.booted
                    ? "Opening device…"
                    : "Starting device…"
                  : state.hostStatus === "installing"
                    ? (state.hostStatusDetail ?? "Installing device support…")
                    : "Finding devices…")
              }
              error={loadError !== null}
            >
              {loadError !== null ? (
                <Button size="sm" variant="outline" onClick={refreshState}>
                  Retry
                </Button>
              ) : null}
            </DeviceLoadingView>
          ) : (
            <div className="scrollbar-gutter-both flex size-full flex-col overflow-y-auto px-5 py-8 text-sm text-muted-foreground">
              <div
                className={cn(
                  "mx-auto flex w-full max-w-xl flex-col gap-6",
                  sources.length === 0 && "my-auto items-center text-center",
                )}
              >
                {sources.length === 0 ? (
                  <>
                    <Smartphone className="size-6 opacity-60" />
                    <p
                      className="max-h-32 w-full max-w-sm overflow-y-auto whitespace-pre-line break-words"
                      tabIndex={state.hostStatus === "failed" ? 0 : undefined}
                    >
                      {state.hostStatus === "failed"
                        ? (state.hostStatusDetail ?? "The device hub failed to start.")
                        : "No simulators, emulators or physical devices were found on this environment."}
                    </p>
                  </>
                ) : null}
                {hostReady && sources.length > 0 ? (
                  <div className="w-full space-y-6 text-left">
                    {sources.map((source) => (
                      <DeviceSource
                        key={source.key}
                        source={source}
                        renderDevice={(device) => {
                          const opens = device.booted || device.physical;
                          const held = findDeviceHold(state.holds, device);
                          const usedBy = deviceLinkedUse(state, device);
                          return (
                            <div
                              key={deviceKey(device)}
                              className="flex items-center gap-3 px-3 py-3"
                            >
                              <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60">
                                <Smartphone className="size-4" />
                              </span>
                              <div className="flex min-w-0 flex-1 flex-col">
                                <span className="flex min-w-0 items-center gap-2">
                                  <span className="truncate text-sm font-medium text-foreground">
                                    {device.name}
                                  </span>
                                  {device.physical ? (
                                    <Badge variant="outline" size="sm">
                                      Physical
                                    </Badge>
                                  ) : null}
                                </span>
                                <span className="truncate text-xs text-muted-foreground">
                                  {`${state.hosts.find((host) => host.id === device.hostId)?.label} · ${device.version}${deviceConnectionLabel(device)} · ${device.physical ? (device.booted ? "Connected" : "Not ready") : device.booted ? "Running" : "Stopped"}${held ? (held.linked ? ` · ${held.linked.label} is in control` : " · You are in control") : ""}${usedBy ? ` · ${usedBy}` : ""}`}
                                </span>
                              </div>
                              {held && !(held.linked && source.linked) ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={!canHold}
                                  aria-label={`Hand back ${device.name}`}
                                  onClick={() => changeHold(device, false)}
                                >
                                  <Undo2 />
                                  Hand back
                                </Button>
                              ) : null}
                              {device.connection === "wifi" && !source.linked ? (
                                <ForgetWifiDeviceButton
                                  environmentId={environmentId}
                                  device={device}
                                />
                              ) : null}
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={
                                  pendingDeviceKey !== null ||
                                  (source.linked !== null &&
                                    source.linked.state !== "connected" &&
                                    source.linked.state !== "needs_update")
                                }
                                aria-label={`${opens ? "Open" : "Start"} ${device.name}`}
                                onClick={() => void selectDevice(deviceKey(device))}
                              >
                                {pendingDeviceKey === deviceKey(device) ? (
                                  <Spinner size="xs" />
                                ) : opens ? (
                                  <ArrowUpRight />
                                ) : (
                                  <Play />
                                )}
                                {opens ? "Open" : "Start"}
                              </Button>
                            </div>
                          );
                        }}
                      />
                    ))}
                  </div>
                ) : null}
                {hostReady &&
                !isAndroidDiscoveryUncertain(state) &&
                !ownDevices?.some((device) => device.platform === "android") &&
                !unavailablePlatforms.some((platform) => platform.platform === "android") ? (
                  <p className="max-w-sm text-xs">
                    No Android virtual devices found. Create one in Android Studio's Device Manager,
                    then refresh.
                  </p>
                ) : null}
                {loaded && !hostBusy ? (
                  <div
                    className={cn(
                      "flex flex-wrap gap-2",
                      sources.length > 0 ? "self-start" : "self-center",
                    )}
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void list({ environmentId, input: {} })}
                    >
                      Refresh devices
                    </Button>
                    <WifiPairingButton environmentId={environmentId} state={state} />
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </PreviewPanelShell>
  );
}

function DeviceNotice(props: { readonly onDismiss: () => void; readonly children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b bg-destructive/5 px-3 py-2 text-xs text-destructive"
    >
      <CircleAlert className="mt-1 size-3.5 shrink-0" />
      <div
        className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words"
        tabIndex={0}
      >
        {props.children}
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Dismiss device error"
        onClick={props.onDismiss}
      >
        <X />
      </Button>
    </div>
  );
}

function DeviceDiscoveryWarning(props: {
  readonly label: string;
  readonly detail: string;
  readonly incompletePlatforms: readonly DevicePlatform[];
  readonly onRetry: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [dismissedCause, setDismissedCause] = useState<string | null>(null);
  const cause = `${props.incompletePlatforms.join()}\u0000${props.detail}`;
  // A dismissal hides one occurrence; a cause that returns later shows again.
  if (dismissedCause !== null && dismissedCause !== cause) setDismissedCause(null);
  if (dismissedCause === cause) return null;
  const platforms = props.incompletePlatforms.map((platform) =>
    platform === "ios" ? "iOS" : "Android",
  );
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-3 py-1 text-xs text-muted-foreground"
    >
      <span className="flex min-w-0 flex-1 basis-56 items-start gap-2">
        <CircleAlert className="mt-px size-3.5 shrink-0 text-warning-foreground" />
        <span className="min-w-0">
          {platforms.length > 0
            ? `${platforms.join(" and ")} ${platforms.length > 1 ? "lists" : "list"} on ${props.label} may be incomplete.`
            : `Device discovery on ${props.label} reported a warning.`}
        </span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        {platforms.length > 0 ? (
          <Button
            size="micro"
            variant="ghost"
            disabled={retrying}
            aria-label={`Retry device discovery on ${props.label}`}
            onClick={() => {
              setRetrying(true);
              void props.onRetry().finally(() => setRetrying(false));
            }}
          >
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        ) : null}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            aria-label={`Details for ${props.label}`}
            render={<Button size="micro" variant="ghost" />}
          >
            Details
          </PopoverTrigger>
          <PopoverPopup side="bottom" align="end" width="lg" padding="compact">
            <p className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
              {props.detail}
            </p>
          </PopoverPopup>
        </Popover>
        <Button
          size="icon-micro"
          variant="ghost"
          aria-label={`Dismiss device warning for ${props.label}`}
          onClick={() => {
            setOpen(false);
            setDismissedCause(cause);
          }}
        >
          <X />
        </Button>
      </span>
    </div>
  );
}

/**
 * One source of devices. This environment's are grouped by kind; a linked environment's sit
 * under its name with the link's state, and its devices show only while it answers.
 */
function DeviceSource(props: {
  readonly source: DeviceSourceGroup;
  readonly renderDevice: (device: DeviceSummary) => ReactNode;
}) {
  const { linked, groups } = props.source;
  if (linked === null)
    return groups.map((group) => (
      <section key={group.kind} className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Smartphone className="size-4 shrink-0" />
          <h3 className="font-medium">{DEVICE_KIND_LABELS[group.kind]}</h3>
        </div>
        <DiscoveryList>{group.devices.map(props.renderDevice)}</DiscoveryList>
      </section>
    ));
  const devices = groups.flatMap((group) => group.devices);
  return (
    <section className="space-y-3" aria-label={`Devices on ${linked.label}`}>
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <Link2 className="size-4 shrink-0" />
        <h3 className="truncate font-medium">{linked.label}</h3>
        <Badge
          size="sm"
          variant={
            linked.state === "connected"
              ? "success"
              : linked.state === "needs_update"
                ? "warning"
                : "error"
          }
        >
          {LINKED_DEVICE_STATE_LABELS[linked.state]}
        </Badge>
      </div>
      {linked.detail ? (
        <p className="whitespace-pre-line break-words text-xs">{linked.detail}</p>
      ) : null}
      {devices.length > 0 ? (
        <DiscoveryList>{devices.map(props.renderDevice)}</DiscoveryList>
      ) : linked.state === "connected" ? (
        <p className="text-xs">No devices on {linked.label}.</p>
      ) : null}
    </section>
  );
}
