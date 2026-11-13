import type {
  AssistantIntegrations,
  DesktopBridge,
  DesktopIntegrationCallbackResult,
  DetectedServer,
  IntegrationBeginConnectInput,
  IntegrationBeginConnectResult,
  IntegrationCatalogEntry,
  IntegrationMakeAvailableResult,
  IntegrationsState,
  IntegrationView,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import type { IntegrationActions, IntegrationReply } from "../../state/integrations";
import { toastManager } from "../ui/toast";
import { IntegrationsDirectory } from "./IntegrationsDirectory";

const entry = (
  id: string,
  name: string,
  extra: Partial<IntegrationCatalogEntry> = {},
): IntegrationCatalogEntry =>
  ({
    id,
    name,
    category: "tasks",
    description: `${name} tools`,
    docsUrl: "https://example.com",
    server: { transport: "http", url: `https://${id}.example.com/mcp` },
    auth: { kind: "oauth", registration: "dynamic" },
    match: { urls: [], packages: [], names: [] },
    ...extra,
  }) as IntegrationCatalogEntry;

const view = (
  name: string,
  status: IntegrationView["status"],
  extra: Partial<IntegrationView> = {},
): IntegrationView =>
  ({
    name,
    catalogId: name,
    auth: "oauth",
    status,
    availability: "assistants",
    ...extra,
  }) as IntegrationView;

const detected = (id: string, extra: Partial<DetectedServer>): DetectedServer =>
  ({
    id,
    name: id,
    origin: "claude-code",
    catalogId: null,
    transport: "http",
    enabled: true,
    copyable: false,
    secretKeys: [],
    needsValue: [],
    ...extra,
  }) as DetectedServer;

const CATALOG = [
  entry("linear", "Linear"),
  entry("notion", "Notion", { category: "docs" }),
  entry("google-calendar", "Google Calendar", {
    category: "calendar",
    auth: {
      kind: "oauth",
      registration: "own-app",
      clientGroup: "google",
      setupUrl: "https://console.example.com/credentials",
    },
  }),
  entry("github", "GitHub", {
    category: "dev",
    auth: {
      kind: "token",
      header: "Authorization",
      format: "Bearer {token}",
      tokenUrl: "https://github.example.com/tokens",
    },
  }),
];

const state = (partial: Partial<IntegrationsState> = {}): IntegrationsState => ({
  catalog: CATALOG,
  integrations: [],
  ownApps: [],
  loopbackRedirectUri: "http://127.0.0.1:43110/integrations/callback",
  detected: [],
  detectionSources: [],
  ...partial,
});

const begun = (
  name: string,
  mode: IntegrationBeginConnectResult["mode"],
  flowId = `flow-${name}`,
): IntegrationBeginConnectResult => ({
  flowId,
  name,
  authorizationUrl: `https://auth.example.com/${name}?state=s`,
  mode,
  redirectUri:
    mode === "server"
      ? "http://localhost/oauth/integrations/callback"
      : "http://127.0.0.1:43110/integrations/callback",
  expiresAt: Number.MAX_SAFE_INTEGER,
});

const ok = <A,>(value: A): IntegrationReply<A> => ({ ok: true, value });
const refused = (reason: string): IntegrationReply<never> => ({ ok: false, reason });

function makeActions() {
  return {
    canAct: true,
    beginConnect: vi.fn(async (_input: IntegrationBeginConnectInput) =>
      ok(begun("notion", "server")),
    ),
    completeConnect: vi.fn(async (_input: { flowId: string; callbackUrl: string }) =>
      ok(view("notion", "connected")),
    ),
    cancelConnect: vi.fn(async (_flowId: string) => ok(undefined)),
    disconnect: vi.fn(async (_name: string) => ok(undefined)),
    saveToken: vi.fn(async (_catalogId: string, _token: string) => ok(view("github", "connected"))),
    saveOwnApp: vi.fn(async (_input: { clientGroup: string; clientId: string }) => ok(undefined)),
    removeOwnApp: vi.fn(async (_group: string) => ok(undefined)),
    update: vi.fn(async (_input: { name: string; availability: "assistants" | "all" }) =>
      ok(view("linear", "connected")),
    ),
    makeAvailable: vi.fn(
      async (_detectedId: string): Promise<IntegrationReply<IntegrationMakeAvailableResult>> =>
        ok({ outcome: "copied", name: "docs", leftOut: [] }),
    ),
  } satisfies IntegrationActions;
}

const ASSISTANTS: ReadonlyArray<{ name: string; integrations: AssistantIntegrations }> = [
  { name: "Jarvis", integrations: { mode: "all" } },
  { name: "Scout", integrations: { mode: "selected", names: ["notion"] } },
];

type Harness = ReturnType<typeof setup>;

const ui = (current: IntegrationsState, { actions, customServers, chooseAssistants }: Harness) => (
  <IntegrationsDirectory
    state={current}
    actions={actions}
    assistants={ASSISTANTS}
    providers={[
      { displayName: "Claude", driverKind: "claudeAgent" },
      { displayName: "OpenCode", driverKind: "opencode" },
    ]}
    onCustomServers={customServers}
    onChooseAssistants={chooseAssistants}
  />
);

const mount = (current: IntegrationsState, harness: Harness) =>
  render(ui(current, harness), { router: false }); // the directory takes navigation as callbacks

const row = (name: string) => page.getByTestId("integration-row").filter({ hasText: name });

function fakeTab() {
  return { close: vi.fn(), opener: {} as unknown, location: { href: "" } };
}

function withBridge(bridge: Partial<DesktopBridge>): Disposable {
  window.desktopBridge = bridge as DesktopBridge;
  return {
    [Symbol.dispose]: () => {
      delete window.desktopBridge;
    },
  };
}

function setup() {
  return { actions: makeActions(), customServers: vi.fn(), chooseAssistants: vi.fn() };
}

it("sorts rows into sections, filters by search and category, and shows source notes", async () => {
  const harness = setup();
  await using _screen = await mount(
    state({
      integrations: [view("linear", "connected")],
      detected: [
        detected("local-docs", { origin: "t3", url: "http://localhost:9000/mcp" }),
        detected("scratch", { url: "https://scratch.example.com/mcp" }),
      ],
      detectionSources: [
        {
          origin: "codex",
          path: "/home/me/.codex/config.toml",
          status: "unreadable",
          reason: "invalid-format",
        },
        { origin: "claude-ai", status: "not-seen" },
      ],
    }),
    harness,
  );
  await expect.element(page.getByRole("heading", { name: "Connected" })).toBeVisible();
  await expect.element(row("Linear").getByText("Connected", { exact: true })).toBeVisible();
  await expect.element(row("Notion").getByRole("button", { name: "Connect" })).toBeVisible();
  await expect.element(page.getByText("Added in T3")).toBeVisible();
  await expect
    .element(page.getByText("Couldn't read /home/me/.codex/config.toml: Not valid JSON or TOML"))
    .toBeVisible();
  await expect.element(page.getByText("Not seen yet (open a Claude conversation)")).toBeVisible();
  // A row with nothing to do is not a button.
  expect(row("scratch").getByRole("button").query()).toBeNull();

  await userEvent.click(row("local-docs").getByRole("button", { name: /local-docs/ }));
  expect(harness.customServers).toHaveBeenCalledTimes(1);
  await userEvent.click(page.getByRole("button", { name: "Add custom server" }));
  expect(harness.customServers).toHaveBeenCalledTimes(2);

  await userEvent.click(page.getByRole("button", { name: "Docs", exact: true }));
  await expect.element(row("Notion")).toBeVisible();
  expect(row("Linear").query()).toBeNull();
  await userEvent.click(page.getByRole("button", { name: "All", exact: true }));
  await userEvent.fill(page.getByRole("searchbox", { name: "Search integrations" }), "lin");
  await expect.element(row("Linear")).toBeVisible();
  expect(row("Notion").query()).toBeNull();
});

it("server mode opens the sign-in tab during the click, waits, and offers assistants once connected", async () => {
  const harness = setup();
  const { actions } = harness;
  const tab = fakeTab();
  using open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  using toast = vi.spyOn(toastManager, "add");
  await using screen = await mount(state(), harness);
  await userEvent.click(row("Notion").getByRole("button", { name: "Connect" }));
  expect(open).toHaveBeenCalledWith("", "_blank");
  await vi.waitFor(() => expect(tab.location.href).toBe("https://auth.example.com/notion?state=s"));
  expect(tab.opener).toBeNull();
  expect(actions.beginConnect).toHaveBeenCalledWith({
    catalogId: "notion",
    client: { kind: "web", origin: window.location.origin },
  });

  await screen.rerender(ui(state({ integrations: [view("notion", "connecting")] }), harness));
  await expect.element(row("Notion").getByText("Waiting for sign-in…")).toBeVisible();
  await expect.element(row("Notion").getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(toast).not.toHaveBeenCalled();

  await screen.rerender(ui(state({ integrations: [view("notion", "connected")] }), harness));
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Choose which assistants use it", description: "Notion" }),
    ),
  );
  const [{ actionProps }] = toast.mock.calls[0] as [{ actionProps: { onClick: () => void } }];
  actionProps.onClick();
  expect(harness.chooseAssistants).toHaveBeenCalled();
  // Another push of the same state does not announce it twice.
  await screen.rerender(ui(state({ integrations: [view("notion", "connected")] }), harness));
  expect(toast).toHaveBeenCalledTimes(1);
});

