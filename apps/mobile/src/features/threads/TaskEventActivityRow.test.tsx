import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Pressable: (props: {
    onPress?: () => void;
    accessibilityLabel?: string;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode; ellipsizeMode?: string }) => (
    <span data-ellipsize={props.ellipsizeMode}>{props.children}</span>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: (props: { name: string }) => <i>{props.name}</i>,
}));

const { TaskEventActivityRow } = await import("./TaskEventActivityRow");
const { FoldableContent } = await import("../../components/FoldableContent");

async function mount(node: ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = window.document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(node));
  return container;
}

describe("TaskEventActivityRow", () => {
  it("shows title, label and opens the task on press", async () => {
    const onOpen = vi.fn();
    const view = await mount(
      <TaskEventActivityRow title="Fix build" label="Failed" status="failed" onOpen={onOpen} />,
    );
    expect(view.textContent).toContain("Fix build");
    expect(view.textContent).toContain("· Failed");
    expect(view.textContent).toContain("xmark.circle.fill");
    expect(view.textContent).toContain("Open");
    await act(async () => view.querySelector("button")!.click());
    expect(onOpen).toHaveBeenCalledOnce();
    const chipped = await mount(
      <TaskEventActivityRow
        title="Review"
        label="Working"
        status={null}
        chip={{ label: "Beta" }}
        actionLabel="Hide"
        action="Hide request"
        onOpen={onOpen}
      />,
    );
    expect(chipped.textContent).toContain("Beta");
    // A long chip keeps its end ("Removed project 2"), which tells two apart.
    expect(
      [...chipped.querySelectorAll("span")].find((span) => span.textContent === "Beta")?.dataset
        .ellipsize,
    ).toBe("middle");
    expect(chipped.textContent).toContain("Hide");
    expect(chipped.querySelector("button")!.getAttribute("aria-label")).toBe(
      "Review, Working, Beta. Hide request",
    );
  });
});

describe("FoldableContent", () => {
  it("folds behind Show more and toggles", async () => {
    const view = await mount(
      <FoldableContent foldable foldedHeight={96}>
        <span>body</span>
      </FoldableContent>,
    );
    expect(view.textContent).toContain("Show more");
    await act(async () => view.querySelector("button")!.click());
    expect(view.textContent).toContain("Show less");
  });

  it("renders no toggle when not foldable", async () => {
    const view = await mount(
      <FoldableContent foldable={false} foldedHeight={96}>
        <span>body</span>
      </FoldableContent>,
    );
    expect(view.querySelector("button")).toBeNull();
  });
});
