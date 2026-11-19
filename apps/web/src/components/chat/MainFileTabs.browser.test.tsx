import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { act, render } from "../../../test/render";
import type { ThreadFileSurface } from "../../threadTabsStore";
import { MainFileTabs } from "./MainFileTabs";

const file = (relativePath: string): ThreadFileSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealLine: null,
  revealRequestId: 1,
});

describe("MainFileTabs", () => {
  it("leads with the thread's chat under its title, then its files", async () => {
    const onShowChat = vi.fn();
    const onActivate = vi.fn();
    const onClose = vi.fn();
    const files = [file("src/app.ts"), file("README.md")];
    await using screen = await render(
      <MainFileTabs
        title="Plan the release"
        files={files}
        activeFileId="file:src/app.ts"
        pendingIds={new Set()}
        onShowChat={onShowChat}
        onActivate={onActivate}
        onClose={onClose}
      />,
      // No route reads this strip; it renders inside ChatView's own route.
      { router: false },
    );
    const chat = screen.getByRole("tab", { name: "Plan the release" });
    await expect.element(chat).toHaveAttribute("aria-selected", "false");
    await expect
      .element(screen.getByRole("tab", { name: "app.ts" }))
      .toHaveAttribute("aria-selected", "true");

    await userEvent.click(chat);
    expect(onShowChat).toHaveBeenCalledTimes(1);
    (screen.getByRole("tab", { name: "README.md" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(onActivate).toHaveBeenCalledWith(files[1]);
    await act(() => {
      screen
        .getByRole("tab", { name: "README.md" })
        .element()
        .dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    });
    expect(onClose).toHaveBeenCalledWith(files[1]);
  });
});