it("cancels a pending sign-in it started, and cannot cancel one it did not", async () => {
  const harness = setup();
  const { actions } = harness;
  using _open = vi.spyOn(window, "open").mockReturnValue(fakeTab() as unknown as Window);
  await using screen = await mount(
    state({ integrations: [view("linear", "connecting")] }),
    harness,
  );
  await expect.element(row("Linear").getByRole("button", { name: "Cancel" })).toBeDisabled();
  await userEvent.click(row("Notion").getByRole("button", { name: "Connect" }));
  await vi.waitFor(() => expect(actions.beginConnect).toHaveBeenCalled());
  await screen.rerender(
    ui(
      state({ integrations: [view("linear", "connecting"), view("notion", "connecting")] }),
      harness,
    ),
  );
  await userEvent.click(row("Notion").getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() => expect(actions.cancelConnect).toHaveBeenCalledWith("flow-notion"));
});

it("paste mode parses the pasted address, completes the flow, and cancels it when closed", async () => {
  const harness = setup();
  const { actions } = harness;
  actions.beginConnect.mockResolvedValue(ok(begun("notion", "paste")));
  using _open = vi.spyOn(window, "open").mockReturnValue(fakeTab() as unknown as Window);
  using toast = vi.spyOn(toastManager, "add");
  await using _screen = await mount(state(), harness);
  await userEvent.click(row("Notion").getByRole("button", { name: "Connect" }));
  const field = page.getByLabelText("Paste the address from the browser");
  await userEvent.fill(field, "not an address");
  await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Connect" }));
  await expect.element(page.getByText("Sign-in expired or didn't match. Try again")).toBeVisible();
  expect(actions.completeConnect).not.toHaveBeenCalled();

  actions.completeConnect.mockResolvedValueOnce(refused("exchange-failed"));
  const pasted = "http://127.0.0.1:43110/integrations/callback?code=abc&state=s";
  await userEvent.fill(field, pasted);
  await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Connect" }));
  await expect.element(page.getByText("Sign-in didn't finish. Try again")).toBeVisible();
  await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Connect" }));
  await vi.waitFor(() =>
    expect(actions.completeConnect).toHaveBeenLastCalledWith({
      flowId: "flow-notion",
      callbackUrl: pasted,
    }),
  );
  await vi.waitFor(() => expect(page.getByRole("dialog").query()).toBeNull());
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Choose which assistants use it" }),
  );
  expect(actions.cancelConnect).not.toHaveBeenCalled();

  await userEvent.click(row("Notion").getByRole("button", { name: "Connect" }));
  await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() => expect(actions.cancelConnect).toHaveBeenCalledWith("flow-notion"));
});

