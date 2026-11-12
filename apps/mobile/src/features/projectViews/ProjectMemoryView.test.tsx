import * as Option from "effect/Option";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

type Query = { kind: "list" | "search"; input: { cursor?: string; query?: string } };

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    canRead: true,
    space: "space-1" as string | null,
    scope: { status: "ready", scope: { kind: "project", projectKey: "k" } } as unknown,
    page: (_query: Query): unknown => ({ data: null, error: null }),
    queries: [] as Query[],
    navigate: vi.fn(),
    forget: vi.fn(),
  },
}));

vi.mock("react-native", () => ({ View: Children }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/RelativeTime", () => ({
  RelativeTime: (props: { timestamp: string }) => `at ${props.timestamp}`,
}));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; meta?: ReactNode }) => (
    <p>
      {props.label}|{props.meta}
    </p>
  ),
}));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    accessibilityLabel: string;
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/IconButton", () => ({
  IconButton: (props: { accessibilityLabel: string; onPress: () => void }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress} />
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/SearchField", () => ({
  SearchField: (props: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => mocks.canRead }));
vi.mock("../../state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("../../state/memory", () => ({
  memoryEnvironment: {
    list: (args: { input: Query["input"] }) => ({ kind: "list", input: args.input }),
    search: (args: { input: Query["input"] }) => ({ kind: "search", input: args.input }),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: Query) => {
    mocks.queries.push(query);
    return mocks.page(query);
  },
}));
vi.mock("../memory/useProjectMemory", () => ({
  useMemorySpace: () => mocks.space,
  useProjectMemoryScope: () => mocks.scope,
  useForgetMemory: () => mocks.forget,
}));

import { ProjectMemoryView } from "./ProjectMemoryView";

const memory = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  memoryId: id,
  memorySpaceId: "space-1",
  status: "active",
  payload: { text },
  pendingSync: false,
  revision: { createdAtUtc: "2026-03-09T09:00:00.000Z" },
  ...extra,
});
const loaded = (items: unknown[], nextCursor: string | null = null) => ({
  data: Option.some({ items, nextCursor }),
  error: null,
});

async function mount() {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(<ProjectMemoryView environmentId={"env" as never} projectId="p1" />),
  );
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === label || b.getAttribute("aria-label") === label,
    )!;
  return { host, button, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  mocks.canRead = true;
  mocks.space = "space-1";
  mocks.scope = { status: "ready", scope: { kind: "project", projectKey: "k" } };
  mocks.page = () => ({ data: null, error: null });
  mocks.queries = [];
  vi.clearAllMocks();
});

describe("ProjectMemoryView", () => {
  it.each([
    ["no read access", () => (mocks.canRead = false), "Memory read access needed"],
    ["no memory space", () => (mocks.space = null), "Memory is not ready"],
    ["the scope lookup", () => (mocks.scope = { status: "loading" }), "Loading project memory…"],
    [
      "no permission",
      () => (mocks.scope = { status: "no-permission" }),
      "Memory write access needed",
    ],
    [
      "no project key",
      () => (mocks.scope = { status: "no-key" }),
      "This project has no shared memory",
    ],
    [
      "a failed lookup",
      () => (mocks.scope = { status: "failed" }),
      "Could not load this project's memory",
    ],
    ["the first page", () => undefined, "Loading memories…"],
    ["a failed page", () => (mocks.page = () => ({ data: null, error: "boom" })), "boom"],
  ])(
    "explains %s without a search field until the scope is ready",
    async (_name, arrange, text) => {
      arrange();
      const view = await mount();
      expect(view.host.textContent).toContain(text);
      expect(view.host.querySelector("input") !== null).toBe(
        (mocks.scope as { status: string }).status === "ready",
      );
      await view.unmount();
    },
  );

  it("lists memories with their marks, opens one in Memory to edit, and forgets one", async () => {
    const rule = memory("m2", "Rule: Always run lint", { pendingSync: true });
    mocks.page = () =>
      loaded([memory("m1", "Uses pnpm"), rule, { memoryId: "gone", status: "forgotten" }]);
    const view = await mount();
    const rows = [...view.host.querySelectorAll("p")].map((row) => row.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe("Uses pnpm|at 2026-03-09T09:00:00.000Z");
    expect(rows[1]).toMatch(/\|Rule · Not synced · at /);
    act(() => view.button("Edit memory: Uses pnpm").click());
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsMemory", {
      environmentId: "env",
      memorySpaceId: "space-1",
      memoryId: "m1",
      project: { environmentId: "env", projectId: "p1" },
    });
    act(() => view.button("Forget memory").click());
    expect(mocks.forget).toHaveBeenCalledWith(expect.objectContaining({ memoryId: "m1" }));
    await view.unmount();
  });

  it("searches, pages back and forth, and says when nothing matches", async () => {
    mocks.page = (query) =>
      query.kind === "search"
        ? loaded([])
        : query.input.cursor === "c1"
          ? loaded([memory("m9", "Older one")])
          : loaded([memory("m1", "Newest")], "c1");
    const view = await mount();
    expect(view.host.textContent).toContain("Newest");
    expect(view.button("Newer").disabled).toBe(true);
    act(() => view.button("Older").click());
    expect(view.host.textContent).toContain("Older one");
    expect(view.button("Older").disabled).toBe(true);
    act(() => view.button("Newer").click());
    expect(view.host.textContent).toContain("Newest");

    const input = view.host.querySelector("input")!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "  lint ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(mocks.queries.at(-1)).toMatchObject({ kind: "search", input: { query: "lint" } });
    expect(view.host.textContent).toContain("No matching memories");
    await view.unmount();
  });

  it("invites agents' learnings when the project has no memories", async () => {
    mocks.page = () => loaded([]);
    const view = await mount();
    expect(view.host.textContent).toContain("No memories yet");
    expect(view.button("Older")).toBeUndefined();
    await view.unmount();
  });
});
