import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_PROVIDER_IDLE_TIMEOUT_MINUTES,
} from "@t3tools/contracts/settings";
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

const field = (screen: { getByLabelText: (label: string) => { element(): Element } }) =>
  screen.getByLabelText("Minutes before an idle Claude agent closes").element() as HTMLInputElement;

it("saves whole minutes clamped to the allowed range and keeps the saved value when cleared", async () => {
  setup(10);
  await using screen = await render(<ProviderIdleTimeoutRow />, { router: false }); // a settings row needs no route
  await expect.element(screen.getByText("Close idle Claude agents")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reset close idle Claude agents" }).query()).toBeNull();

  // regression: every keystroke saved, so typing 120 closed idle sessions after 1 minute
  await userEvent.fill(field(screen), "120");
  expect(mocks.update).not.toHaveBeenCalled();
  await userEvent.fill(field(screen), "25");
  field(screen).blur();
  await expect
    .poll(() => mocks.update.mock.calls.at(-1)?.[0])
    .toEqual({
      providerIdleTimeoutMinutes: 25,
    });

  await userEvent.fill(field(screen), "999");
  field(screen).blur();
  await expect
    .poll(() => mocks.update.mock.calls.at(-1)?.[0])
    .toEqual({
      providerIdleTimeoutMinutes: MAX_PROVIDER_IDLE_TIMEOUT_MINUTES,
    });

  mocks.update.mockClear();
  await userEvent.clear(field(screen));
  field(screen).blur();
  await expect.poll(() => field(screen).value).toBe("10");
  expect(mocks.update).not.toHaveBeenCalled();
});

it("offers a reset to the default and hides itself outside a settings scope", async () => {
  setup(45);
  await using screen = await render(<ProviderIdleTimeoutRow />, { router: false }); // a settings row needs no route
  expect(field(screen).value).toBe("45");
  await screen.getByRole("button", { name: "Reset close idle Claude agents" }).click();
  expect(mocks.update).toHaveBeenCalledWith({
    providerIdleTimeoutMinutes: DEFAULT_UNIFIED_SETTINGS.providerIdleTimeoutMinutes,
  });

  setup(10, false);
  await using hidden = await render(<ProviderIdleTimeoutRow />, { router: false }); // a settings row needs no route
  expect(hidden.container.textContent).toBe("");
});