it("desktop listens on loopback, completes with the received address, and opens no tab", async () => {
  const harness = setup();
  const { actions } = harness;
  actions.beginConnect.mockResolvedValue(ok(begun("notion", "loopback")));
  const callbackUrl = "http://127.0.0.1:43110/integrations/callback?code=abc&state=s";
  const receive = vi.fn(async (_input: unknown): Promise<DesktopIntegrationCallbackResult> => ({
    status: "received",
    callbackUrl,
  }));
  using _bridge = withBridge({ receiveIntegrationCallback: receive });
  using open = vi.spyOn(window, "open");
  using toast = vi.spyOn(toastManager, "add");
  await using _screen = await mount(state(), harness);
  await userEvent.click(row("Notion").getByRole("button", { name: "Connect" }));
  await vi.waitFor(() =>
    expect(actions.completeConnect).toHaveBeenCalledWith({ flowId: "flow-notion", callbackUrl }),
  );
  expect(actions.beginConnect).toHaveBeenCalledWith({
    catalogId: "notion",
    client: { kind: "desktop", loopback: true },
  });
  expect(receive).toHaveBeenCalledWith({
    authorizationUrl: "https://auth.example.com/notion?state=s",
    redirectUri: "http://127.0.0.1:43110/integrations/callback",
  });
  expect(open).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Choose which assistants use it" }),
  );
});

