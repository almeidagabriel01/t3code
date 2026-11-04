import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    ids: ["mac-a"] as string[],
    data: null as unknown,
    error: null as string | null,
    pending: false,
    can: true,
    refresh: vi.fn(),
    open: vi.fn(),
    asked: [] as unknown[],
  },
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.can }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string }) => <p>{props.title}</p>,
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string; detail?: string }) => (
    <div>
      <span>{props.label}</span>
      <span>{props.description}</span>
      <span>{props.detail}</span>
    </div>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { title?: string; children?: ReactNode }) => (
    <section>
      <h3>{props.title}</h3>
      {props.children}
    </section>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsActionRow", () => ({
  SettingsActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({
    savedConnectionsById: {
      "mac-a": { environmentLabel: "Studio Mac" },
      "mac-b": { environmentLabel: "Office Mac" },
    },
  }),
}));
vi.mock("../../state/macPermissions", () => ({ useMacEnvironmentIds: () => mocks.ids }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.data,
    error: mocks.error,
    isPending: mocks.pending,
    refresh: mocks.refresh,
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    macPermissions: (request: unknown) => {
      mocks.asked.push(request);
      return "permissions-atom";
    },
    openMacSettings: { permissionAtom: () => "permission-atom" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.open }));

import { SettingsMacPermissionsRouteScreen } from "./SettingsMacPermissionsRouteScreen";

let root: Root;
let container: HTMLDivElement;
const render = () => act(() => root.render(<SettingsMacPermissionsRouteScreen />));
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.ids = ["mac-a"];
  mocks.data = {
    supported: true,
    screenRecording: "granted",
    accessibility: "denied",
    automation: "unknown",
  };
  mocks.error = null;
  mocks.pending = false;
  mocks.can = true;
  mocks.refresh.mockReset();
  mocks.open.mockReset();
  mocks.asked = [];
});
afterEach(() => act(() => root.unmount()));

describe("Mac permissions settings", () => {
  it("shows each permission's status, checks again and opens the matching pane", async () => {
    render();
    for (const text of ["Screen Recording", "Granted", "Not granted", "Not checked"]) {
      expect(container.textContent).toContain(text);
    }
    // Opening the page never reads Automation; the first Check again does, the next only refreshes.
    expect(mocks.asked.every((ask) => (ask as any).input.automation === false)).toBe(true);
    await act(async () => button("Check again")!.click());
    expect((mocks.asked.at(-1) as any).input.automation).toBe(true);
    expect(container.textContent).toContain("Unknown");
    await act(async () => button("Check again")!.click());
    expect(mocks.refresh).toHaveBeenCalledOnce();
    await act(async () => button("Open Accessibility settings")!.click());
    expect(mocks.open).toHaveBeenCalledWith({
      environmentId: "mac-a",
      input: { pane: "accessibility" },
    });
  });

  it("disables the actions without the grant and while checking", () => {
    mocks.can = false;
    mocks.pending = true;
    render();
    expect(button("Open Screen Recording settings")!.disabled).toBe(true);
    expect(button("Check again")!.disabled).toBe(true);
  });

  it("says when the status could not be read", () => {
    mocks.data = null;
    mocks.error = "The environment request failed.";
    render();
    expect(container.textContent).toContain("Could not check the permissions");
    expect(container.textContent).toContain("The environment request failed.");
    mocks.error = null;
    render();
    expect(container.textContent).toContain("Checking...");
  });

  it("names each Mac when there are several, and explains when there is none", () => {
    mocks.ids = ["mac-a", "mac-b"];
    render();
    expect(container.textContent).toContain("Permissions · Studio Mac");
    expect(container.textContent).toContain("Open on the Mac · Office Mac");
    mocks.ids = [];
    render();
    expect(container.textContent).toContain("Mac permissions are not available");
  });
});
