import type { EnvironmentId, HeavyQueueEntry } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  promote: vi.fn(),
  cancel: vi.fn(),
  confirm: true,
  entries: [] as ReadonlyArray<HeavyQueueEntry>,
  canPromote: true,
}));

vi.mock("../../state/heavyQueue", () => ({
  useHeavyQueue: () => ({ entries: mocks.entries }),
}));
vi.mock("./useKillTarget", () => ({
  useCloseTerminal: () => ({ canClose: false, close: vi.fn() }),
  useShutDownDevice: () => ({ canShutDown: false, shutDown: vi.fn() }),
  useHeavyQueueActions: () => ({
    canPromote: mocks.canPromote,
    canCancel: true,
    promote: mocks.promote,
    cancel: async (id: string) => {
      if (mocks.confirm) mocks.cancel(id);
    },
  }),
}));

import { HeavyQueueGroup } from "./ResourceSegment";

const environmentId = "env" as EnvironmentId;
const entry = (id: string, over: Partial<HeavyQueueEntry> = {}): HeavyQueueEntry => ({
  id,
  pid: 1,
  threadId: null,
  label: `pnpm ${id}`,
  cwd: "/work/app",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  ...over,
});

function setup(entries: ReadonlyArray<HeavyQueueEntry>, canPromote = true) {
  mocks.promote.mockReset();
  mocks.cancel.mockReset();
  mocks.entries = entries;
  mocks.canPromote = canPromote;
}

const title = (id: string) => (id === "t1" ? "Fix build" : undefined);

describe("HeavyQueueGroup", () => {
  it("lists the running entry and waiters, and acts on them", async () => {
    setup([
      entry("test", { startedAt: "2026-01-01T00:00:00.000Z", threadId: "t1" }),
      entry("build"),
      entry("e2e"),
    ]);
    await using screen = await render(
      <HeavyQueueGroup environmentId={environmentId} threadTitle={title} />,
    );
    await expect.element(screen.getByText("Fix build")).toBeVisible();
    await expect.element(screen.getByText(/^Running · /)).toBeVisible();
    await expect.element(screen.getByText("1st")).toBeVisible();
    await expect.element(screen.getByText("2nd")).toBeVisible();
    expect(screen.container.querySelectorAll('[aria-label^="Run next"]')).toHaveLength(1);
    expect(screen.container.querySelector('[aria-label="Run next pnpm build"]')).toBeNull();
    expect(screen.container.querySelector('[aria-label="Remove pnpm test"]')).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Run next pnpm e2e" }));
    expect(mocks.promote).toHaveBeenCalledWith("e2e");
    await userEvent.click(screen.getByRole("button", { name: "Remove pnpm build" }));
    expect(mocks.cancel).toHaveBeenCalledWith("build");
  });

  it("disables Run next when promoting is not permitted and renders nothing when empty", async () => {
    setup([entry("a", { startedAt: "2026-01-01T00:00:00.000Z" }), entry("b"), entry("c")], false);
    await using screen = await render(
      <HeavyQueueGroup environmentId={environmentId} threadTitle={title} />,
    );
    await expect.element(screen.getByRole("button", { name: "Run next pnpm c" })).toBeDisabled();
    await screen.unmount?.();
  });

  it("renders nothing for an empty queue", async () => {
    setup([]);
    await using screen = await render(
      <HeavyQueueGroup environmentId={environmentId} threadTitle={title} />,
    );
    expect(screen.container.textContent).toBe("");
  });
});
