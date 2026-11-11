import { useAtomValue } from "@effect/atom-react";
import {
  deviceAccessPolicy,
  findDeviceHold,
  type DeviceServiceState,
  type DeviceSummary,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Hand, Undo2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { deviceEnvironment } from "~/state/device";
import { useAtomCommand } from "~/state/use-atom-command";

const AGENT_STATUS = {
  allow: "Agents can use this device",
  ask: "Agents ask before using this device",
  deny: "Agents cannot use this device",
} as const;

export function useDeviceHold(environmentId: EnvironmentId) {
  const canHold = useAtomValue(deviceEnvironment.setHold.permissionAtom(environmentId));
  const setHold = useAtomCommand(deviceEnvironment.setHold);
  return {
    canHold,
    changeHold: (device: Pick<DeviceSummary, "hostId" | "id">, held: boolean) =>
      void setHold({ environmentId, input: { hostId: device.hostId, deviceId: device.id, held } }),
  };
}

/** Who drives the device now, with the way to switch. `heldOnly` hides the idle state. */
export function DeviceHoldBar(props: {
  readonly environmentId: EnvironmentId;
  readonly state: DeviceServiceState;
  readonly device: DeviceSummary;
  readonly heldOnly?: boolean;
  readonly className?: string;
}) {
  const { canHold, changeHold } = useDeviceHold(props.environmentId);
  const held = findDeviceHold(props.state.holds, props.device) !== undefined;
  if (!props.state.supportsDeviceControl) return null;
  if (!held && (props.heldOnly || !props.state.agentAccessEnabled)) return null;
  const policy = deviceAccessPolicy(props.state.access, props.device);
  return (
    <div
      role="status"
      className={cn("flex items-center gap-2 px-3 py-1.5 text-xs", props.className)}
    >
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          held ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {held ? "You are in control. Agent paused." : AGENT_STATUS[policy]}
      </span>
      {held || policy !== "deny" ? (
        <Button
          size="xs"
          variant={held ? "default" : "outline"}
          disabled={!canHold}
          onClick={() => changeHold(props.device, !held)}
        >
          {held ? <Undo2 /> : <Hand />}
          {held ? "Hand back" : "Take over"}
        </Button>
      ) : null}
    </div>
  );
}
