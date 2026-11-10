import { weekBarSplit } from "@t3tools/shared/usagePace";
import type { CSSProperties, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode; testID?: string; style?: unknown }) => {
    const style = Object.assign({}, ...[props.style].flat()) as CSSProperties;
    return (
      <div data-testid={props.testID} style={style}>
        {props.children}
      </div>
    );
  },
}));

import { WeekSplitOverlay } from "./WeekSplitOverlay";

const week = { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 84 } as const;
const scoped = (name: string, share: number) => ({
  id: name,
  kind: "weekly" as const,
  label: `Weekly · ${name}`,
  usedPercent: 40,
  weekUsedSharePercent: share,
});

async function render(models: ReadonlyArray<ReturnType<typeof scoped>>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = window.document.createElement("div");
  const split = weekBarSplit(week, [week, ...models], "remaining");
  await act(() =>
    createRoot(container).render(
      split ? <WeekSplitOverlay split={split} className="bg-foreground" color="#10a37f" /> : null,
    ),
  );
  return container;
}

describe("WeekSplitOverlay", () => {
  it("draws one lighter segment per scoped model at the used end, sized by its share", async () => {
    const container = await render([scoped("Fable", 20), scoped("Opus", 10)]);
    const segments = [...container.querySelectorAll<HTMLElement>("[data-testid=week-split-model]")];
    expect(segments.map((segment) => segment.style.flexGrow)).toEqual(["20", "10"]);
    expect((container.firstElementChild as HTMLElement).style.width).toBe("30%");
    expect(segments[0]!.style.backgroundColor).not.toBe("");
  });

  it("draws nothing when the shares add up to zero", async () => {
    expect((await render([scoped("Fable", 0)])).querySelector("[data-testid]")).toBeNull();
  });
});
