import type { KeepAwakeStatus } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

const mocks = vi.hoisted(() => ({
  status: null as KeepAwakeStatus | null,
  keepAwake: "off" as "off" | "while-working" | "always",
  update: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../../state/keepAwake", () => ({ useKeepAwakeStatus: () => mocks.status }));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "env",
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { environmentIds: ["env"] },
    environment: { environmentId: "env" },
  }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({ keepAwake: mocks.keepAwake }),
  useScopedSettingsMixed: () => false,
  useScopedSettingsWriteAllowed: () => true,
  useUpdateScopedSettings: () => mocks.update,
}));
// The production row reads scope and permission atoms that this behavior does not touch.
vi.mock("./settingsLayout", () => ({
  SettingResetButton: ({ onClick }: { onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      Reset
    </button>
  ),
  SettingsRow: ({
    title,
    description,
    status,
    resetAction,
    children,
  }: {
    title: string;
    description: string;
    status?: import("react").ReactNode;
    resetAction?: import("react").ReactNode;
    children: import("react").ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      <div>{status}</div>
      {resetAction}
      {children}
    </div>
  ),
}));

import { KeepAwakeSegment } from "../statusBar/KeepAwakeSegment";
import { KeepAwakeSettingsRow } from "./KeepAwakeSettings";

function setup(input: { status: KeepAwakeStatus | null; keepAwake?: typeof mocks.keepAwake }) {
  mocks.status = input.status;
  mocks.keepAwake = input.keepAwake ?? "off";
  mocks.update.mockClear();
  mocks.navigate.mockClear();
}

it("sends the chosen mode and offers a reset once it differs from the default", async () => {
  setup({ status: { supported: true, active: false }, keepAwake: "always" });
  await using screen = await render(<KeepAwakeSettingsRow />, { router: false }); // router is mocked
  await expect.element(screen.getByRole("radio", { name: "Always" })).toBeChecked();
  await screen.getByText("While agents are working").click();
  expect(mocks.update).toHaveBeenLastCalledWith({ keepAwake: "while-working" });
  await screen.getByRole("button", { name: "Reset" }).click();
  expect(mocks.update).toHaveBeenLastCalledWith({ keepAwake: "off" });
  await expect.element(screen.getByText("Closing a laptop lid", { exact: false })).toBeVisible();
});

it("disables the choices when this host cannot stay awake", async () => {
  setup({ status: { supported: false, active: false } });
  await using screen = await render(<KeepAwakeSettingsRow />, { router: false }); // router is mocked
  await expect.element(screen.getByText("Not available on this system")).toBeVisible();
  await expect
    .element(screen.getByRole("radio", { name: "Always" }))
    .toHaveAttribute("aria-disabled", "true");
});

it("shows nothing while the host is not held awake", async () => {
  setup({ status: { supported: true, active: false } });
  await using screen = await render(<KeepAwakeSegment />, { router: false }); // router is mocked
  await expect
    .element(screen.getByRole("button", { name: "Keeping this computer awake" }))
    .not.toBeInTheDocument();
});

it("shows the coffee cup while the host is held awake, and opens the setting", async () => {
  setup({ status: { supported: true, active: true } });
  await using screen = await render(<KeepAwakeSegment />, { router: false }); // router is mocked
  const chip = screen.getByRole("button", { name: "Keeping this computer awake" });
  await userEvent.hover(chip);
  await expect
    .element(page.getByText("Keeping this computer awake", { exact: true }))
    .toBeVisible();
  await chip.click();
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings/maintenance", hash: "keep-awake" });
});
