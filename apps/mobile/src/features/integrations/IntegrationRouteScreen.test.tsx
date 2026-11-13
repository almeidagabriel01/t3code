import { RegistryContext } from "@effect/atom-react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    state: null as unknown,
    navigate: vi.fn(),
    goBack: vi.fn(),
    alert: vi.fn(),
    openURL: vi.fn(),
    copy: vi.fn(),
    authSession: vi.fn(),
    actions: {} as Record<string, ReturnType<typeof vi.fn>>,
    assistants: [] as unknown[],
    providers: [] as unknown[],
    baseUrl: "https://box.tail.ts.net" as string | null,
  },
}));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Keyboard: { dismiss: vi.fn() },
  Linking: { openURL: (url: string) => mocks.openURL(url) },
}));
vi.mock("react-native-svg", () => ({ default: Children, Path: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { scheme: "t3code-preview" } } }));
vi.mock("expo-clipboard", () => ({ setStringAsync: (value: string) => mocks.copy(value) }));
vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: (...args: unknown[]) => mocks.authSession(...args),
  openBrowserAsync: vi.fn(),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate, goBack: mocks.goBack }),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/IconButton", () => ({
  IconButton: (props: { accessibilityLabel: string; onPress: () => void }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress} />
  ),
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string; detail?: string }) => (
    <p>
      {props.label}|{props.detail ?? props.description}
    </p>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { title?: string; children?: ReactNode }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (...args: unknown[]) => mocks.alert(...args),
}));
vi.mock("../assistants/AssistantFormFields", () => ({
  ChoiceRow: (props: { label: string; selected: boolean; onPress: () => void }) => (
    <button aria-label={props.label} aria-checked={props.selected} onClick={props.onPress} />
  ),
  TextField: (props: {
    label: string;
    value: string;
    placeholder?: string;
    secure?: boolean;
    onChange: (value: string) => void;
  }) => (
    <input
      aria-label={props.label}
      type={props.secure ? "password" : "text"}
      placeholder={props.placeholder}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: (props: { title: string; children?: ReactNode }) => (
    <main aria-label={props.title}>{props.children}</main>
  ),
}));
vi.mock("../../lib/attachmentUpload", () => ({
  waitForEnvironmentConnection: async () => mocks.baseUrl,
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({ active: mocks.assistants }),
}));
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => ({ providers: mocks.providers }),
}));
vi.mock("../../state/session", () => ({
  usePreparedConnection: () =>
    mocks.baseUrl === null
      ? { _tag: "None" }
      : { _tag: "Some", value: { httpBaseUrl: mocks.baseUrl } },
}));
vi.mock("../../state/integrations", () => ({
  useIntegrationsState: () => mocks.state,
  useIntegrationActions: () => ({ canAct: true, ...mocks.actions }),
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { pendingFlowsAtom } from "./connectFlow";
import { IntegrationRouteScreen } from "./IntegrationRouteScreen";
import { connectedNoticeAtom, type IntegrationRouteParams } from "./useIntegrationFlows";

const gmail = {
  id: "gmail",
  name: "Gmail",
  category: "email",
  description: "Mail",
  docsUrl: "https://docs.example",
  server: { transport: "http", url: "https://gmail.example/mcp" },
  auth: {
    kind: "oauth",
    registration: "own-app",
    clientGroup: "google",
    setupUrl: "https://console.cloud.google.com/apis/credentials",
  },
  match: { urls: [], packages: [], names: [] },
};
const github = {
  ...gmail,
  id: "github",
  name: "GitHub",
  auth: {
    kind: "token",
    header: "Authorization",
    format: "Bearer {token}",
    tokenUrl: "https://github.com/settings/tokens",
  },
};
const baseState = () => ({
  catalog: [gmail, github],
  integrations: [
    {
      name: "gmail",
      catalogId: "gmail",
      auth: "oauth",
      status: "needs-more-access",
      lastError: "refresh-failed",
      expiresAt: Date.UTC(2026, 10, 20),
      scope: "gmail.readonly",
      availability: "assistants",
    },
  ],
  ownApps: [{ clientGroup: "google", clientId: "client-1", hasClientSecret: true }],
  loopbackRedirectUri: "http://127.0.0.1:9/integrations/callback",
  detected: [],
  detectionSources: [],
});

let root: Root;
let container: HTMLDivElement;
const render = (params: Omit<IntegrationRouteParams, "environmentId">) =>
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <IntegrationRouteScreen route={{ params: { environmentId: "hub", ...params } } as never} />
      </RegistryContext.Provider>,
    ),
  );
const button = (label: string) => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const press = async (label: string) => {
  await act(async () => button(label).click());
};
const input = (label: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const type = (label: string, value: string) =>
  act(() => {
    const field = input(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
const confirmAlert = async (text: string) => {
  const buttons = mocks.alert.mock.calls.at(-1)?.[2] as Array<{
    text: string;
    onPress?: () => void;
  }>;
  await act(async () => buttons.find((item) => item.text === text)?.onPress?.());
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.state = baseState();
  mocks.baseUrl = "https://box.tail.ts.net";
  mocks.assistants = [
    {
      environmentId: "hub",
      assistant: { id: "a1", name: "Jarvis", integrations: { mode: "all" } },
    },
    { environmentId: "else", assistant: { id: "a2", name: "Far", integrations: { mode: "all" } } },
  ];
  mocks.providers = [
    { instanceId: "claudeAgent", driver: "claudeAgent", enabled: true },
    { instanceId: "opencode", driver: "opencode", enabled: true },
    { instanceId: "codex", driver: "codex", enabled: false },
  ];
  for (const fn of [mocks.navigate, mocks.goBack, mocks.alert, mocks.openURL, mocks.copy]) {
    fn.mockReset();
  }
  mocks.copy.mockResolvedValue(true);
  mocks.openURL.mockResolvedValue(true);
  mocks.authSession.mockReset().mockResolvedValue({ type: "cancel" });
  mocks.actions = {
    update: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    disconnect: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    saveOwnApp: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    removeOwnApp: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    saveToken: vi.fn().mockResolvedValue({ ok: true, value: { name: "github" } }),
    beginConnect: vi.fn().mockResolvedValue({ ok: false, reason: "discovery-failed" }),
    completeConnect: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    cancelConnect: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
  appAtomRegistry.set(pendingFlowsAtom, new Map());
  appAtomRegistry.set(connectedNoticeAtom, null);
});
afterEach(() => act(() => root.unmount()));

describe("connected detail", () => {
  it("shows status, expiry, access, providers and the assistants using it", () => {
    render({ form: "detail", name: "gmail" });
    const text = container.textContent ?? "";
    expect(text).toContain("Gmail");
    expect(text).toContain("Needs more access");
    expect(text).toContain("Sign-in didn't finish. Try again");
    expect(text).toContain(`Expires|${new Date(Date.UTC(2026, 10, 20)).toLocaleString()}`);
    expect(text).toContain("Access|gmail.readonly");
    expect(text).toContain("Claude");
    expect(text).toContain("Not available on OpenCode");
    expect(text).not.toContain("Codex");
    expect(container.querySelector('section[aria-label="Used by"]')?.textContent).toBe("Jarvis|");
  });

  it("changes who it is available to and reports a refusal", async () => {
    render({ form: "detail", name: "gmail" });
    expect(button("Assistants only").getAttribute("aria-checked")).toBe("true");
    await press("Assistants only");
    expect(mocks.actions.update).not.toHaveBeenCalled();
    await press("All threads");
    expect(mocks.actions.update).toHaveBeenCalledWith({ name: "gmail", availability: "all" });
    mocks.actions.update!.mockResolvedValue({ ok: false, reason: "storage-failed" });
    await press("All threads");
    expect(container.textContent).toContain("Couldn't save on the server");
  });

  it("opens the own app and disconnects after the confirm", async () => {
    render({ form: "detail", name: "gmail" });
    await press("Use your own app");
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsIntegration", {
      environmentId: "hub",
      form: "own-app",
      catalogId: "gmail",
    });
    await press("Disconnect");
    expect(mocks.alert.mock.calls[0]?.slice(0, 2)).toEqual([
      "Disconnect Gmail?",
      "Assistants using it: 1",
    ]);
    await confirmAlert("Disconnect");
    expect(mocks.actions.disconnect).toHaveBeenCalledWith("gmail");
    expect(mocks.goBack).toHaveBeenCalled();
  });

  it("renders nothing for an integration that is gone, or before the first state", () => {
    render({ form: "detail", name: "missing" });
    expect(container.textContent).toBe("");
    mocks.state = null;
    render({ form: "detail", name: "gmail" });
    expect(container.textContent).toBe("");
  });
});

describe("own app", () => {
  it("lists the redirect URIs to register and copies one", async () => {
    render({ form: "own-app", catalogId: "gmail" });
    expect(container.querySelector("main")?.getAttribute("aria-label")).toBe("Use your own app");
    const uris = container.querySelector('section[aria-label="Redirect URIs to register"]');
    expect(uris?.textContent).toContain("https://box.tail.ts.net/oauth/integrations/callback");
    expect(uris?.textContent).toContain("http://127.0.0.1:9/integrations/callback");
    await press("Copy");
    expect(mocks.copy).toHaveBeenCalledWith("https://box.tail.ts.net/oauth/integrations/callback");
    await press("console.cloud.google.com");
    expect(mocks.openURL).toHaveBeenCalledWith(gmail.auth.setupUrl);
  });

  it("an http connection lists only the loopback address", () => {
    mocks.baseUrl = "http://192.168.1.4:3773";
    render({ form: "own-app", catalogId: "gmail" });
    const uris = container.querySelector('section[aria-label="Redirect URIs to register"]');
    expect(uris?.textContent).not.toContain("192.168");
  });

  it("keeps a saved secret write-only, saves and continues the sign-in", async () => {
    render({ form: "own-app", catalogId: "gmail" });
    expect(input("Client ID").value).toBe("client-1");
    expect(input("Client secret").type).toBe("password");
    expect(input("Client secret").placeholder).toBe("Saved");
    expect(input("Client secret").value).toBe("");
    type("Client ID", " client-2 ");
    await press("Connect");
    expect(mocks.actions.saveOwnApp).toHaveBeenCalledWith({
      clientGroup: "google",
      clientId: "client-2",
    });
    expect(mocks.goBack).toHaveBeenCalled();
    expect(mocks.actions.beginConnect).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: "gmail" }),
    );
    expect(mocks.alert).toHaveBeenLastCalledWith("Couldn't find Gmail's sign-in page");

    type("Client secret", "s3cret");
    mocks.actions.saveOwnApp!.mockResolvedValue({ ok: false, reason: "storage-failed" });
    await press("Connect");
    expect(mocks.actions.saveOwnApp).toHaveBeenLastCalledWith({
      clientGroup: "google",
      clientId: "client-2",
      clientSecret: "s3cret",
    });
    expect(container.textContent).toContain("Couldn't save on the server");
  });

  it("remove app names the integrations that disconnect", async () => {
    render({ form: "own-app", catalogId: "gmail" });
    await press("Remove app");
    expect(mocks.alert.mock.calls[0]?.slice(0, 2)).toEqual(["Remove app", "gmail"]);
    await confirmAlert("Remove app");
    expect(mocks.actions.removeOwnApp).toHaveBeenCalledWith("google");
    expect(mocks.goBack).toHaveBeenCalled();
    mocks.actions.removeOwnApp!.mockResolvedValue({ ok: false, reason: "storage-failed" });
    await press("Remove app");
    await confirmAlert("Remove app");
    expect(container.textContent).toContain("Couldn't save on the server");
  });

  it("a first app has no saved secret and nothing to remove", () => {
    mocks.state = { ...baseState(), ownApps: [], integrations: [] };
    render({ form: "own-app", catalogId: "gmail" });
    expect(input("Client secret").placeholder).toBe("");
    expect(container.textContent).not.toContain("Remove app");
    expect(button("Connect").disabled).toBe(true);
  });
});

