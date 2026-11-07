import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: { pick: vi.fn(), onChange: vi.fn() },
}));
vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode; testID?: string }) => (
    <div data-testid={props.testID}>{props.children}</div>
  ),
  Pressable: (props: {
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean };
    onPress?: () => void;
    children?: ReactNode;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-checked={props.accessibilityState?.selected}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("expo-image", () => ({
  Image: (props: { source: { uri: string } }) => <img alt="Chosen avatar" src={props.source.uri} />,
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
vi.mock("./AssistantFormFields", () => ({ FieldHeader: () => null }));
vi.mock("./AssistantRobot", () => ({
  AssistantRobot: (props: { look: { hue: number; variant: number } }) => (
    <i data-robot={`${props.look.hue}:${props.look.variant}`} />
  ),
}));
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: () => <b data-stored-avatar />,
}));
vi.mock("./assistantAvatarUpload", () => ({ pickAvatarImage: mocks.pick }));

import { AssistantAvatarPicker } from "./AssistantAvatarPicker";

let root: Root;
let container: HTMLDivElement;
type Value = Parameters<typeof AssistantAvatarPicker>[0]["value"];
const render = (value: Value, assistant: unknown = null) =>
  act(async () =>
    root.render(
      <AssistantAvatarPicker
        value={value}
        assistant={assistant as never}
        environmentId={"env" as never}
        onChange={mocks.onChange}
      />,
    ),
  );
const click = (label: string) =>
  act(async () => {
    const buttons = Array.from(container.querySelectorAll("button"));
    buttons
      .find((entry) => entry.getAttribute("aria-label") === label || entry.textContent === label)!
      .click();
  });
const robot: Value = { avatar: { hue: 210, variant: 0 }, avatarImage: null };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.pick.mockReset();
  mocks.onChange.mockReset();
});
afterEach(() => act(() => root.unmount()));

describe("avatar picker", () => {
  it("offers the eight colors, marks the chosen one, and a color picks the robot", async () => {
    await render({ avatar: { hue: 30, variant: 2 }, avatarImage: null });
    expect(container.querySelectorAll('button[aria-label^="Color"]')).toHaveLength(8);
    expect(container.querySelector('[aria-label="Color 30"]')?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(container.querySelector('[aria-label="Color 210"]')?.getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(container.querySelectorAll("[data-robot$=':2']")).toHaveLength(8);
    await click("Color 150");
    expect(mocks.onChange).toHaveBeenCalledWith({
      avatar: { hue: 150, variant: 2 },
      avatarImage: null,
    });
  });

  it("shuffles the face and wraps after the eighth", async () => {
    await render({ avatar: { hue: 30, variant: 7 }, avatarImage: null });
    await click("Shuffle");
    expect(mocks.onChange).toHaveBeenCalledWith({
      avatar: { hue: 30, variant: 0 },
      avatarImage: null,
    });
  });

  it("uploads a valid image, and shows it with a way to remove it", async () => {
    mocks.pick.mockResolvedValue({ image: { previewUri: "file:///a.png" }, problem: null });
    await render(robot);
    expect(container.textContent).not.toContain("Remove image");
    await click("Upload image");
    expect(mocks.onChange).toHaveBeenCalledWith({
      ...robot,
      avatarImage: { kind: "file", file: { previewUri: "file:///a.png" } },
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();

    mocks.onChange.mockReset();
    const picked = { ...robot, avatarImage: { kind: "file", file: { previewUri: "p.png" } } };
    await render(picked as never);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("p.png");
    expect(container.querySelector('[aria-label="Color 210"]')?.getAttribute("aria-checked")).toBe(
      "false",
    );
    await click("Remove image");
    expect(mocks.onChange).toHaveBeenCalledWith({ ...robot, avatarImage: null });
  });

  it.each([
    ["a file of the wrong type", "Use a PNG, JPEG or WebP image."],
    ["a file that is too big", "The image must be under 2 MB."],
  ])("says why %s was refused and changes nothing", async (_name, problem) => {
    mocks.pick.mockResolvedValue({ image: null, problem });
    await render(robot);
    await click("Upload image");
    expect(mocks.onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain(problem);
  });

  it("a cancelled pick says nothing, and any other choice clears an earlier problem", async () => {
    mocks.pick.mockResolvedValueOnce({ image: null, problem: "Nope." });
    await render(robot);
    await click("Upload image");
    expect(container.textContent).toContain("Nope.");
    await click("Color 5");
    expect(container.textContent).not.toContain("Nope.");
    mocks.pick.mockResolvedValue({ image: null, problem: null });
    await click("Upload image");
    expect(mocks.onChange).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Nope.");
  });

  it("keeps a stored picture through its own avatar, and clears it with Remove image", async () => {
    const stored: Value = { ...robot, avatarImage: { kind: "stored" } };
    await render(stored, { id: "a1" });
    expect(container.querySelector("[data-stored-avatar]")).not.toBeNull();
    await click("Remove image");
    expect(mocks.onChange).toHaveBeenCalledWith({ ...robot, avatarImage: null });
    await render(stored, null);
    expect(container.querySelector("[data-stored-avatar]")).toBeNull();
    expect(container.querySelector('[data-testid="avatar-image-preview"]')).not.toBeNull();
  });
});
