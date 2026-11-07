import { createMemoryHistory } from "@tanstack/react-router";
import type {
  Assistant,
  AssistantId,
  AssistantTeam,
  AssistantTeamId,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { openCommandPalette } from "~/commandPaletteBus";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { getRouter } from "~/router";
import { assistantDialogAtom } from "./assistantDialogState";
import { assistantTeamDialogAtom } from "./assistantTeamState";
import {
  PROJECT_ID,
  fakeAssistantEdits,
  installFakeEnvironment,
  publishAssistants,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));
// A thread that waits on the user is what puts an assistant under "Needs you". The fake is a
// real shell with its id and approval flag replaced, so every other reader still gets a full shape.
const waiting = vi.hoisted(() => new Set<string>());
vi.mock(import("~/state/entities"), async (original) => {
  const actual = await original();
  const asWaiting = (base: ReturnType<typeof actual.useQuietThreadShells>[number], id: string) =>
    ({ ...base, id, hasPendingApprovals: true }) as typeof base;
  return {
    ...actual,
    useThreadShell: (ref) => {
      const base = actual.useQuietThreadShells()[0]!;
      const real = actual.useThreadShell(ref);
      return ref && waiting.has(ref.threadId) ? asWaiting(base, ref.threadId) : real;
    },
    useQuietThreadShells: () => {
      const real = actual.useQuietThreadShells();
      return [...real, ...[...waiting].map((id) => asWaiting(real[0]!, id))];
    },
  };
});

installFakeEnvironment([threadWithHistory("thread-a", 2)], { assistants: true });
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

const assistant = (id: string, name: string, overrides: Partial<Assistant> = {}): Assistant => ({
  id: id as AssistantId,
  handle: id,
  name,
  projectId: PROJECT_ID,
  instructions: "",
  toolAccess: "workspace-write",
  isDefault: false,
  threadId: `assistant:${id}:1` as ThreadId,
  generation: 1,
  role: "",
  reportsTo: null,
  budget: null,
  askBeforeActing: false,
  workspace: "host",
  icon: null,
  avatar: null,
  scope: "all",
  mcpServers: [],
  autonomy: { mode: "reply-only", rules: null, projectIds: null, channels: null },
  archivedAt: null,
  createdAt: "2026-03-17T19:00:00.000Z",
  updatedAt: "2026-03-17T19:00:00.000Z",
  ...overrides,
});

const team = (id: string, name: string, memberIds: string[]): AssistantTeam => ({
  id: id as AssistantTeamId,
  name,
  memberIds: memberIds as AssistantId[],
  leaderId: null,
  leaderTitle: null,
  createdAt: "2026-03-17T19:00:00.000Z",
  updatedAt: "2026-03-17T19:00:00.000Z",
});

const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });

async function openApp(path = "/assistants", size = { width: 1400, height: 900 }) {
  appAtomRegistry.set(assistantDialogAtom, null);
  appAtomRegistry.set(assistantTeamDialogAtom, null);
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = `height: ${size.height}px; width: ${size.width}px;`;
  return Object.assign(await render(<AppRoot router={router} />, { container, router: false }), {
    router,
  });
}

const main = () => page.getByRole("main");
const section = (name: string) => page.getByRole("region", { name, exact: true });

it("explains an empty page and still offers the two creations", async () => {
  publishAssistants([]);
  await using _screen = await openApp();
  await expect.element(page.getByText("No assistants yet")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "New assistant" }).first());
  expect(appAtomRegistry.get(assistantDialogAtom)).toMatchObject({ assistantId: null });
  appAtomRegistry.set(assistantDialogAtom, null);
  await userEvent.click(page.getByRole("button", { name: "New group" }).first());
  expect(appAtomRegistry.get(assistantTeamDialogAtom)).toMatchObject({ teamId: null });
  appAtomRegistry.set(assistantTeamDialogAtom, null);
});

