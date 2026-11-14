import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const { children } = vi.hoisted(() => ({
  children: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("react-native", () => ({ View: children }));
vi.mock("@expo/ui/jetpack-compose", () => ({
  Column: children,
  RNHostView: children,
  Text: (props: { readonly children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("./NativeAppBar.android", () => ({
  NativeAppBar: (props: { readonly title?: ReactNode }) => <header>{props.title}</header>,
}));
vi.mock("./IconButton", () => ({ IconButton: () => null }));
vi.mock("./AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("./AndroidAnchoredMenu.android", () => ({ AndroidAnchoredMenu: () => null }));
vi.mock("./useControlTheme", () => ({ useControlTheme: () => ({ colors: {} }) }));
vi.mock("./useToolbarLayout", () => ({
  useToolbarLayout: () => ({ paddingTop: 0, paddingBottom: 0 }),
}));
vi.mock("../../features/settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 14, lineHeight: 19 }),
}));

import { AndroidScreenHeader } from "./AndroidScreenHeader.android";

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

it.each([
  { case: "plain title", titleContent: undefined, expected: "Release crew6 members · lead Jarvis" },
  {
    case: "custom title",
    titleContent: <b>faces Release crew</b>,
    expected: "faces Release crew6 members · lead Jarvis",
  },
])("keeps the subtitle under a $case", ({ titleContent, expected }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() =>
    root.render(
      <AndroidScreenHeader
        title="Release crew"
        titleContent={titleContent}
        subtitle="6 members · lead Jarvis"
      />,
    ),
  );

  expect(container.textContent).toBe(expected);
});
