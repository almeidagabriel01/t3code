import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  scoped: true,
  minutes: 10,
  update: vi.fn(),
}));

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useOptionalSettingsScope: (() => (mocks.scoped ? {} : null)) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({ providerIdleTimeoutMinutes: mocks.minutes })) as never,
  useUpdateScopedSettings: (() => mocks.update) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingResetButton: (({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" aria-label={`Reset ${label}`} onClick={onClick}>
      Reset
    </button>
  )) as never,
  SettingsRow: ((props: { title: ReactNode; resetAction?: ReactNode; control?: ReactNode }) => (
    <div>
      <h3>{props.title}</h3>
      {props.resetAction}
      {props.control}
    </div>
  )) as never,
}));

import { ProviderIdleTimeoutRow } from "./SettingsPanels";

function setup(minutes: number, scoped = true) {
  mocks.scoped = scoped;
  mocks.minutes = minutes;
  mocks.update.mockReset();
}

const input = (screen: { getByRole: (role: "spinbutton") => { element(): Element } }) =>
  screen.getByRole("spinbutton").element() as HTMLInputElement;

it("saves only whole minutes inside the allowed range and restores the saved value on blur", async () => {
  setup(10);
  await using screen = await render(<ProviderIdleTimeoutRow />, { router: false }); // a settings row needs no route
  await expect.element(screen.getByText("Close idle Claude agents")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reset close idle Claude agents" }).query()).toBeNull();

  await userEvent.fill(input(screen), "25");
  expect(mocks.update).toHaveBeenLastCalledWith({ providerIdleTimeoutMinutes: 25 });

  mocks.update.mockClear();
  await userEvent.fill(input(screen), "0");
  await userEvent.fill(input(screen), "1.5");
  await userEvent.fill(input(screen), "999");
  expect(mocks.update).not.toHaveBeenCalled();

  input(screen).blur();
  await expect.poll(() => input(screen).value).toBe("10");
});

it("offers a reset to the default and hides itself outside a settings scope", async () => {
  setup(45);
  await using screen = await render(<ProviderIdleTimeoutRow />, { router: false }); // a settings row needs no route
  expect(input(screen).value).toBe("45");
  await screen.getByRole("button", { name: "Reset close idle Claude agents" }).click();
  expect(mocks.update).toHaveBeenCalledWith({
    providerIdleTimeoutMinutes: DEFAULT_UNIFIED_SETTINGS.providerIdleTimeoutMinutes,
  });

  setup(10, false);
  await using hidden = await render(<ProviderIdleTimeoutRow />, { router: false }); // a settings row needs no route
  expect(hidden.container.textContent).toBe("");
});
