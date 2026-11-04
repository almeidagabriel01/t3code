import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: {
    label: string;
    description: string;
    disabled: boolean;
    onPress: () => void;
  }): ReactNode => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label} · {props.description}
    </button>
  ),
}));

import { ArchivedProjectRow } from "./ArchivedProjectRow";

const item = { key: "a", title: "Alpha", representative: {}, projectRefs: [] } as never;

describe("ArchivedProjectRow", () => {
  it.each([true, false])("unarchives on press when allowed=%s", async (canUnarchive) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onUnarchive = vi.fn();
    const container = window.document.createElement("div");
    const root = createRoot(container);
    await act(() =>
      root.render(
        <ArchivedProjectRow item={item} canUnarchive={canUnarchive} onUnarchive={onUnarchive} />,
      ),
    );
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Alpha · Unarchive project");
    await act(async () => button.click());
    expect(onUnarchive).toHaveBeenCalledTimes(canUnarchive ? 1 : 0);
    await act(() => root.unmount());
  });
});
