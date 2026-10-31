import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  fakeSlack,
  installFakeEnvironment,
  publishSlackStatus,
  resetFakeSlack,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { SLACK_APP_MANIFEST } from "./SlackSettings.logic";

// Only the socket is fake, as in the assistants tests: the page, hooks, atoms and commands are the app's.
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

installFakeEnvironment([threadWithHistory("thread-a", 2)], { slackChannel: true });
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });

async function openSlack() {
  const router = getRouter(createMemoryHistory({ initialEntries: ["/settings/slack"] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  return render(<AppRoot router={router} />, { container, router: false });
}

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const BOTH_TOKENS = { hasAppToken: true, hasBotToken: true } as const;

it("shows the live status in words and the last delivery failure", async () => {
  using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
  resetFakeSlack({ ...BOTH_TOKENS, enabled: true, status: "error", lastError: "token_revoked" });
  await using _screen = await openSlack();
  await expect.element(page.getByText("Slack revoked a token", { exact: false })).toBeVisible();
  await expect
    .element(page.getByRole("navigation", { name: "Settings sections" }).getByText("Slack"))
    .toBeVisible();

  publishSlackStatus({
    status: "connected",
    teamId: "T0000000001",
    lastDeliveryError: { code: "not_in_channel", at: ago(60_000) },
  });
  await expect.element(page.getByText("Connected to T0000000001")).toBeVisible();
  await expect
    .element(page.getByText("the bot is not in that channel", { exact: false }))
    .toBeVisible();

  publishSlackStatus({ status: "reconnecting" });
  await expect.element(page.getByText("Reconnecting…")).toBeVisible();
});

it("keeps the switch off until both tokens are saved, then enables Slack", async () => {
  resetFakeSlack({ hasAppToken: true });
  await using _screen = await openSlack();
  const toggle = page.getByRole("switch", { name: "Use Slack" });
  await expect.element(toggle).toBeDisabled();
  await expect.element(page.getByText("Save both tokens below", { exact: false })).toBeVisible();

  await userEvent.fill(page.getByLabelText("Bot token"), "xoxb-1");
  await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
  await eventually(() => expect(fakeSlack.configures).toEqual([{ botToken: "xoxb-1" }]));
  await expect.element(toggle).toBeEnabled();

  await userEvent.click(toggle);
  await eventually(() => expect(fakeSlack.configures.at(-1)).toEqual({ enabled: true }));
});

it("sends only the tokens that were typed and marks them saved", async () => {
  resetFakeSlack();
  await using _screen = await openSlack();
  expect(page.getByText("Saved", { exact: true }).query()).toBeNull();
  await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await userEvent.fill(page.getByLabelText("App token"), "xapp-1");
  await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
  await eventually(() => expect(fakeSlack.configures).toEqual([{ appToken: "xapp-1" }]));
  await expect.element(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect.element(page.getByLabelText("App token")).toHaveValue("");
});

it("shows Slack's refusal and does not mark the token saved", async () => {
  resetFakeSlack();
  fakeSlack.failConfigure = "invalid_token";
  await using _screen = await openSlack();
  await userEvent.fill(page.getByLabelText("Bot token"), "xoxb-bad");
  await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
  await expect.element(page.getByText("Slack rejected this token")).toBeVisible();
  expect(page.getByText("Saved", { exact: true }).query()).toBeNull();
  await expect.element(page.getByLabelText("Bot token")).toHaveValue("xoxb-bad");
});

it("asks before removing the tokens", async () => {
  resetFakeSlack(BOTH_TOKENS);
  await using _screen = await openSlack();
  await userEvent.click(page.getByRole("button", { name: "Remove tokens" }));
  await userEvent.click(page.getByRole("button", { name: "Cancel" }));
  expect(fakeSlack.disconnects).toBe(0);

  await userEvent.click(page.getByRole("button", { name: "Remove tokens" }));
  await userEvent.click(page.getByRole("button", { name: "Confirm" }));
  await eventually(() => expect(fakeSlack.disconnects).toBe(1));
  await expect.element(page.getByRole("switch", { name: "Use Slack" })).toBeDisabled();
});

it("validates a channel id, saves the list and removes a channel", async () => {
  resetFakeSlack({ allowedChannelIds: ["C0000000001" as never] });
  await using _screen = await openSlack();
  await userEvent.fill(page.getByLabelText("Channel ID"), "general");
  await userEvent.click(page.getByRole("button", { name: "Add" }));
  await expect
    .element(page.getByText("Enter a channel ID such as", { exact: false }))
    .toBeVisible();
  await userEvent.fill(page.getByLabelText("Channel ID"), "c0000000001");
  await userEvent.click(page.getByRole("button", { name: "Add" }));
  await expect.element(page.getByText("already on the list", { exact: false })).toBeVisible();
  expect(fakeSlack.configures).toEqual([]);

  await userEvent.fill(page.getByLabelText("Channel ID"), "c0000000002");
  await userEvent.click(page.getByRole("button", { name: "Add" }));
  await eventually(() =>
    expect(fakeSlack.configures).toEqual([{ allowedChannelIds: ["C0000000001", "C0000000002"] }]),
  );
  await expect.element(page.getByText("C0000000002")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Remove C0000000001" }));
  await eventually(() =>
    expect(fakeSlack.configures.at(-1)).toEqual({ allowedChannelIds: ["C0000000002"] }),
  );
});

it("shows a link code with how to use it", async () => {
  using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
  resetFakeSlack(BOTH_TOKENS);
  fakeSlack.linkCode = {
    code: "K7P2QX",
    expiresAt: ago(-10 * 60_000),
  };
  await using _screen = await openSlack();
  await expect.element(page.getByText("No linked accounts")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Link your Slack account" }));
  await expect.element(page.getByLabelText("Link code")).toHaveTextContent("K7P2QX");
  await expect.element(page.getByText("link K7P2QX")).toBeVisible();
  await expect
    .element(page.getByText("to the bot in a direct message", { exact: false }))
    .toBeVisible();
  await expect.element(page.getByText("expires in 10 minutes", { exact: false })).toBeVisible();
});

it("lists linked accounts and unlinks one", async () => {
  using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
  resetFakeSlack(BOTH_TOKENS);
  fakeSlack.identities = [
    {
      connectionId: fakeSlack.settings.connectionId,
      externalActorId: "U0000000001",
      displayName: "Ada",
      linkedAt: ago(3 * 86_400_000),
    },
  ];
  await using _screen = await openSlack();
  await expect.element(page.getByText("Slack user U0000000001")).toBeVisible();
  await expect.element(page.getByText("Ada · Linked 3d ago")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Unlink U0000000001" }));
  await eventually(() =>
    expect(fakeSlack.unlinks).toMatchObject([{ externalActorId: "U0000000001" }]),
  );
  await expect.element(page.getByText("No linked accounts")).toBeVisible();
});

it("copies the app manifest", async () => {
  resetFakeSlack();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await using _screen = await openSlack();
  await userEvent.click(page.getByRole("button", { name: "Create the Slack app" }));
  await expect.element(page.getByText("connections:write", { exact: false })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Copy manifest" }));
  await eventually(() => expect(writeText).toHaveBeenCalledWith(SLACK_APP_MANIFEST));
  await expect.element(page.getByRole("button", { name: "Copied" })).toBeVisible();
});
