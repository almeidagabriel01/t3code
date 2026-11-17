import { AssistantId, type Assistant } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { AssistantAvatar, AssistantCluster, removedAssistantFace } from "./assistantPresentation";

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

    it("plays only on an animated avatar whose mood moves", async () => {
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
  });

  it.each([
    [1, 1, null],
    [2, 2, null],
    [3, 3, null],
    [4, 4, null],
    [5, 3, "+2"],
    [6, 3, "+3"],
    [12, 3, "+9"],
  ])("a cluster of %i draws %i faces and %s", async (count, drawn, more) => {
    const faces = Array.from({ length: count }, (_, index) => ({
      key: `a${index}`,
      assistant: removedAssistantFace(`a${index}`),
    }));
    await using screen = await render(<AssistantCluster faces={faces} />, {
      router: false, // renders no routed content
    });
    const cluster = screen.container.querySelector("[data-assistant-cluster]");
    expect(cluster?.getAttribute("data-assistant-cluster")).toBe(String(count));
    expect(cluster?.querySelectorAll("[data-assistant-robot]")).toHaveLength(drawn);
    expect(cluster?.querySelector("[data-assistant-cluster-more]")?.textContent ?? null).toBe(more);
  });
});
