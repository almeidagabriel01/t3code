import { RegistryContext } from "@effect/atom-react";
import {
  createPhoneInputSender,
  type PhoneInputState,
} from "@t3tools/client-runtime/device/phone-input";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useContext, useState } from "react";

import { deviceEnvironment } from "../../state/device";

/** Sends a USB iPhone's gestures, text and buttons from its viewer, in order. */
export function usePhoneInput(
  environmentId: EnvironmentId,
  target: { readonly hostId: string; readonly deviceId: string },
) {
  const registry = useContext(RegistryContext);
  const [state, setState] = useState<PhoneInputState>({ pending: false, error: null });
  // The viewer is keyed by device, so the target stays fixed for this hook.
  const [send] = useState(() =>
    createPhoneInputSender(async (input) => {
      const result = await runAtomCommand(
        registry,
        deviceEnvironment.input,
        { environmentId, input: { hostId: target.hostId, deviceId: target.deviceId, input } },
        { label: deviceEnvironment.input.label, reportFailure: false, reportDefect: true },
      );
      if (result._tag === "Success") return null;
      const error = Cause.squash(result.cause);
      return error instanceof Error ? error.message : String(error);
    }, setState),
  );
  return { send, ...state };
}
