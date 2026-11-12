import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { HeavyNoticeBatch } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  notices: null as unknown,
  settings: { statusBarHiddenItems: [] as string[], notificationMode: "in-app" },
}));

vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [{ environmentId: "env-1" }] })) as never,
}));
vi.mock(import("../hooks/useSettings"), () => ({
  getClientSettings: (() => mocks.settings) as never,
  useClientSettings: ((select: (settings: typeof mocks.settings) => unknown) =>
    select(mocks.settings)) as never,
}));
vi.mock(import("../state/heavyQueue"), async () => {
  const { Atom: A } = await import("effect/reactivity");
  return {
    resourceManagerOpenAtom: A.make(false).pipe(A.keepAlive),
    heavyQueueEnvironment: { notices: () => mocks.notices } as never,
  };
});

import { resourceManagerOpenAtom } from "../state/heavyQueue";
import { HeavyNoticeToasts } from "./HeavyNoticeToasts";
import { ToastProvider } from "./ui/toast";

const setup = (batch: HeavyNoticeBatch, settings = mocks.settings) => {
  mocks.notices = Atom.make(AsyncResult.success(batch));
  mocks.settings = settings;
};

function ResourceManagerProbe() {
  return useAtomValue(resourceManagerOpenAtom) ? "Resource Manager open" : null;
}

it("shows a job's notice with an action that opens its thread", async () => {
  setup([
    {
      id: "n-1",
      tone: "error",
      title: "pnpm test failed on Linux",
      description: "Exit code 1",
      machine: "linux",
      threadId: "thread-1",
    },
  ]);
  await using screen = await render(
    <ToastProvider>
      <HeavyNoticeToasts />
    </ToastProvider>,
  );
  await expect.element(page.getByText("pnpm test failed on Linux")).toBeVisible();
  await expect.element(page.getByText("Exit code 1")).toBeVisible();
  await page.getByRole("button", { name: "Open thread" }).click();
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env-1/thread-1"));
});

it("opens the Resource Manager from a grouped notice", async () => {
  setup([
    {
      id: "n-2",
      tone: "info",
      title: "3 jobs moved to this Mac",
      description: "Linux is unavailable",
      machine: "mac",
      threadId: null,
    },
  ]);
  await using _screen = await render(
    <ToastProvider>
      <HeavyNoticeToasts />
      <ResourceManagerProbe />
    </ToastProvider>,
  );
  await expect.element(page.getByText("3 jobs moved to this Mac")).toBeVisible();
  await page.getByRole("button", { name: "Resource Manager" }).click();
  await expect.element(page.getByText("Resource Manager open")).toBeVisible();
});

it("grows a grouped notice in place, and tells an unfocused desktop, with the Resource Manager hidden", async () => {
  const failed = (count: number): HeavyNoticeBatch => [
    {
      id: "n-5",
      tone: "error",
      title: `${count} jobs failed on Linux`,
      description: "Exit code 1",
      machine: "linux",
      threadId: null,
    },
  ];
  setup(failed(2), { statusBarHiddenItems: ["resource-usage"], notificationMode: "notifications" });
  const shown: Array<{ title: string; tag: string | undefined; click: () => void }> = [];
  class FakeNotification {
    static permission = "granted";
    constructor(title: string, options?: NotificationOptions) {
      shown.push({ title, tag: options?.tag, click: () => undefined });
    }
    addEventListener(_type: "click", listener: () => void) {
      shown.at(-1)!.click = listener;
    }
    close() {}
  }
  vi.stubGlobal("Notification", FakeNotification);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const notices = mocks.notices as Atom.Writable<AsyncResult.AsyncResult<HeavyNoticeBatch>>;
  function GrowGroup() {
    const set = useAtomSet(notices);
    return <button onClick={() => set(AsyncResult.success(failed(3)))}>Grow</button>;
  }
  await using screen = await render(
    <ToastProvider>
      <HeavyNoticeToasts />
      <GrowGroup />
    </ToastProvider>,
  );
  await expect.element(page.getByText("2 jobs failed on Linux")).toBeVisible();
  await page.getByRole("button", { name: "Grow" }).click();
  await expect.element(page.getByText("3 jobs failed on Linux")).toBeVisible();
  expect(page.getByText("2 jobs failed on Linux").elements()).toHaveLength(0);
  expect(shown.map(({ title, tag }) => [title, tag])).toEqual([
    ["2 jobs failed on Linux", "heavy:n-5"],
    ["3 jobs failed on Linux", "heavy:n-5"],
  ]);
  shown[1]!.click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/settings/maintenance"),
  );
});
