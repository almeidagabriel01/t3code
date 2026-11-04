import type { EnvironmentId, KeepAwakeMode, KeepAwakeStatus } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ status: null as KeepAwakeStatus | null }));

vi.mock("../../../state/keepAwake", () => ({ useKeepAwakeStatus: () => mocks.status }));
vi.mock("./SettingsSection", () => ({
  SettingsSection: (props: { title: string; footer?: string; children: ReactNode }) => (
    <section aria-label={props.title}>
      {props.children}
      <p>{props.footer}</p>
    </section>
  ),
}));
vi.mock("../../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: (props: {
    label: string;
    selected: boolean;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button
      role="radio"
      aria-checked={props.selected}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  ),
}));

import { KeepAwakeSection } from "./KeepAwakeSection";

async function mount(input: {
  status: KeepAwakeStatus | null;
  value?: KeepAwakeMode | null;
  disabled?: boolean;
}) {
  mocks.status = input.status;
  const onChange = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <KeepAwakeSection
        environmentId={"env" as EnvironmentId}
        value={input.value === undefined ? "off" : input.value}
        disabled={input.disabled ?? false}
        onChange={onChange}
      />,
    );
  });
  const radios = [...host.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  return { host, onChange, radios, unmount: () => act(() => root.unmount()) };
}

describe("KeepAwakeSection", () => {
  it("lists the three choices, marks the current one and sends the picked mode", async () => {
    const view = await mount({ status: { supported: true, active: false }, value: "always" });
    expect(view.radios.map((radio) => radio.textContent)).toEqual([
      "Off",
      "While agents are working",
      "Always",
    ]);
    expect(view.radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
    ]);
    expect(view.host.textContent).toContain("Closing a laptop lid still puts it to sleep");
    await act(async () => view.radios[1]?.click());
    expect(view.onChange).toHaveBeenCalledWith("while-working");
    await view.unmount();
  });

  it("selects nothing when the environments disagree", async () => {
    const view = await mount({ status: null, value: null });
    expect(view.radios.every((radio) => radio.getAttribute("aria-checked") === "false")).toBe(true);
    await view.unmount();
  });

  it.each([
    { name: "unsupported host", status: { supported: false, active: false }, disabled: false },
    { name: "read-only settings", status: { supported: true, active: false }, disabled: true },
  ])("disables the choices for $name", async ({ status, disabled }) => {
    const view = await mount({ status, disabled });
    expect(view.radios.every((radio) => radio.disabled)).toBe(true);
    expect(view.host.textContent?.includes("Not available on this system")).toBe(!status.supported);
    await view.unmount();
  });
});