it("desktop retries once on a busy port, and cancels a flow the browser abandoned", async () => {
  const harness = setup();
  const { actions } = harness;
  actions.beginConnect
    .mockResolvedValueOnce(ok(begun("notion", "loopback", "flow-1")))
    .mockResolvedValueOnce(ok(begun("notion", "loopback", "flow-2")))
    .mockResolvedValueOnce(ok(begun("notion", "loopback", "flow-3")));
  const receive = vi
    .fn(async (_input: unknown): Promise<DesktopIntegrationCallbackResult> => ({
      status: "cancelled",
    }))
    .mockResolvedValueOnce({ status: "port-busy" })
    .mockResolvedValueOnce({ status: "received", callbackUrl: "http://127.0.0.1:1/x?code=1" })
    .mockResolvedValueOnce({ status: "expired" });
  const cancel = vi.fn(async () => {});
  using _bridge = withBridge({
    receiveIntegrationCallback: receive,
    cancelIntegrationCallback: cancel,
  });
  using toast = vi.spyOn(toastManager, "add");
  await using screen = await mount(state(), harness);
  await userEvent.click(row("Notion").getByRole("button", { name: "Connect" }));
  await vi.waitFor(() =>
    expect(actions.completeConnect).toHaveBeenCalledWith({
      flowId: "flow-2",
      callbackUrl: "http://127.0.0.1:1/x?code=1",
    }),
  );
  expect(actions.cancelConnect).toHaveBeenCalledWith("flow-1");
  expect(actions.beginConnect).toHaveBeenLastCalledWith({
    catalogId: "notion",
    client: { kind: "desktop", loopback: true, loopbackBusy: true },
  });

  await screen.rerender(ui(state(), harness));
  await userEvent.click(row("Notion").getByRole("button", { name: "Connect" }));
  await vi.waitFor(() => expect(actions.cancelConnect).toHaveBeenCalledWith("flow-3"));
  expect(toast).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "error", title: "Sign-in expired or didn't match. Try again" }),
  );
});

