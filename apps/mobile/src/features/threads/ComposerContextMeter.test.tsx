import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ structure: null as unknown }));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Pressable: (props: { children?: ReactNode; accessibilityLabel?: string }) => (
    <button aria-label={props.accessibilityLabel}>{props.children}</button>
  ),
}));
vi.mock("react-native-svg", () => ({
  default: (props: { children?: ReactNode }) => <svg>{props.children}</svg>,
  Circle: (props: { stroke: string; strokeDashoffset?: number }) => (
    <circle data-stroke={props.stroke} data-offset={props.strokeDashoffset} />
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    title: string;
    actions: ReadonlyArray<{ title: string; subtitle?: string }>;
    children?: ReactNode;
  }) => (
    <div data-title={props.title} data-items={JSON.stringify(props.actions)}>
      {props.children}
    </div>
  ),
}));
vi.mock("../../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => ({
    "--color-danger": "danger",
    "--color-warning": "warning",
    "--color-foreground-muted": "muted",
    "--color-border": "border",
  }),
}));
vi.mock("../../state/use-thread-detail", () => ({
  useQuietThreadStructure: () => state.structure,
}));

const { ComposerContextMeter, ThreadContextMeter } = await import("./ComposerContextMeter");

const usage = (usedTokens: number, maxTokens: number | null) => ({
  usedTokens,
  maxTokens,
  usedPercentage: maxTokens === null ? null : (usedTokens / maxTokens) * 100,
  autoCompactThreshold: null,
  updatedAt: "2026-11-16T00:00:00.000Z",
});

function mount(node: ReactNode) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, unmount: () => act(() => root.unmount()) };
}

it.each([
  {
    used: 90_000,
    max: 200_000,
    label: "45%",
    detail: "90,000 of 200,000 tokens",
    stroke: "muted",
  },
  {
    used: 170_000,
    max: 200_000,
    label: "85%",
    detail: "170,000 of 200,000 tokens",
    stroke: "warning",
  },
  {
    used: 190_000,
    max: 200_000,
    label: "95%",
    detail: "190,000 of 200,000 tokens",
    stroke: "danger",
  },
  // An unknown window shows the tokens used and no ring progress.
  { used: 12_000, max: null, label: "12K", detail: null, stroke: null },
])("reads $used of $max tokens as $label", ({ used, max, label, detail, stroke }) => {
  const view = mount(
    <ComposerContextMeter
      usage={usage(used, max) as never}
      title="Context of Ada in this request"
    />,
  );
  const menu = view.container.querySelector("[data-title]")!;
  expect(menu.getAttribute("data-title")).toBe("Context of Ada in this request");
  const [item] = JSON.parse(menu.getAttribute("data-items")!) as Array<{ subtitle?: string }>;
  expect(item!.subtitle).toBe(detail ?? undefined);
  expect(view.container.querySelector("span")!.textContent).toBe(label);
  const progress = view.container.querySelectorAll("circle")[1];
  expect(progress?.getAttribute("data-stroke") ?? null).toBe(stroke);
  view.unmount();
});

it("shows a thread's active session usage, and nothing before it reports any", () => {
  state.structure = null;
  let view = mount(<ThreadContextMeter threadRef={null} />);
  expect(view.container.innerHTML).toBe("");
  view.unmount();

  const projection = {
    thread: { id: "t1", activeProviderThreadId: "p2", forkedFrom: null },
    contextTransfers: [],
    visibleTurnItems: [],
    providerThreads: [
      { id: "p1", contextUsage: null },
      { id: "p2", contextUsage: null },
    ],
    providerTurns: [] as unknown[],
  };
  state.structure = { environmentId: "hub", projection };
  view = mount(<ThreadContextMeter threadRef={null} />);
  expect(view.container.innerHTML).toBe("");
  view.unmount();

  projection.providerTurns = [
    {
      providerThreadId: "p2",
      tokenUsage: { usedTokens: 50_000, maxTokens: 100_000, updatedAt: "2026-11-16T00:00:00Z" },
    },
  ];
  view = mount(<ThreadContextMeter threadRef={null} />);
  expect(view.container.querySelector("button")!.getAttribute("aria-label")).toBe(
    "Context window: Context: 50% used, 50,000 of 100,000 tokens",
  );
  view.unmount();
});
