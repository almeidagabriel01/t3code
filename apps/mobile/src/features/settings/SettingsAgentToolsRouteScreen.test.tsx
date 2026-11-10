import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    available: [] as Array<{ environmentId: string; label: string }>,
    selected: [] as Array<{ environmentId: string; label: string }>,
  },
}));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <p>{props.children}</p>,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("./components/SettingsScreen", () => ({
  SettingsScreen: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({ id: "environment", items: [] }),
}));
vi.mock("./components/McpServersSection", () => ({
  McpServersSection: (props: { environmentId: string; title?: string }) => (
    <p>{`mcp ${props.environmentId} ${props.title ?? "-"}`}</p>
  ),
}));
vi.mock("./components/GlobalSkillsSection", () => ({
  GlobalSkillsSection: (props: { environmentId: string; title?: string }) => (
    <p>{`skills ${props.environmentId} ${props.title ?? "-"}`}</p>
  ),
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    availableTargets: mocks.available,
    selectedTargets: mocks.selected,
  }),
}));

import { SettingsAgentToolsRouteScreen } from "./SettingsAgentToolsRouteScreen";

async function text() {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<SettingsAgentToolsRouteScreen />));
  const content = host.textContent ?? "";
  await act(async () => root.unmount());
  return content;
}

afterEach(() => {
  mocks.available = [];
  mocks.selected = [];
});

describe("SettingsAgentToolsRouteScreen", () => {
  it("shows both sections for the selected environment, titled only when several are shown", async () => {
    mocks.available = mocks.selected = [{ environmentId: "a", label: "Mac" }];
    expect(await text()).toBe("mcp a -skills a -");
    mocks.available = mocks.selected = [
      { environmentId: "a", label: "Mac" },
      { environmentId: "b", label: "Server" },
    ];
    expect(await text()).toBe("mcp a Macskills a Macmcp b Serverskills b Server");
  });

  it("explains an empty selection", async () => {
    expect(await text()).toContain("Connect an environment");
    mocks.available = [{ environmentId: "a", label: "Mac" }];
    expect(await text()).toContain("No environments match");
  });
});