describe("token", () => {
  it("links to where the token is made, saves it and offers the assistants", async () => {
    render({ form: "token", catalogId: "github" });
    expect(input("Token").type).toBe("password");
    await press("Create a token");
    expect(mocks.openURL).toHaveBeenCalledWith("https://github.com/settings/tokens");
    type("Token", " ghp_x ");
    await press("Connect");
    expect(mocks.actions.saveToken).toHaveBeenCalledWith("github", "ghp_x");
    expect(appAtomRegistry.get(connectedNoticeAtom)).toEqual({
      environmentId: "hub",
      name: "github",
    });
    expect(mocks.goBack).toHaveBeenCalled();
  });

  it("shows Saved once a token exists and explains a rejected one", async () => {
    mocks.state = {
      ...baseState(),
      integrations: [
        {
          name: "github",
          catalogId: "github",
          auth: "token",
          status: "error",
          availability: "all",
        },
      ],
    };
    mocks.actions.saveToken!.mockResolvedValue({ ok: false, reason: "invalid-token" });
    render({ form: "token", catalogId: "github" });
    expect(input("Token").placeholder).toBe("Saved");
    type("Token", "bad");
    await press("Connect");
    expect(container.textContent).toContain("GitHub didn't accept this token");
    expect(mocks.goBack).not.toHaveBeenCalled();
  });
});

