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
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  usePrimarySettings: (select: (settings: { keepAwake: typeof mocks.keepAwake }) => unknown) =>
    select({ keepAwake: mocks.keepAwake }),
  usePrimarySettingsAvailable: () => true,
  useUpdatePrimarySettings: () => mocks.update,
}));
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

it.each([
  { name: "off", keepAwake: "off", label: "This computer can sleep" },
  {
    name: "waiting for work",
    keepAwake: "while-working",
    label: "Keeps this computer awake while agents work",
  },
] as const)("keeps a muted cup in the bar while $name", async ({ keepAwake, label }) => {
  setup({ status: { supported: true, active: false }, keepAwake });
  await using screen = await render(<KeepAwakeSegment />, { router: false }); // router is mocked
  const cup = screen.getByRole("button", { name: label });
  await expect.element(cup).toBeVisible();
  await expect.element(cup).not.toHaveAttribute("data-active");
});

it("shows no cup on a host that cannot stay awake", async () => {
  setup({ status: { supported: false, active: false } });
  await using screen = await render(<KeepAwakeSegment />, { router: false }); // router is mocked
  expect(screen.container.querySelector("button")).toBeNull();
});

it("lights the cup while held awake and switches the mode from its menu", async () => {
  setup({ status: { supported: true, active: true }, keepAwake: "always" });
  await using screen = await render(<KeepAwakeSegment />, { router: false }); // router is mocked
  const cup = screen.getByRole("button", { name: "Keeping this computer awake" });
  await expect.element(cup).toHaveAttribute("data-active");
  await userEvent.hover(cup);
  await expect
    .element(page.getByText("Keeping this computer awake", { exact: true }))
    .toBeVisible();
  await cup.click();
  await expect.element(page.getByRole("menuitemradio", { name: "Always" })).toBeChecked();
  await page.getByRole("menuitemradio", { name: "While agents are working" }).click();
  expect(mocks.update).toHaveBeenLastCalledWith({ keepAwake: "while-working" });
  await cup.click();
  await page.getByRole("menuitem", { name: "Keep-awake settings" }).click();
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings/maintenance", hash: "keep-awake" });
});
