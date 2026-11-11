import { useAtomValue } from "@effect/atom-react";
import {
  DEVICE_ACCESS_POLICY_LABELS,
  DeviceAccessPolicy,
  deviceAccessKey,
  deviceAccessPolicy,
  storedDeviceAccessPolicy,
  type DeviceServiceState,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { Badge } from "~/components/ui/badge";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { deviceEnvironment } from "~/state/device";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const isPolicy = Schema.is(DeviceAccessPolicy);
const POLICIES = ["allow", "ask", "deny"] as const;

export function DeviceAccessSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly state: DeviceServiceState;
}) {
  const canEdit = useAtomValue(deviceEnvironment.setAccess.permissionAtom(props.environmentId));
  const setAccess = useAtomCommand(deviceEnvironment.setAccess);
  if (props.state.supportsDeviceControl !== true || props.state.devices.length === 0) return null;
  const access = props.state.access ?? {};
  const devices = props.state.devices.toSorted(
    (a, b) =>
      Number(b.physical === true) - Number(a.physical === true) || a.name.localeCompare(b.name),
  );
  return (
    <SettingsSection id="device-access" title="Device access">
      {devices.map((device) => {
        const policy = deviceAccessPolicy(access, device);
        const host = props.state.hosts.find((candidate) => candidate.id === device.hostId);
        const save = (next: DeviceAccessPolicy | null) =>
          void setAccess({
            environmentId: props.environmentId,
            input: { hostId: device.hostId, deviceId: device.id, policy: next },
          });
        return (
          <SettingsRow
            key={deviceAccessKey(device)}
            title={
              <span className="flex items-center gap-2">
                <span className="truncate">{device.name}</span>
                {device.physical ? (
                  <Badge variant="outline" size="sm">
                    Physical
                  </Badge>
                ) : null}
              </span>
            }
            description={`${host?.label ?? "Device host"} · ${device.version}. ${DEVICE_ACCESS_POLICY_LABELS[policy].description}`}
            resetAction={
              canEdit && storedDeviceAccessPolicy(access, device) !== undefined ? (
                <SettingResetButton
                  label={`agent access to ${device.name}`}
                  onClick={() => save(null)}
                />
              ) : null
            }
            control={
              <Select
                value={policy}
                disabled={!canEdit}
                onValueChange={(value) => {
                  if (isPolicy(value)) save(value);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={`Agent access to ${device.name}`}
                >
                  <SelectValue>{DEVICE_ACCESS_POLICY_LABELS[policy].label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {POLICIES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {DEVICE_ACCESS_POLICY_LABELS[option].label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
