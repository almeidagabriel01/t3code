import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  Pressable: (props: {
    readonly accessibilityLabel?: string;
    readonly onPress?: () => void;
    readonly children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  Keyboard: { dismiss: () => {} },
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
}));
// React Navigation throws this outside a navigator, as for the Arrange threads sheet.
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => {
    throw new Error("Couldn't find a navigation object.");
  },
}));
vi.mock("./AndroidScreenHeader.android", () => ({
  AndroidScreenHeader: (props: { readonly title: string; readonly titleContent?: ReactNode }) =>
    props.titleContent ?? <h1>{props.title}</h1>,
}));
vi.mock("./AppText", () => ({
  AppText: (props: { readonly children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("./WorkspaceAppBar.android", () => ({
  useHasWorkspaceAppBar: () => false,
  WorkspaceAppBar: () => null,
}));
vi.mock("./Menu", () => ({ Menu: (props: { readonly children?: ReactNode }) => props.children }));
vi.mock("./ScreenHeaderButton.android", () => ({ ScreenHeaderButton: () => null }));
vi.mock("./SearchField", () => ({ SearchField: () => null }));
vi.mock("./Button", () => ({ Button: () => null }));
vi.mock("../../features/layout/adaptive-workspace-context", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("./useToolbarLayout", () => ({
  useToolbarLayout: () => ({ height: 48, paddingTop: 0, paddingBottom: 0 }),
}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../features/layout/useSidebarToggle", () => ({ useSidebarToggle: () => null }));
vi.mock("../../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));

import { AppBar } from "./AppBar.android";

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

it("renders a sheet bar without search outside a navigation container", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() => root.render(<AppBar sheet title="Arrange threads" />));

  expect(container.textContent).toBe("Arrange threads");
});

it("a pressable title shows its leading face and opens what it names", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onPress = vi.fn();

  act(() =>
    root.render(
      <AppBar
        sheet
        title="Ada"
        titlePress={{ accessibilityLabel: "Ada, Assistant info", leading: <i>face</i>, onPress }}
      />,
    ),
  );

  const button = container.querySelector<HTMLButtonElement>('[aria-label="Ada, Assistant info"]');
  expect(button?.textContent).toBe("faceAda");
  act(() => button?.click());
  expect(onPress).toHaveBeenCalledOnce();
});
