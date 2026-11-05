import { expect, it, vi } from "vite-plus/test";

import { toastManager } from "../ui/toast";
import { announceForkUpdate } from "./SidebarForkUpdatePill";

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