describe("paste", () => {
  const flow = {
    environmentId: "hub",
    catalogId: "gmail",
    flowId: "f9",
    name: "gmail",
    mode: "paste",
    authorizationUrl: "https://auth.example",
  };
  const withFlow = () =>
    appAtomRegistry.set(pendingFlowsAtom, new Map([["hub\u0000gmail", flow as never]]));

  it("says the sign-in expired when this app holds no flow", () => {
    render({ form: "paste", catalogId: "gmail", name: "gmail" });
    expect(container.textContent).toContain("Sign-in expired or didn't match. Try again");
  });

  it("refuses text that is not the browser address, then completes with it", async () => {
    withFlow();
    render({ form: "paste", catalogId: "gmail", name: "gmail" });
    type("Paste the address from the browser", "nope");
    await press("Connect");
    expect(container.textContent).toContain("Sign-in expired or didn't match. Try again");
    expect(mocks.actions.completeConnect).not.toHaveBeenCalled();
    const url = "http://127.0.0.1:9/integrations/callback?code=c&state=s";
    type("Paste the address from the browser", url);
    expect(container.textContent).not.toContain("Sign-in expired");
    await press("Connect");
    expect(mocks.actions.completeConnect).toHaveBeenCalledWith({ flowId: "f9", callbackUrl: url });
    expect(appAtomRegistry.get(connectedNoticeAtom)).toEqual({
      environmentId: "hub",
      name: "gmail",
    });
    expect(mocks.goBack).toHaveBeenCalled();
  });

  it("cancel ends the sign-in on the server", async () => {
    withFlow();
    render({ form: "paste", catalogId: "gmail", name: "gmail" });
    await press("Cancel");
    expect(mocks.actions.cancelConnect).toHaveBeenCalledWith("f9");
    expect(mocks.goBack).toHaveBeenCalled();
  });
});
