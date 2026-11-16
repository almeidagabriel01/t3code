import { describe, expect, it } from "vite-plus/test";

import { withMenuActionIconColors } from "./menu-action-colors";

const COLORS = { icon: "#fff", destructiveIcon: "#f00", disabledIcon: "#777" };

describe("withMenuActionIconColors", () => {
  it.each([
    ["an enabled action", {}, "#fff"],
    ["a destructive action", { destructive: true }, "#f00"],
    ["a disabled action", { disabled: true }, "#777"],
    ["a disabled destructive action", { disabled: true, destructive: true }, "#777"],
  ])("tints %s's icon by its state", (_name, attributes, imageColor) => {
    const [action] = withMenuActionIconColors(
      [{ id: "edit", title: "Edit", image: "pencil", attributes }],
      COLORS,
    );
    expect(action?.imageColor).toBe(imageColor);
  });

  it("dims a disabled action inside a submenu", () => {
    const [menu] = withMenuActionIconColors(
      [
        {
          title: "More",
          subactions: [
            { id: "edit", title: "Edit", image: "pencil", attributes: { disabled: true } },
          ],
        },
      ],
      COLORS,
    );
    expect(menu?.subactions?.[0]?.imageColor).toBe("#777");
  });
});
