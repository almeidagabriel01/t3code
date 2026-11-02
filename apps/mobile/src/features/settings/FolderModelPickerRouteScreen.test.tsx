import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  goBack: vi.fn(),
  save: vi.fn(),
  rules: [] as Array<{ folder: string; modelSelection: unknown }>,
  picker: null as null | {
    onSelectModel: (option: { selection: unknown }) => void;
    onClose: () => void;
    title?: string;
  },
}));

vi.mock("@react-navigation/native", () => ({
  StackActions: { pop: (count: number) => ({ type: "POP", count }) },
  useNavigation: () => ({ dispatch: mocks.dispatch, goBack: mocks.goBack }),
}));
vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: () => [],
  groupByProvider: () => [],
}));
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => ({ settings: { folderModelDefaults: mocks.rules } }),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.save }));
vi.mock("../threads/ThreadSettingsSheet", () => ({
  ThreadSettingsPickerScreen: (props: NonNullable<typeof mocks.picker>) => {
    mocks.picker = props;
    return null;
  },
}));

import { FolderModelPickerRouteScreen } from "./FolderModelPickerRouteScreen";

const model = { instanceId: "codex", model: "m1" };
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  vi.clearAllMocks();
  mocks.rules = [{ folder: "/play", modelSelection: model }];
  act(() =>
    root.render(
      <FolderModelPickerRouteScreen
        route={{ params: { environmentId: "env" as never, folder: "/work" } }}
      />,
    ),
  );
});
afterEach(() => act(() => root.unmount()));

describe("FolderModelPickerRouteScreen", () => {
  it("titles the picker Folder model", () => {
    expect(mocks.picker!.title).toBe("Folder model");
  });

  it("saves the picked model for the folder and closes both screens once", () => {
    // The sheet's Save calls onSelectModel, then onClose.
    act(() => {
      mocks.picker!.onSelectModel({ selection: model });
      mocks.picker!.onClose();
    });
    expect(mocks.save).toHaveBeenCalledWith({
      environmentId: "env",
      input: {
        patch: {
          folderModelDefaults: [
            { folder: "/play", modelSelection: model },
            { folder: "/work", modelSelection: model },
          ],
        },
      },
    });
    expect(mocks.dispatch.mock.calls).toEqual([[{ type: "POP", count: 2 }]]);
    expect(mocks.goBack).not.toHaveBeenCalled();
  });

  it("closes without saving", () => {
    act(() => mocks.picker!.onClose());
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.dispatch.mock.calls).toEqual([[{ type: "POP", count: 1 }]]);
  });
});
