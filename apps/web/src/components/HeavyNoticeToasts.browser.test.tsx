import { useAtomValue } from "@effect/atom-react";
import type { HeavyNoticeBatch } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";

const mocks = vi.hoisted(() => ({ notices: null as unknown }));

vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [{ environmentId: "env-1" }] })) as never,
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

const setup = (batch: HeavyNoticeBatch) => {
  mocks.notices = Atom.make(AsyncResult.success(batch));
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
