import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { AssistantAccentAvatar, AssistantAvatar } from "./assistantPresentation";

describe("assistant avatars", () => {
  it.each<[string, string | null, string | null, string]>([
    ["a known icon replaces the initial", "scout", "scout", ""],
    ["an unknown icon falls back to the initial", "laser", null, "J"],
    ["no icon shows the initial", null, null, "J"],
  ])("tinted avatar: %s", async (_name, icon, drawn, text) => {
    await using screen = await render(
      <AssistantAvatar assistant={{ name: "Jarvis", handle: "jarvis", icon }} />,
      { router: false }, // renders no routed content
    );
    expect(
      screen.container
        .querySelector("[data-assistant-icon]")
        ?.getAttribute("data-assistant-icon") ?? null,
    ).toBe(drawn);
    expect(screen.container.textContent).toBe(text);
  });

  it("accent avatar draws the icon, or the initial without one", async () => {
    await using withIcon = await render(
      <AssistantAccentAvatar assistantId="a1" name="Jarvis" icon="spark" />,
      { router: false }, // renders no routed content
    );
    expect(withIcon.container.querySelector('[data-assistant-icon="spark"]')).not.toBeNull();
    expect(withIcon.container.textContent).toBe("");
    await using without = await render(<AssistantAccentAvatar assistantId="a1" name="Jarvis" />, {
      router: false, // renders no routed content
    });
    expect(without.container.textContent).toBe("J");
  });
});
