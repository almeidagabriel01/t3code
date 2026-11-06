import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("react-native-svg", () => ({
  default: (props: { children?: ReactNode; color?: string }) => (
    <svg data-icon-svg data-color={props.color}>
      {props.children}
    </svg>
  ),
  Path: (props: { d: string }) => <path d={props.d} />,
}));
vi.mock("uniwind", () => ({ withUniwind: <T,>(component: T) => component }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));

import { AssistantAvatar, AssistantIconGlyph } from "./assistantPresentation";

const draw = (node: ReactNode) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = window.document.createElement("div");
  act(() => createRoot(container).render(node));
  return container;
};

describe("assistant avatar icon", () => {
  it.each([
    ["a known icon replaces the initial", "scout", true, ""],
    ["an unknown icon falls back to the initial", "laser", false, "J"],
    ["no icon shows the initial", null, false, "J"],
  ])("%s", (_name, icon, drawn, text) => {
    const container = draw(
      <AssistantAvatar assistant={{ name: "Jarvis", handle: "jarvis", icon }} />,
    );
    expect(container.querySelector("svg") !== null).toBe(drawn);
    expect(container.textContent).toBe(text);
    if (drawn) expect(container.querySelectorAll("path").length).toBeGreaterThan(1);
  });

  it("draws a bare glyph in the given color, and nothing for an unknown id", () => {
    expect(
      draw(<AssistantIconGlyph icon="spark" size={20} color="#fff" />)
        .querySelector("svg")
        ?.getAttribute("data-color"),
    ).toBe("#fff");
    expect(draw(<AssistantIconGlyph icon="laser" size={20} />).querySelector("svg")).toBeNull();
  });
});
