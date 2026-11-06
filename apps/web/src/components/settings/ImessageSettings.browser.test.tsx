import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import {
  fakeImessage,
  installFakeEnvironment,
  publishImessageStatus,
  resetFakeImessage,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { ImessageSettingsPanel } from "./ImessageSettings";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

installFakeEnvironment([threadWithHistory("thread-a", 2)], { imessageChannel: true });
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

// The panel alone under the app's atom registry: mounting the whole app per case is slow enough
// to pass the test timeout on a busy machine.
async function openImessage() {
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  return render(
    <AppAtomRegistryProvider>
      <ImessageSettingsPanel />
    </AppAtomRegistryProvider>,
    { container },
  );
}

it("lists iMessage in the settings navigation", async () => {
  resetFakeImessage();
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <SettingsSidebarNav pathname="/settings/imessage" />
      </SidebarProvider>
    </AppAtomRegistryProvider>,
  );
  await expect
    .element(page.getByRole("navigation", { name: "Settings sections" }).getByText("iMessage"))
    .toBeVisible();
});

const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });

it("offers the channel language as one labelled select", async () => {
  resetFakeImessage();
  await using _screen = await openImessage();
  await expect.element(page.getByText("Language", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("combobox", { name: "Language" }))
    .toHaveTextContent("Automatic (Mac language)");
});

it("shows access states and rechecks on demand", async () => {
  resetFakeImessage({}, "full_disk_access_missing");
  await using _screen = await openImessage();
  await expect.element(page.getByText("Not granted")).toBeVisible();
  await expect.element(page.getByText("Open System Settings", { exact: false })).toBeVisible();

  fakeImessage.access = "ok";
  const before = fakeImessage.accessChecks;
  await userEvent.click(page.getByRole("button", { name: "Check again" }));
  await expect.element(page.getByText("Granted", { exact: true })).toBeVisible();
  expect(fakeImessage.accessChecks).toBeGreaterThan(before);
});

it("explains the permission or sign-in problem Messages reported", async () => {
  resetFakeImessage({ enabled: true, status: "error", lastError: "automation_denied" });
  await using _screen = await openImessage();
  await expect
    .element(page.getByText("Allow T3 Code to control Messages", { exact: false }).first())
    .toBeVisible();
});

it("shows live status and the last delivery failure", async () => {
  resetFakeImessage({ selfHandles: ["+15551230000"], enabled: true, status: "running" });
  await using _screen = await openImessage();
  await expect.element(page.getByText("Running", { exact: true })).toBeVisible();
  publishImessageStatus({
    status: "running",
    lastDeliveryError: { code: "timeout", at: "2026-10-01T12:00:00.000Z" },
  });
  await expect
    .element(page.getByText("Messages did not answer in time", { exact: false }))
    .toBeVisible();
  publishImessageStatus({ status: "error", lastError: "messages_not_signed_in" });
  await expect.element(page.getByText("not signed in", { exact: false }).first()).toBeVisible();
});

it("keeps the switch off until access and a handle exist, then enables iMessage", async () => {
  resetFakeImessage({}, "full_disk_access_missing");
  await using _screen = await openImessage();
  const toggle = page.getByRole("switch", { name: "Use iMessage" });
  await expect.element(toggle).toBeDisabled();
  await expect
    .element(page.getByText("Grant Full Disk Access and add", { exact: false }))
    .toBeVisible();

  fakeImessage.access = "ok";
  await userEvent.click(page.getByRole("button", { name: "Check again" }));
  await expect
    .element(page.getByText("Add at least one phone number or email", { exact: false }))
    .toBeVisible();
  await expect.element(toggle).toBeDisabled();

  await userEvent.fill(page.getByLabelText("Your phone numbers and emails"), "+15551230000");
  await userEvent.click(page.getByRole("button", { name: "Add" }).first());
  await eventually(() =>
    expect(fakeImessage.configures).toEqual([{ selfHandles: ["+15551230000"] }]),
  );
  await expect.element(toggle).toBeEnabled();

  await userEvent.click(toggle);
  await eventually(() => expect(fakeImessage.configures.at(-1)).toEqual({ enabled: true }));
});

it("adds and removes handles, sending the full list each time", async () => {
  resetFakeImessage({ selfHandles: ["+15551230000"], allowedHandles: ["a@example.com"] });
  await using _screen = await openImessage();
  await userEvent.fill(page.getByLabelText("Your phone numbers and emails"), "me@example.com");
  await userEvent.click(page.getByRole("button", { name: "Add" }).first());
  await eventually(() =>
    expect(fakeImessage.configures.at(-1)).toEqual({
      selfHandles: ["+15551230000", "me@example.com"],
    }),
  );
  await expect.element(page.getByLabelText("Your phone numbers and emails")).toHaveValue("");

  await userEvent.fill(page.getByLabelText("Allowed phone numbers and emails"), "b@example.com");
  await userEvent.click(page.getByRole("button", { name: "Add" }).nth(1));
  await eventually(() =>
    expect(fakeImessage.configures.at(-1)).toEqual({
      allowedHandles: ["a@example.com", "b@example.com"],
    }),
  );

  await userEvent.click(page.getByRole("button", { name: "Remove a@example.com" }));
  await eventually(() =>
    expect(fakeImessage.configures.at(-1)).toEqual({ allowedHandles: ["b@example.com"] }),
  );
  await userEvent.click(page.getByRole("button", { name: "Remove +15551230000" }));
  await eventually(() =>
    expect(fakeImessage.configures.at(-1)).toEqual({ selfHandles: ["me@example.com"] }),
  );
});

it("offers the Mac's own handles that are not listed yet and adds them in one click", async () => {
  resetFakeImessage({ allowedHandles: ["a@example.com"] });
  fakeImessage.ownHandles = ["me@example.com", "+15551230000", "a@example.com"];
  await using _screen = await openImessage();
  await expect
    .element(page.getByText("Messages here sends from me@example.com and +1 (555) 123-0000."))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Add them" }));
  await eventually(() =>
    expect(fakeImessage.configures.at(-1)).toEqual({
      selfHandles: ["me@example.com", "+15551230000"],
    }),
  );
  await expect.element(page.getByText("Found on this Mac")).not.toBeInTheDocument();
});

it("ignores repeated handles and shows the server's refusal", async () => {
  resetFakeImessage({ selfHandles: ["+15551230000"] });
  await using _screen = await openImessage();
  const field = page.getByLabelText("Your phone numbers and emails");
  await userEvent.fill(field, "+15551230000");
  await userEvent.click(page.getByRole("button", { name: "Add" }).first());
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("That one is already on the list.");
  expect(fakeImessage.configures).toEqual([]);

  fakeImessage.failConfigure = "invalid_handle";
  await userEvent.fill(field, "nope");
  await userEvent.click(page.getByRole("button", { name: "Add" }).first());
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("That is not a phone number with country code (+...) or an email address.");
  await expect.element(field).toHaveValue("nope");

  await userEvent.click(page.getByRole("button", { name: "Remove +15551230000" }));
  await eventually(() => expect(fakeImessage.configures).toHaveLength(2));
});

it("shows the server's refusal on the switch", async () => {
  resetFakeImessage({ selfHandles: ["+15551230000"] });
  fakeImessage.failConfigure = "persistence_failed";
  await using _screen = await openImessage();
  await userEvent.click(page.getByRole("switch", { name: "Use iMessage" }));
  await expect.element(page.getByText("Could not save the iMessage settings.")).toBeVisible();
});
