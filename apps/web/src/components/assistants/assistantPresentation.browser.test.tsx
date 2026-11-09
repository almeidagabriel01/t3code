import { AssistantId, type Assistant } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { AssistantAccentAvatar, AssistantAvatar } from "./assistantPresentation";

type AssistantAvatarValue = Assistant["avatar"];

describe("assistant avatars", () => {
  it.each<[string, AssistantAvatarValue, string | null, string | null, string | null]>([
    ["a legacy icon shows until an avatar is set", null, "scout", "scout", null],
    ["an unknown icon falls back to the robot", null, "laser", null, "idle"],
    ["no icon and no avatar derive a robot", null, null, null, "idle"],
    ["a chosen robot replaces the legacy icon", { kind: "robot", hue: 30 }, "scout", null, "idle"],
    [
      "an image waits as a robot until its URL arrives",
      { kind: "image", revision: 1 },
      null,
      null,
      "idle",
    ],
  ])("avatar: %s", async (_name, avatar, icon, drawnIcon, robot) => {
    await using screen = await render(
      <AssistantAvatar assistant={{ id: AssistantId.make("a1"), avatar, icon }} />,
      { router: false }, // renders no routed content
    );
    const attribute = (name: string) =>
      screen.container.querySelector(`[${name}]`)?.getAttribute(name) ?? null;
    expect(attribute("data-assistant-icon")).toBe(drawnIcon);
    expect(attribute("data-assistant-robot")).toBe(robot);
  });

  it("the robot's face follows its mood", async () => {
    await using screen = await render(
      <AssistantAvatar
        assistant={{ id: AssistantId.make("a1"), avatar: null, icon: null }}
        mood="needs"
      />,
      { router: false }, // renders no routed content
    );
    expect(screen.container.querySelector('[data-assistant-robot="waiting"]')).not.toBeNull();
  });

  describe("robot motion", () => {
    const assistant = { id: AssistantId.make("a1"), avatar: null, icon: null };
    const motionOf = async (node: React.ReactElement) => {
      await using screen = await render(node, { router: false }); // renders no routed content
      return screen.container
        .querySelector("[data-assistant-motion]")
        ?.getAttribute("data-assistant-motion");
    };

    it("plays only when animated, visible and motion is allowed", async () => {
      expect(await motionOf(<AssistantAvatar assistant={assistant} animated />)).toBe("blink");
      expect(
        await motionOf(<AssistantAvatar assistant={assistant} mood="working" animated />),
      ).toBe("think");
      expect(await motionOf(<AssistantAvatar assistant={assistant} mood="failed" animated />)).toBe(
        undefined,
      );
      // small avatars never ask for it
      expect(await motionOf(<AssistantAvatar assistant={assistant} />)).toBe(undefined);
    });

    it("stops while the document is hidden", async () => {
      using _hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      expect(await motionOf(<AssistantAvatar assistant={assistant} animated />)).toBe(undefined);
    });

    it("stops with reduced motion", async () => {
      using _reduced = vi.spyOn(window, "matchMedia").mockImplementation(
        (query) =>
          ({
            matches: query.includes("reduce"),
            addEventListener: () => {},
            removeEventListener: () => {},
          }) as unknown as MediaQueryList,
      );
      expect(await motionOf(<AssistantAvatar assistant={assistant} animated />)).toBe(undefined);
    });
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
