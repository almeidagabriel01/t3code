import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useThreadTabsStore } from "~/threadTabsStore";
import { useUiStateStore } from "~/uiStateStore";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("keeps the title when dragging a search result from a collapsed folder", async () => {
  await page.viewport(1400, 900);
  const [first, second] = [threadWithHistory("visible", 1), threadWithHistory("search-target", 1)];
  using _environment = installFakeEnvironment([first, second]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    boringSidebarEnabled: true,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const folder = page.getByRole("button", { name: /^render/ });
  await expect.element(folder).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(folder);
  await expect.element(page.getByText(second.title, { exact: true })).not.toBeInTheDocument();
  await userEvent.fill(page.getByRole("combobox", { name: "Search threads" }), "search-target");
  const result = page.getByRole("option", { name: /Thread search-target/ });
  await expect.element(result).toBeVisible();
  const bounds = result.element().getBoundingClientRect();
  const pointer = (type: string, x: number, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
    });
  using _release = {
    [Symbol.dispose]: () => document.dispatchEvent(pointer("pointerup", -100, 100)),
  };
  await act(() => {
    result.element().dispatchEvent(pointer("pointerdown", bounds.x + 10, bounds.y + 10));
    document.dispatchEvent(pointer("pointermove", -100, 100));
  });
  await vi.waitFor(() => {
    expect(
      document.querySelector('body > div[aria-hidden="true"].pointer-events-none')?.textContent,
    ).toBe(second.title);
  });
});

it("splits the thread area when a sidebar thread drops on its edge", async () => {
  await page.viewport(1400, 900);
  const [first, second] = [threadWithHistory("visible", 1), threadWithHistory("beside", 1)];
  using _environment = installFakeEnvironment([first, second]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  useUiStateStore.setState({ projectExpandedById: {} });
  // The tab layout persists to localStorage, which later test files share.
  const clearTabs = () => useThreadTabsStore.setState({ byProject: {} });
  clearTabs();
  using _tabs = { [Symbol.dispose]: clearTabs };
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const rowSelector = `[data-sidebar-row$=":${second.id}"]`;
  await vi.waitFor(() => expect(document.querySelector(rowSelector)).not.toBeNull());
  const row = document.querySelector<HTMLElement>(rowSelector)!;
  const start = row.getBoundingClientRect();
  const area = document.querySelector("[data-chat-column]")!.getBoundingClientRect();
  const inList = (dy: number) => ({ x: start.x + 40, y: start.y + dy });
  const rightEdge = { x: area.right - 10, y: area.top + area.height / 2 };
  const pointer = (type: string, point: { x: number; y: number }) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: point.x,
      clientY: point.y,
    });
  const preview = () =>
    document.querySelector<HTMLElement>("[data-thread-tab-drop-preview]")?.dataset
      .threadTabDropPreview;
  // The row lifts above its neighbours only while it is being sorted.
  const sorting = () => row.closest("li")?.classList.contains("z-20");
  const groups = () => document.querySelectorAll("[data-thread-group]");
  // Separate acts let the sidebar re-render between moves, as a real drag does.
  const dragInList = async () => {
    await act(() => {
      row.dispatchEvent(pointer("pointerdown", { x: start.x + 10, y: start.y + 10 }));
      document.dispatchEvent(pointer("pointermove", inList(10)));
    });
    await act(() => document.dispatchEvent(pointer("pointermove", inList(14))));
    expect(sorting()).toBe(true);
  };
  const dragOut = async () => {
    await dragInList();
    await act(() => document.dispatchEvent(pointer("pointermove", rightEdge)));
    await vi.waitFor(() => expect(preview()).toBe("right"));
  };

  await dragInList();
  await act(() => document.dispatchEvent(pointer("pointerup", inList(14))));
  expect(sorting()).toBe(false);
  expect(groups()).toHaveLength(1);

  await dragOut();
  await act(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" })));
  expect(preview()).toBeUndefined();
  expect(groups()).toHaveLength(1);

  await dragOut();
  await act(() => document.dispatchEvent(pointer("pointerup", rightEdge)));
  expect(preview()).toBeUndefined();
  await vi.waitFor(() => expect(router.state.location.pathname).toContain(second.id));
  await vi.waitFor(() => expect(groups()).toHaveLength(2));
});
