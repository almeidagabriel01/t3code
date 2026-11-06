import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ language: "auto", set: vi.fn() }));

vi.mock("../../../state/channelLanguage", () => ({
  useChannelLanguage: () => ({ language: mocks.language, set: mocks.set }),
}));
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

import { ChannelLanguageSection } from "./ChannelLanguageSection";

async function mount(disabled = false) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChannelLanguageSection environmentId={"env" as EnvironmentId} disabled={disabled} />,
    );
  });
  const radios = [...host.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  return { host, radios, unmount: () => act(() => root.unmount()) };
}

describe("ChannelLanguageSection", () => {
  it("lists the three languages by label, marks the current one and saves the picked one", async () => {
    mocks.language = "pt-BR";
    mocks.set.mockClear();
    const view = await mount();
    expect(view.radios.map((radio) => radio.textContent)).toEqual([
      "Automatic (Mac language)",
      "English",
      "Português (Brasil)",
    ]);
    expect(view.radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
    ]);
    expect(view.host.textContent).toContain("Assistants reply in the language you write in.");
    await act(async () => view.radios[1]?.click());
    expect(mocks.set).toHaveBeenCalledWith("en");
    await view.unmount();
  });

  it("is inert without permission", async () => {
    const view = await mount(true);
    expect(view.radios.every((radio) => radio.disabled)).toBe(true);
    await view.unmount();
  });
});
