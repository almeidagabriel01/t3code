import { createElement } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { toastManager } from "../ui/toast";
import { announceForkUpdate, SidebarForkUpdatePill } from "./SidebarForkUpdatePill";

const fork = vi.hoisted(() => ({
  status: null as null | {
    available: boolean;
    behind: number;
    headTag: string | null;
    upstreamTag: string | null;
    channel: string;
  },
}));
vi.mock("../forkUpdates/useForkUpdates", () => ({
  useForkUpdatesEnvironmentId: () => "env",
  useForkUpdateStatus: () => ({ status: fork.status, checking: false, check: () => {} }),
}));

const CHECKOUT_KEY = "t3code:fork-checkout-known";
const railEntry = () => page.getByRole("link", { name: /Fork updates|is out upstream/ });

const KEY = "t3code:fork-update-announced-tag";

it("announces each upstream tag once, across both pills and across reloads", () => {
  using add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
  localStorage.removeItem(KEY);
  const open = vi.fn();

  announceForkUpdate("v9.0.1", open);
  announceForkUpdate("v9.0.1", open);
  expect(add).toHaveBeenCalledTimes(1);
  expect(add.mock.calls[0]?.[0]).toMatchObject({ title: "T3 Code v9.0.1 is out" });

  // A tag already announced in an earlier window stays quiet; a newer one speaks again.
  localStorage.setItem(KEY, JSON.stringify("v9.0.2"));
  announceForkUpdate("v9.0.2", open);
  expect(add).toHaveBeenCalledTimes(1);
  announceForkUpdate("v9.0.3", open);
  expect(add).toHaveBeenCalledTimes(2);
  expect(JSON.parse(localStorage.getItem(KEY)!)).toBe("v9.0.3");
});

it("keeps the rail entry for a fork checkout and dots it only for a new upstream tag", async () => {
  using _add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
  localStorage.removeItem(CHECKOUT_KEY);
  fork.status = null;
  {
    // Not known as a fork yet, and the delayed first check has not run.
    await using _screen = await render(createElement(SidebarForkUpdatePill, { placement: "rail" }));
    await expect.element(railEntry()).not.toBeInTheDocument();
  }
  localStorage.setItem(CHECKOUT_KEY, "true");
  {
    await using screen = await render(createElement(SidebarForkUpdatePill, { placement: "rail" }));
    await expect.element(railEntry()).toHaveAccessibleName("Fork updates");
    expect(screen.container.querySelector("[data-slot=fork-update-dot]")).toBeNull();
  }
  fork.status = {
    available: true,
    behind: 3,
    headTag: "v1.0.0",
    upstreamTag: "v1.1.0",
    channel: "latest",
  };
  // The delayed first check starts its timer on mount, so the clock is faked before rendering.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    await using screen = await render(createElement(SidebarForkUpdatePill, { placement: "rail" }));
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await expect.element(railEntry()).toHaveAccessibleName(/v1\.1\.0 is out upstream/);
    expect(screen.container.querySelector("[data-slot=fork-update-dot]")).not.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