it("desktop Cancel stops the loopback listener, which ends the flow on the server", async () => {
  const harness = setup();
  const { actions } = harness;
  actions.beginConnect.mockResolvedValue(ok(begun("notion", "loopback")));
  let settle: (result: DesktopIntegrationCallbackResult) => void = () => {};
  const receive = vi.fn(
    (_input: unknown) =>
      new Promise<DesktopIntegrationCallbackResult>((resolve) => {
        settle = resolve;
      }),
  );
  const stop = vi.fn(async () => settle({ status: "cancelled" }));
  using _bridge = withBridge({
    receiveIntegrationCallback: receive,
    cancelIntegrationCallback: stop,
  });
  using toast = vi.spyOn(toastManager, "add");
  await using screen = await mount(state(), harness);
  await userEvent.click(row("Notion").getByRole("button", { name: "Connect" }));
  await vi.waitFor(() => expect(receive).toHaveBeenCalled());
  await screen.rerender(ui(state({ integrations: [view("notion", "connecting")] }), harness));
  await userEvent.click(row("Notion").getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() => expect(actions.cancelConnect).toHaveBeenCalledWith("flow-notion"));
  expect(stop).toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it("a refused connect explains why, and own-app-required opens the own-app form", async () => {
  const harness = setup();
  const { actions } = harness;
  const tab = fakeTab();
  using _open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  using toast = vi.spyOn(toastManager, "add");
  actions.beginConnect.mockResolvedValueOnce(refused("registration-failed"));
  // Saved here, but gone on the server by the time the sign-in starts.
  await using _screen = await mount(
    state({ ownApps: [{ clientGroup: "google", clientId: "client-1", hasClientSecret: false }] }),
    harness,
  );
  await userEvent.click(row("Notion").getByRole("button", { name: "Connect" }));
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith({ type: "error", title: "Notion refused T3's sign-in" }),
  );
  expect(tab.close).toHaveBeenCalled();
  actions.beginConnect.mockResolvedValueOnce(refused("own-app-required"));
  await userEvent.click(row("Google Calendar").getByRole("button", { name: "Connect" }));
  await expect.element(page.getByRole("heading", { name: "Use your own app" })).toBeVisible();
});

it("own app: lists redirect URIs, saves the client, then continues the sign-in", async () => {
  const harness = setup();
  const { actions } = harness;
  actions.beginConnect.mockResolvedValue(ok(begun("google-calendar", "server")));
  const tab = fakeTab();
  using _open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  await using _screen = await mount(state(), harness);
  await userEvent.click(row("Google Calendar").getByRole("button", { name: "Connect" }));
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByText("Redirect URIs to register")).toBeVisible();
  await expect
    .element(dialog.getByText("http://127.0.0.1:43110/integrations/callback"))
    .toBeVisible();
  await expect
    .element(dialog.getByText(`${window.location.origin}/oauth/integrations/callback`))
    .toBeVisible();
  await expect
    .element(dialog.getByRole("link", { name: "https://console.example.com/credentials" }))
    .toHaveAttribute("href", "https://console.example.com/credentials");
  expect(dialog.getByRole("button", { name: "Remove app" }).query()).toBeNull();
  await userEvent.fill(dialog.getByLabelText("Client ID"), " client-1 ");
  await userEvent.fill(dialog.getByLabelText("Client secret"), "s3cret");
  await userEvent.click(dialog.getByRole("button", { name: "Save" }));
  await vi.waitFor(() =>
    expect(actions.saveOwnApp).toHaveBeenCalledWith({
      clientGroup: "google",
      clientId: "client-1",
      clientSecret: "s3cret",
    }),
  );
  await vi.waitFor(() =>
    expect(actions.beginConnect).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: "google-calendar" }),
    ),
  );
  await vi.waitFor(() =>
    expect(tab.location.href).toBe("https://auth.example.com/google-calendar?state=s"),
  );
});

