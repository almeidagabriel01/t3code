import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ProjectRowMenuButton } from "./ProjectRowMenuButton";

describe("ProjectRowMenuButton", () => {
  it.each([
    { takesRightEdge: true, aligned: true },
    { takesRightEdge: false, aligned: false },
  ])("opens the row menu; right edge=$takesRightEdge", async ({ takesRightEdge, aligned }) => {
    const onOpen = vi.fn();
    await using screen = await render(
      <ProjectRowMenuButton name="Alpha" takesRightEdge={takesRightEdge} onOpen={onOpen} />,
      { router: false },
    );
    const button = screen.getByRole("button", { name: "Actions for Alpha" });
    await userEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(button.element().classList.contains("ml-auto")).toBe(aligned);
  });
});
