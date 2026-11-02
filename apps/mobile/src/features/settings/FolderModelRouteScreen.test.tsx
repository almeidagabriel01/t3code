import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  input: null as null | { onChangeText: (text: string) => void },
  row: null as null | { disabled?: boolean; onPress: () => void },
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: { onChangeText: (text: string) => void }) => {
    mocks.input = props;
    return null;
  },
}));
vi.mock("./components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./components/SettingsRow", () => ({
  SettingsRow: (props: { disabled?: boolean; onPress: () => void }) => {
    mocks.row = props;
    return null;
  },
}));

import { FolderModelRouteScreen } from "./FolderModelRouteScreen";

let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  mocks.navigate.mockClear();
  act(() =>
    root.render(<FolderModelRouteScreen route={{ params: { environmentId: "env" as never } }} />),
  );
});
afterEach(() => act(() => root.unmount()));

describe("FolderModelRouteScreen", () => {
  it("waits for a folder, then hands the trimmed path to the model picker", () => {
    expect(mocks.row!.disabled).toBe(true);
    act(() => mocks.input!.onChangeText("  ~/work "));
    expect(mocks.row!.disabled).toBe(false);
    act(() => mocks.row!.onPress());
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsFolderModelPicker", {
      environmentId: "env",
      folder: "~/work",
    });
  });
});
