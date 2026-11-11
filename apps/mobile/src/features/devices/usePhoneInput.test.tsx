import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../state/device", () => ({ deviceEnvironment: { input: { label: "device:input" } } }));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAtomCommand: mocks.run,
}));

import { usePhoneInput } from "./usePhoneInput";

describe("usePhoneInput", () => {
  it("sends to the phone's session target and reports each failure in the user's words", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.run
      .mockResolvedValueOnce({ _tag: "Success", value: undefined })
      .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("Locked")) })
      .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail("refused") });
    let latest!: ReturnType<typeof usePhoneInput>;
    function Probe() {
      latest = usePhoneInput(EnvironmentId.make("env"), { hostId: "local", deviceId: "UDID" });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));

    await act(async () => latest.send({ type: "tap", x: 0.5, y: 0.5 }));
    expect(mocks.run.mock.calls[0]![2]).toEqual({
      environmentId: "env",
      input: { hostId: "local", deviceId: "UDID", input: { type: "tap", x: 0.5, y: 0.5 } },
    });
    expect(latest).toMatchObject({ pending: false, error: null });
    await act(async () => latest.send({ type: "button", button: "home" }));
    expect(latest).toMatchObject({ pending: false, error: "Locked" });
    await act(async () => latest.send({ type: "text", text: "a" }));
    expect(latest.error).toBe("refused");
    act(() => root.unmount());
  });
});