it("own app: a saved secret stays unless retyped, and Remove app removes the client", async () => {
  const harness = setup();
  const { actions } = harness;
  await using _screen = await mount(
    state({ ownApps: [{ clientGroup: "google", clientId: "client-1", hasClientSecret: true }] }),
    harness,
  );
  await userEvent.click(page.getByRole("button", { name: "More actions for Google Calendar" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Use your own app" }));
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByLabelText("Client ID")).toHaveValue("client-1");
  await expect.element(dialog.getByLabelText("Client secret")).toHaveValue("");
  await expect.element(dialog.getByText("Saved", { exact: true })).toBeVisible();
  await userEvent.click(dialog.getByRole("button", { name: "Save" }));
  await vi.waitFor(() =>
    expect(actions.saveOwnApp).toHaveBeenCalledWith({
      clientGroup: "google",
      clientId: "client-1",
    }),
  );
  expect(actions.beginConnect).not.toHaveBeenCalled();

  await userEvent.click(page.getByRole("button", { name: "More actions for Google Calendar" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Use your own app" }));
  await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Remove app" }));
  await vi.waitFor(() => expect(actions.removeOwnApp).toHaveBeenCalledWith("google"));
});

it("token: the write-only field saves to the server, and a refusal stays in the form", async () => {
  const harness = setup();
  const { actions } = harness;
  using toast = vi.spyOn(toastManager, "add");
  await using _screen = await mount(state(), harness);
  await userEvent.click(row("GitHub").getByRole("button", { name: "Connect" }));
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByLabelText("Token")).toHaveAttribute("type", "password");
  await expect
    .element(dialog.getByRole("link", { name: "Create a token" }))
    .toHaveAttribute("href", "https://github.example.com/tokens");
  actions.saveToken.mockResolvedValueOnce(refused("invalid-token"));
  await userEvent.fill(dialog.getByLabelText("Token"), " ghp_x ");
  await userEvent.click(dialog.getByRole("button", { name: "Connect" }));
  await expect.element(dialog.getByText("GitHub didn't accept this token")).toBeVisible();
  await userEvent.click(dialog.getByRole("button", { name: "Connect" }));
  await vi.waitFor(() => expect(page.getByRole("dialog").query()).toBeNull());
  expect(actions.saveToken).toHaveBeenLastCalledWith("github", "ghp_x");
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Choose which assistants use it", description: "GitHub" }),
  );
  expect(actions.beginConnect).not.toHaveBeenCalled();
});

it("make available names what it copies, and a connect outcome starts Connect for the entry", async () => {
  const harness = setup();
  const { actions } = harness;
  using _open = vi.spyOn(window, "open").mockReturnValue(fakeTab() as unknown as Window);
  const server = detected("scratch", {
    url: "https://scratch.example.com/mcp",
    copyable: true,
    secretKeys: ["Authorization"],
    needsValue: ["API_KEY"],
  });
  await using _screen = await mount(state({ detected: [server] }), harness);
  await userEvent.click(page.getByRole("button", { name: "More actions for scratch" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Make available to all providers" }));
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByText("https://scratch.example.com/mcp")).toBeVisible();
  await expect.element(dialog.getByText("Values saved as T3 secrets")).toBeVisible();
  await expect.element(dialog.getByText("Authorization")).toBeVisible();
  await expect.element(dialog.getByText("Left out (with ${...})")).toBeVisible();
  await expect.element(dialog.getByText("API_KEY")).toBeVisible();
  actions.makeAvailable.mockResolvedValueOnce(refused("url-not-allowed"));
  await userEvent.click(dialog.getByRole("button", { name: "Make available to all providers" }));
  await expect
    .element(dialog.getByText("T3 only copies https addresses without ? or #"))
    .toBeVisible();
  actions.makeAvailable.mockResolvedValueOnce(ok({ outcome: "connect", catalogId: "notion" }));
  await userEvent.click(dialog.getByRole("button", { name: "Make available to all providers" }));
  await vi.waitFor(() =>
    expect(actions.beginConnect).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: "notion" }),
    ),
  );
  expect(actions.makeAvailable).toHaveBeenCalledWith("scratch");
});

it("the detail sheet shows the connection and changes who can use it", async () => {
  const harness = setup();
  const { actions } = harness;
  await using _screen = await mount(
    state({
      integrations: [
        view("linear", "connected", { expiresAt: Date.UTC(2026, 10, 20), scope: "read write" }),
      ],
    }),
    harness,
  );
  await userEvent.click(row("Linear").getByRole("button", { name: /Linear tools/ }));
  const sheet = page.getByRole("dialog");
  await expect.element(sheet.getByText("Expires")).toBeVisible();
  await expect.element(sheet.getByText("read write")).toBeVisible();
  await expect.element(sheet.getByText("Claude", { exact: true })).toBeVisible();
  await expect.element(sheet.getByText("Not available on OpenCode")).toBeVisible();
  await expect.element(sheet.getByText("Jarvis")).toBeVisible();
  expect(sheet.getByText("Scout").query()).toBeNull();
  await expect.element(sheet.getByRole("radio", { name: "Assistants only" })).toBeChecked();
  await userEvent.click(sheet.getByRole("radio", { name: "All threads" }));
  await vi.waitFor(() =>
    expect(actions.update).toHaveBeenCalledWith({ name: "linear", availability: "all" }),
  );
});

it("disconnect asks first, counting the assistants that lose it", async () => {
  const harness = setup();
  const { actions } = harness;
  await using _screen = await mount(
    state({ integrations: [view("notion", "connected")] }),
    harness,
  );
  await userEvent.click(row("Notion").getByRole("button", { name: /Notion tools/ }));
  await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Disconnect" }));
  const confirm = page.getByRole("alertdialog");
  await expect.element(confirm.getByText("Disconnect Notion?")).toBeVisible();
  await expect.element(confirm.getByText("Assistants using it: 2")).toBeVisible();
  expect(actions.disconnect).not.toHaveBeenCalled();
  actions.disconnect.mockResolvedValueOnce(refused("storage-failed"));
  await userEvent.click(confirm.getByRole("button", { name: "Disconnect" }));
  await expect.element(confirm.getByText("Couldn't save on the server")).toBeVisible();
  await userEvent.click(confirm.getByRole("button", { name: "Disconnect" }));
  await vi.waitFor(() => expect(page.getByRole("alertdialog").query()).toBeNull());
  expect(actions.disconnect).toHaveBeenLastCalledWith("notion");

  await userEvent.click(page.getByRole("button", { name: "More actions for Notion" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Disconnect" }));
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
});
