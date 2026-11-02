import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  goBack: vi.fn(),
  save: vi.fn(),
  picker: null as null | {
    onSelectModel: (option: { selection: unknown }) => void;
    onClose: () => void;
  },
}));

vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: mocks.goBack }),
}));
vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: () => [],
  groupByProvider: () => [],
}));
vi.mock("../../state/entities", () => ({ useEnvironmentServerConfig: () => null }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.save }));
vi.mock("../threads/ThreadSettingsSheet", () => ({
  ThreadSettingsPickerScreen: (props: NonNullable<typeof mocks.picker>) => {
    mocks.picker = props;
    return null;
  },
}));

import { FallbackModelPickerRouteScreen } from "./FallbackModelPickerRouteScreen";

let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  vi.clearAllMocks();
  act(() =>
    root.render(
      <FallbackModelPickerRouteScreen route={{ params: { environmentId: "env" as never } }} />,
    ),
  );
});
afterEach(() => act(() => root.unmount()));

describe("FallbackModelPickerRouteScreen", () => {
  it("saves the picked model and goes back one screen", () => {
    // The sheet's Save calls onSelectModel, then onClose.
    act(() => {
      mocks.picker!.onSelectModel({ selection: { instanceId: "codex", model: "m1" } });
      mocks.picker!.onClose();
    });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.goBack).toHaveBeenCalledTimes(1);
  });
});