it("lists every assistant as a card under the sidebar's sections", async () => {
  waiting.add("assistant:ada:1");
  fakeAssistantEdits.updates = [];
  publishAssistants(
    [
      assistant("ada", "Ada", { role: "CFO" }),
      assistant("bo", "Bo"),
      assistant("rev", "Revisor", { scope: "project" }),
      assistant("zed", "Zed"),
      assistant("old", "Retired", { archivedAt: "2026-03-18T00:00:00.000Z" }),
    ],
    [team("t1", "Leaders", ["bo"]), team("t2", "Nobody yet", [])],
  );
  await using screen = await openApp();
  await expect.element(section("Needs you").getByText("Needs your approval")).toBeVisible();
  await expect.element(section("Needs you").getByText("CFO")).toBeVisible();
  await expect.element(section("Leaders").getByText("Bo")).toBeVisible();
  await expect.element(section("Nobody yet").getByText("No members yet.")).toBeVisible();
  await expect.element(section("render").getByText("Revisor")).toBeVisible();
  await expect.element(section("Unassigned").getByText("Zed")).toBeVisible();
  await expect.element(section("Unassigned").getByText("All projects")).toBeVisible();
  await expect
    .element(section("Leaders").getByRole("list", { name: "Groups" }).getByText("Leaders"))
    .toBeVisible();
  await expect.element(section("Archived").getByText("Retired")).toBeVisible();

  await userEvent.click(section("Archived").getByRole("button", { name: "Restore" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([{ assistantId: "old", archived: false }]),
  );

  await userEvent.click(section("Unassigned").getByRole("button", { name: "Edit" }));
  expect(appAtomRegistry.get(assistantDialogAtom)).toMatchObject({ assistantId: "zed" });
  appAtomRegistry.set(assistantDialogAtom, null);

  await userEvent.click(section("render").getByRole("button", { name: "New assistant here" }));
  expect(appAtomRegistry.get(assistantDialogAtom)).toMatchObject({
    assistantId: null,
    preset: { projectId: PROJECT_ID },
  });
  appAtomRegistry.set(assistantDialogAtom, null);
  await userEvent.click(section("Leaders").getByRole("button", { name: "New assistant here" }));
  expect(appAtomRegistry.get(assistantDialogAtom)).toMatchObject({ preset: { teamId: "t1" } });
  appAtomRegistry.set(assistantDialogAtom, null);
  await userEvent.click(section("Leaders").getByRole("button", { name: "Edit group" }));
  expect(appAtomRegistry.get(assistantTeamDialogAtom)).toMatchObject({ teamId: "t1" });
  appAtomRegistry.set(assistantTeamDialogAtom, null);

  await userEvent.click(section("Unassigned").getByRole("button", { name: "Open thread" }));
  await eventually(() =>
    expect(screen.router.state.location.pathname).toContain(encodeURIComponent("assistant:zed:1")),
  );
  waiting.clear();
  appAtomRegistry.set(assistantDialogAtom, null);
  appAtomRegistry.set(assistantTeamDialogAtom, null);
});

it("fits a narrow panel without sideways scrolling", async () => {
  publishAssistants([assistant("bo", "Bo", { role: "Engineer" })], [team("t1", "Leaders", ["bo"])]);
  await page.viewport(420, 900);
  try {
    await using _screen = await openApp("/assistants", { width: 420, height: 900 });
    await expect.element(section("Leaders").getByText("Bo")).toBeVisible();
    const scroller = main().element().querySelector<HTMLElement>(".overflow-y-auto");
    expect(scroller!.scrollWidth).toBeLessThanOrEqual(scroller!.clientWidth);
  } finally {
    await page.viewport(1400, 900);
  }
});

it("the palette creates an assistant or a group and opens the page", async () => {
  publishAssistants([]);
  await using screen = await openApp("/settings/assistants");
  openCommandPalette({ query: "new group" });
  await page.getByRole("option", { name: "New group" }).click();
  await eventually(() =>
    expect(appAtomRegistry.get(assistantTeamDialogAtom)).toMatchObject({ teamId: null }),
  );
  appAtomRegistry.set(assistantTeamDialogAtom, null);
  openCommandPalette({ query: "new assistant" });
  await page.getByRole("option", { name: "New assistant" }).click();
  await eventually(() =>
    expect(appAtomRegistry.get(assistantDialogAtom)).toMatchObject({ assistantId: null }),
  );
  appAtomRegistry.set(assistantDialogAtom, null);
  openCommandPalette({ query: "open assistants" });
  await page.getByRole("option", { name: "Open assistants" }).click();
  await eventually(() => expect(screen.router.state.location.pathname).toBe("/assistants"));
});

it("the rail links to the page", async () => {
  publishAssistants([assistant("bo", "Bo")]);
  await using screen = await openApp("/settings/assistants");
  await userEvent.click(page.getByRole("link", { name: "Assistants" }).first());
  await eventually(() => expect(screen.router.state.location.pathname).toBe("/assistants"));
});
