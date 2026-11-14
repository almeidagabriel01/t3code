import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  assistant: null as unknown,
  navigate: vi.fn(),
}));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: (props: {
    title: string;
    titlePress?: { accessibilityLabel: string; leading?: ReactNode; onPress: () => void };
  }) => (
    <header>
      {props.titlePress ? (
        <button aria-label={props.titlePress.accessibilityLabel} onClick={props.titlePress.onPress}>
          {props.titlePress.leading}
        </button>
      ) : null}
      <h1>{props.title}</h1>
    </header>
  ),
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: false },
    toggleAuxiliaryPane: () => {},
    startNewTask: () => {},
  }),
  useWorkspacePaneState: () => ({ panes: { auxiliaryPaneVisible: false } }),
}));
vi.mock("../layout/workspace/useAndroidWorkspaceNavigation", () => ({
  useWorkspaceBackNavigation: () => () => {},
}));
vi.mock("../../lib/device-type", () => ({ isDuoDevice: () => false }));
vi.mock("../../native/native-layout-metrics", () => ({ useDeviceType: () => "phone" }));
vi.mock("../../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsSupported: () => false,
}));
vi.mock("../../state/assistants", () => ({ useThreadAssistant: () => mocks.assistant }));
vi.mock("../assistants/assistantPresentation", () => ({
  AssistantAvatar: (props: { assistant: { name: string } }) => (
    <i>{`av:${props.assistant.name}`}</i>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("./ThreadGitControls", () => ({
  threadTerminalMenu: () => null,
  useThreadGitMenuDefinition: () => null,
}));
vi.mock("./useThreadMenu", () => ({
  useThreadMenu: () => ({ items: null, customSnoozeSheet: null }),
}));

import { ThreadHeader } from "./ThreadHeader";

const renderHeader = () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <ThreadHeader
        thread={{ environmentId: "hub", id: "assistant:ada:1" } as never}
        title="Thread title"
        subtitle=""
        gitControls={{ canOpenFiles: true } as never}
        hasThreadCwd={false}
        inspectorMode={null}
        onOpenFilesInspector={() => {}}
      />,
    ),
  );
  return { container, [Symbol.dispose]: () => act(() => root.unmount()) };
};

it.each([
  { name: "an assistant's chat titles itself with the name and opens Assistant info", entry: true },
  { name: "another thread keeps its plain title", entry: false },
])("$name", async ({ entry }) => {
  mocks.navigate.mockReset();
  mocks.assistant = entry
    ? { environmentId: "hub", assistant: { id: "ada", name: "Ada", avatar: null, icon: null } }
    : null;
  using header = renderHeader();
  const button = header.container.querySelector<HTMLButtonElement>(
    '[aria-label="Ada, Assistant info"]',
  );
  expect(header.container.querySelector("h1")?.textContent).toBe(entry ? "Ada" : "Thread title");
  if (!entry) {
    expect(button).toBeNull();
    return;
  }
  expect(button?.textContent).toBe("av:Ada");
  await act(async () => button?.click());
  expect(mocks.navigate).toHaveBeenCalledWith("AssistantInfo", {
    environmentId: "hub",
    assistantId: "ada",
  });
});
