import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import {
  fakeTelegram,
  installFakeEnvironment,
  publishTelegramStatus,
  resetFakeTelegram,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { TelegramSettingsPanel } from "./TelegramSettings";

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

installFakeEnvironment([threadWithHistory("thread-a", 2)], { telegramChannel: true });
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

// The panel alone under the app's atom registry: mounting the whole app per case is slow enough
// to pass the test timeout on a busy machine.
async function openTelegram() {
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  return render(
    <AppAtomRegistryProvider>
      <TelegramSettingsPanel />
    </AppAtomRegistryProvider>,
    { container },
  );
}

const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });

it("offers the channel language as one labelled select", async () => {
  resetFakeTelegram();
  await using _screen = await openTelegram();
  await expect.element(page.getByText("Language", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("combobox", { name: "Language" }))
    .toHaveTextContent("Automatic (Mac language)");
});

it("lists Telegram in the settings navigation", async () => {
  resetFakeTelegram();
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <SettingsSidebarNav pathname="/settings/telegram" />
      </SidebarProvider>
    </AppAtomRegistryProvider>,
  );
  await expect
    .element(page.getByRole("navigation", { name: "Settings sections" }).getByText("Telegram"))
    .toBeVisible();
});

it("explains how to make a bot and get allowed", async () => {
  resetFakeTelegram();
  await using _screen = await openTelegram();
  await expect
    .element(page.getByText("@BotFather and send /newbot", { exact: false }))
    .toBeVisible();
  await expect.element(page.getByText("4. Allow yourself")).toBeVisible();
});

it("shows live status, the bot's name, and the last delivery failure", async () => {
  resetFakeTelegram({
    enabled: true,
    tokenConfigured: true,
    allowedUserIds: ["111"],
    status: "running",
  });
  await using _screen = await openTelegram();
  await expect.element(page.getByText("Connected", { exact: false })).toBeVisible();
  publishTelegramStatus({
    status: "running",
    botUsername: "my_bot",
    lastDeliveryError: { code: "chat_not_found", at: "2026-10-01T12:00:00.000Z" },
  });
  await expect.element(page.getByText("Connected as @my_bot")).toBeVisible();
  await expect
    .element(
      page.getByText("the chat was not found; send the bot a message first", { exact: false }),
    )
    .toBeVisible();
  publishTelegramStatus({ status: "error", lastError: "invalid_token" });
  await expect
    .element(page.getByText("Telegram does not accept this bot token", { exact: false }))
    .toBeVisible();
});

