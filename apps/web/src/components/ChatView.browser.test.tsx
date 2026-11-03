import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  fakeCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

const toast = vi.hoisted(() => vi.fn());
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toast } };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("Toggle side chat starts a side chat and shows its pane, and toggles it closed", async () => {
  await page.viewport(1400, 900);
  const parent = threadWithHistory("thread-parent", 1);
  using _environment = installFakeEnvironment([parent], { sideChats: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText("thread-parent: question 0")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Toggle side chat" })).toBeVisible();
  await page.getByRole("button", { name: "Toggle side chat" }).click();
  await expect.element(page.getByRole("button", { name: "Close side chat" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Turn into thread" })).toBeVisible();
  await expect.element(page.getByTestId("composer-editor").last()).toBeVisible();

  await page.getByRole("button", { name: "Toggle side chat" }).click();
  await expect
    .element(page.getByRole("button", { name: "Close side chat" }))
    .not.toBeInTheDocument();
});

async function openSideChat() {
  await page.viewport(1400, 900);
  const parent = threadWithHistory("thread-parent", 1);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
  );
  await router.load();
  return { parent, router };
}

it("Turn into thread detaches the side chat, closes its pane and opens the thread", async () => {
  const { parent, router } = await openSideChat();
  using _environment = installFakeEnvironment([parent], { sideChats: true });
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await page.getByRole("button", { name: "Toggle side chat" }).click();
  await page.getByRole("button", { name: "Turn into thread" }).click();
  await expect
    .element(page.getByRole("button", { name: "Turn into thread" }))
    .not.toBeInTheDocument();
  const fork = fakeCommands.dispatched.find((command) => command.type === "thread.fork");
  const detach = fakeCommands.dispatched.find(
    (command) => command.type === "thread.metadata.update",
  );
  expect(detach).toMatchObject({ threadId: fork?.targetThreadId, detachSideChat: true });
  expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${fork?.targetThreadId}`);
});

it("Turn into thread shows an error toast and keeps the pane open when the server refuses", async () => {
  const { parent, router } = await openSideChat();
  using _environment = installFakeEnvironment([parent], { sideChats: true });
  toast.mockClear();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await page.getByRole("button", { name: "Toggle side chat" }).click();
  await expect.element(page.getByRole("button", { name: "Turn into thread" })).toBeVisible();
  fakeCommands.failTypes.add("thread.metadata.update");
  await page.getByRole("button", { name: "Turn into thread" }).click();
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not turn the side chat into a thread" }),
    ),
  );
  await expect.element(page.getByRole("button", { name: "Turn into thread" })).toBeVisible();
  expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${parent.id}`);
});

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});
