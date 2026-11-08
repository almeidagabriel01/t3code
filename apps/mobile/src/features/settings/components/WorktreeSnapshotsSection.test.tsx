import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./SettingsSection", () => ({
  SettingsSection: (props: { title: string; footer?: string; children: ReactNode }) => (
    <section aria-label={props.title}>{props.children}</section>
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

import { WorktreeSnapshotsSection } from "./WorktreeSnapshotsSection";

async function mount(value: number | null | undefined, disabled = false) {
  const onChange = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(<WorktreeSnapshotsSection value={value} disabled={disabled} onChange={onChange} />);
  });
  const radios = [...host.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  return { onChange, radios, unmount: () => act(() => root.unmount()) };
}

describe("WorktreeSnapshotsSection", () => {
  it("marks the current retention and sends the picked one", async () => {
    const view = await mount(30);
    expect(view.radios.map((radio) => radio.textContent)).toEqual([
      "7 days",
      "30 days",
      "90 days",
      "Keep until I delete them",
    ]);
    expect(view.radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
    await act(async () => view.radios[3]?.click());
    expect(view.onChange).toHaveBeenCalledWith(null);
    await view.unmount();
  });

  it("keeps a value chosen elsewhere selectable, and selects nothing when machines disagree", async () => {
    const custom = await mount(45);
    expect(custom.radios.map((radio) => radio.textContent)).toContain("45 days");
    expect(custom.radios.find((radio) => radio.textContent === "45 days")?.ariaChecked).toBe(
      "true",
    );
    await custom.unmount();
    const mixed = await mount(undefined, true);
    expect(mixed.radios.every((radio) => radio.getAttribute("aria-checked") === "false")).toBe(
      true,
    );
    expect(mixed.radios.every((radio) => radio.disabled)).toBe(true);
    await mixed.unmount();
  });
});