it("keeps the switch off until a token exists, then turns Telegram on without any user id", async () => {
  resetFakeTelegram();
  await using _screen = await openTelegram();
  const toggle = page.getByRole("switch", { name: "Use Telegram" });
  await expect.element(toggle).toBeDisabled();
  await expect.element(page.getByText("Add the bot token before turning this on.")).toBeVisible();

  const token = page.getByLabelText("Bot token");
  await expect.element(token).toHaveAttribute("type", "password");
  await userEvent.fill(token, " 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ ");
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeTelegram.configures).toEqual([{ botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ" }]),
  );
  await expect.element(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect.element(token).toHaveValue("");
  await expect.element(toggle).toBeEnabled();
  await userEvent.click(toggle);
  await eventually(() => expect(fakeTelegram.configures.at(-1)).toEqual({ enabled: true }));
});

it("lists people waiting for approval, and allows or ignores them", async () => {
  resetFakeTelegram({
    enabled: true,
    tokenConfigured: true,
    allowedUserIds: ["111"],
    status: "running",
    pendingSenders: [
      { userId: "222", firstName: "Bo", username: "bo_x", lastSeenAt: "2026-10-01T12:00:00.000Z" },
      { userId: "333", lastSeenAt: "2026-10-01T11:00:00.000Z" },
    ],
  });
  await using _screen = await openTelegram();
  publishTelegramStatus({
    status: "running",
    pendingSenders: fakeTelegram.settings.pendingSenders!,
  });
  await expect.element(page.getByText("Waiting for approval", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Bo", { exact: true })).toBeVisible();
  await expect.element(page.getByText("@bo_x", { exact: false })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Allow Bo" }));
  await eventually(() =>
    expect(fakeTelegram.configures.at(-1)).toEqual({ allowedUserIds: ["111", "222"] }),
  );
  await expect.element(page.getByRole("button", { name: "Remove 222" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Allow Bo" })).not.toBeInTheDocument();

  await userEvent.click(page.getByRole("button", { name: "Ignore 333" }));
  await eventually(() =>
    expect(fakeTelegram.configures.at(-1)).toEqual({ dismissUserIds: ["333"] }),
  );
  await expect
    .element(page.getByText("Waiting for approval", { exact: true }))
    .not.toBeInTheDocument();

  publishTelegramStatus({
    status: "running",
    pendingSenders: [{ userId: "444", firstName: "Cy", lastSeenAt: "2026-10-01T12:30:00.000Z" }],
  });
  await expect.element(page.getByRole("button", { name: "Allow Cy" })).toBeVisible();
  fakeTelegram.failConfigure = "persistence_failed";
  await userEvent.click(page.getByRole("button", { name: "Allow Cy" }));
  await expect.element(page.getByText("Could not save the Telegram settings.")).toBeVisible();
});

it("replaces and removes the token without ever showing it", async () => {
  resetFakeTelegram({ enabled: true, tokenConfigured: true, allowedUserIds: ["111"] });
  await using _screen = await openTelegram();
  const token = page.getByLabelText("Bot token");
  await expect.element(token).toHaveValue("");
  await expect.element(page.getByRole("button", { name: "Replace" })).toBeDisabled();
  await userEvent.fill(token, "654321:ZYXWVUTSRQPONMLKJIHGFEDCBA");
  await userEvent.click(page.getByRole("button", { name: "Replace" }));
  await eventually(() =>
    expect(fakeTelegram.configures.at(-1)).toEqual({
      botToken: "654321:ZYXWVUTSRQPONMLKJIHGFEDCBA",
    }),
  );

  await userEvent.click(page.getByRole("button", { name: "Remove token" }));
  await eventually(() => expect(fakeTelegram.configures.at(-1)).toEqual({ clearToken: true }));
  await expect.element(page.getByText("Not set")).toBeVisible();
  await expect.element(page.getByRole("switch", { name: "Use Telegram" })).not.toBeChecked();
});

it("adds and removes user ids, sending the full list each time", async () => {
  resetFakeTelegram({ allowedUserIds: ["111"] });
  await using _screen = await openTelegram();
  await userEvent.fill(page.getByLabelText("Telegram user ids"), "222");
  await userEvent.click(page.getByRole("button", { name: "Add" }));
  await eventually(() =>
    expect(fakeTelegram.configures.at(-1)).toEqual({ allowedUserIds: ["111", "222"] }),
  );
  await userEvent.click(page.getByRole("button", { name: "Remove 111" }));
  await eventually(() =>
    expect(fakeTelegram.configures.at(-1)).toEqual({ allowedUserIds: ["222"] }),
  );
  await userEvent.click(page.getByRole("button", { name: "Remove 222" }));
  await expect.element(page.getByText("No user ids yet")).toBeVisible();
});

it("ignores a repeated id and shows the server's refusal where it happened", async () => {
  resetFakeTelegram({ allowedUserIds: ["111"] });
  await using _screen = await openTelegram();
  const field = page.getByLabelText("Telegram user ids");
  await userEvent.fill(field, "111");
  await userEvent.click(page.getByRole("button", { name: "Add" }));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("That one is already on the list.");
  expect(fakeTelegram.configures).toEqual([]);

  fakeTelegram.failConfigure = "invalid_user_id";
  await userEvent.fill(field, "999");
  await userEvent.click(page.getByRole("button", { name: "Add" }));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("A Telegram user id is a number, such as 123456789.");
  await expect.element(field).toHaveValue("999");

  await userEvent.click(page.getByRole("button", { name: "Remove 111" }));
  await eventually(() => expect(fakeTelegram.configures).toHaveLength(2));

  fakeTelegram.failConfigure = "invalid_token";
  await userEvent.fill(page.getByLabelText("Bot token"), "nope");
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await expect
    .element(page.getByText("That does not look like a bot token. Copy it from @BotFather."))
    .toBeVisible();
  await expect.element(page.getByLabelText("Bot token")).toHaveValue("nope");
});

it("shows the server's refusal on the switch", async () => {
  resetFakeTelegram({ tokenConfigured: true, allowedUserIds: ["111"] });
  fakeTelegram.failConfigure = "persistence_failed";
  await using _screen = await openTelegram();
  await userEvent.click(page.getByRole("switch", { name: "Use Telegram" }));
  await expect.element(page.getByText("Could not save the Telegram settings.")).toBeVisible();
});
