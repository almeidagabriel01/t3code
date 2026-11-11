import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    ids: ["box-a"] as string[],
    data: null as unknown,
    error: null as string | null,
    asked: [] as unknown[],
  },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
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
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({
    savedConnectionsById: {
      "box-a": { environmentLabel: "Build box" },
      "box-b": { environmentLabel: "Office PC" },
    },
  }),
}));
vi.mock("../../state/macPermissions", () => ({
  useComputerUseHostEnvironmentIds: () => mocks.ids,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: mocks.data, error: mocks.error }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    macPermissions: (request: unknown) => {
      mocks.asked.push(request);
      return "permissions-atom";
    },
  },
}));

import { SettingsComputerUseRouteScreen } from "./SettingsComputerUseRouteScreen";

const NO_PERMISSIONS = {
  supported: false,
  screenRecording: "unknown",
  accessibility: "unknown",
  automation: "unknown",
};

let root: Root;
let container: HTMLDivElement;
const render = () => act(() => root.render(<SettingsComputerUseRouteScreen />));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.ids = ["box-a"];
  mocks.data = {
    ...NO_PERMISSIONS,
    host: {
      os: "linux",
      display: "wayland",
      capabilities: [
        { key: "elements", state: "available", detail: "Reads an app's controls." },
        { key: "screenshot", state: "consent", detail: "Your desktop asks you first." },
        { key: "pointer", state: "unavailable", detail: "Wayland cannot aim the pointer." },
        { key: "keyboard", state: "limited", detail: "GNOME sessions only." },
      ],
    },
  };
  mocks.error = null;
  mocks.asked = [];
});
afterEach(() => act(() => root.unmount()));

describe("Computer use settings", () => {
  it("shows the host and each capability with its state and limit", () => {
    render();
    for (const text of [
      "This computer",
      "Linux, Wayland session",
      "App controls",
      "Supported",
      "Screenshots",
      "Asks you first",
      "Clicks by screen position",
      "Not supported",
      "Wayland cannot aim the pointer.",
      "Key presses",
      "Limited",
    ]) {
      expect(container.textContent).toContain(text);
    }
    // Automation is a macOS prompt; this page never asks for it.
    expect(mocks.asked.every((ask) => (ask as any).input.automation === false)).toBe(true);
  });

  it("says when the host could not be read, is loading, or is too old to report", () => {
    mocks.data = null;
    mocks.error = "The environment request failed.";
    render();
    expect(container.textContent).toContain("Could not read this computer");
    expect(container.textContent).toContain("The environment request failed.");
    mocks.error = null;
    render();
    expect(container.textContent).toContain("Checking...");
    mocks.data = NO_PERMISSIONS;
    render();
    expect(container.textContent).toContain("Not reported");
  });

  it("names each computer when there are several, and explains when there is none", () => {
    mocks.ids = ["box-a", "box-b"];
    render();
    expect(container.textContent).toContain("This computer · Build box");
    expect(container.textContent).toContain("This computer · Office PC");
    mocks.ids = [];
    render();
    expect(container.textContent).toContain("Computer use is not reported here");
  });
});
