import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useCommitOnBlur } from "../../hooks/useCommitOnBlur";
import { SettingsPageShell } from "./SettingsPageShell";

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

describe("SettingsPageShell", () => {
  it("renders in the page, not a dialog, and Esc commits a focused field then leaves", async () => {
    const onCommit = vi.fn();
    await using screen = await render(
      <SettingsPageShell pathname="/settings/general">
        <CommitOnBlurField onCommit={onCommit} />
      </SettingsPageShell>,
      { router: "/settings/general" },
    );

    expect(screen.container.querySelector('[role="dialog"]')).toBeNull();
    await expect
      .element(page.getByRole("navigation", { name: "Settings breadcrumb" }))
      .toBeVisible();

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/"));
  });

  it("leaves with the close button", async () => {
    await using screen = await render(
      <SettingsPageShell pathname="/settings/imessage">{null}</SettingsPageShell>,
      { router: "/settings/imessage" },
    );

    await page.getByRole("button", { name: "Close settings" }).click();

    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/"));
  });
});
