import { RegistryContext } from "@effect/atom-react";
import type { DeviceSummary, EnvironmentId } from "@t3tools/contracts";
import {
  createPhoneGesture,
  createPhoneInputSender,
  createPhoneTextBuffer,
  phoneKeyText,
  type PhoneInputState,
} from "@t3tools/client-runtime/device/phone-input";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useContext, useState } from "react";

import { deviceEnvironment } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import type { DevicePhoneControl } from "./DeviceStreamView";

/** The user's taps, swipes, typing and buttons for a USB iPhone, sent in order. */
export function usePhoneInput(
  environmentId: EnvironmentId,
  device: Pick<DeviceSummary, "hostId" | "id">,
) {
  const registry = useContext(RegistryContext);
  const [state, setState] = useState<PhoneInputState>({ pending: false, error: null });
  // The workspace is keyed by environment and device, so both stay fixed for this hook.
  const [control] = useState(() => {
    const send = createPhoneInputSender(async (input) => {
      const result = await runAtomCommand(
        registry,
        deviceEnvironment.input,
        { environmentId, input: { hostId: device.hostId, deviceId: device.id, input } },
        { label: deviceEnvironment.input.label, reportFailure: false, reportDefect: true },
      );
      return result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null;
    }, setState);
    const gesture = createPhoneGesture(send);
    const text = createPhoneTextBuffer(send);
    const view: DevicePhoneControl = {
      touch: (phase, x, y) => {
        if (phase === "begin") text.flush();
        gesture.touch(phase, x, y);
      },
      key: (event) => {
        const typed = phoneKeyText(event);
        if (typed === null) return false;
        text.add(typed);
        return true;
      },
      paste: text.add,
    };
    return {
      view,
      button: (button: "home" | "appSwitcher") => {
        text.flush();
        send({ type: "button", button });
      },
    };
  });
  return { ...control, ...state };
}
