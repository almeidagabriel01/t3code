import { AssistantId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    asset: { _tag: "Loading" } as { _tag: string; url?: string },
    resource: undefined as unknown,
    revision: undefined as unknown,
    environment: undefined as unknown,
  },
}));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("react-native-svg", () => {
  const tag = (name: string) => (props: Record<string, unknown> & { children?: ReactNode }) => {
    const { children, testID } = props;
    return (
      <i
        data-tag={name}
        data-testid={testID as string | undefined}
        data-props={JSON.stringify(props, (k, v) => (k === "children" ? undefined : v))}
      >
        {children}
      </i>
    );
  };
  return {
    default: tag("svg"),
    Path: tag("path"),
    Circle: tag("circle"),
    Defs: tag("defs"),
    Line: tag("line"),
    LinearGradient: tag("linear"),
    RadialGradient: tag("radial"),
    Rect: tag("rect"),
    Stop: tag("stop"),
  };
});
vi.mock("expo-image", () => ({
  Image: (props: { source: { uri: string }; onError: () => void }) => (
    <button data-image={props.source.uri} onClick={props.onError} />
  ),
}));
vi.mock("uniwind", () => ({ withUniwind: <T,>(component: T) => component }));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({
    active: [{ environmentId: "hub", assistant: { id: "a1" } }],
    archived: [],
  }),
}));
vi.mock("../../state/assets", () => ({
  useAssetUrlState: (environmentId: unknown, resource: unknown, revision: unknown) => {
    mocks.environment = environmentId;
    mocks.resource = resource;
    mocks.revision = revision;
    return mocks.asset;
  },
}));

import { AssistantAvatar, AssistantIconGlyph } from "./assistantPresentation";
import { AssistantRobot } from "./AssistantRobot";

const draw = (node: ReactNode) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = window.document.createElement("div");
  act(() => createRoot(container).render(node));
  return container;
};

const id = AssistantId.make("a1");
const robot = { id, avatar: { kind: "robot", hue: 210, variant: 0 }, icon: null } as const;

beforeEach(() => {
  mocks.asset = { _tag: "Loading" };
});

describe("AssistantRobot", () => {
  it.each([
    ["idle", "rect", 2],
    ["working", "path", 2],
    ["needs", "circle", 3],
    ["failed", "path", 2],
  ] as const)("%s face draws its eyes", (mood, tag, minimum) => {
    const container = draw(
      <AssistantRobot look={{ hue: 210, variant: 0 }} mood={mood} size={24} />,
    );
    expect(container.querySelector(`[data-testid="assistant-robot-${mood}"]`)).not.toBeNull();
    expect(container.querySelectorAll(`[data-tag="${tag}"]`).length).toBeGreaterThanOrEqual(
      minimum,
    );
  });

  it.each([
    [0, "single", false],
    [1, "double", false],
    [2, "none", false],
    [3, "ring", false],
    [4, "single", true],
  ])("variant %i draws the %s antenna, ears %s", (variant, antenna, ears) => {
    const container = draw(<AssistantRobot look={{ hue: 5, variant }} size={24} />);
    expect(container.querySelector('[data-testid="assistant-robot-idle"]')).not.toBeNull();
    const lines = container.querySelectorAll('[data-tag="line"]').length;
    expect(lines).toBe({ single: 1, double: 2, none: 0, ring: 1 }[antenna]);
    const earRects = [...container.querySelectorAll('[data-tag="rect"]')].filter(
      (node) => JSON.parse(node.getAttribute("data-props")!).fillOpacity === 0.6,
    );
    expect(earRects.length).toBe(ears ? 2 : 0);
  });
});

describe("AssistantAvatar", () => {
  it("draws the derived robot for no avatar and no icon, with the mood", () => {
    const container = draw(
      <AssistantAvatar assistant={{ id, avatar: null, icon: null }} mood="needs" />,
    );
    expect(container.querySelector('[data-testid="assistant-robot-needs"]')).not.toBeNull();
  });

  it("keeps the legacy icon only while no avatar is chosen", () => {
    const icon = draw(<AssistantAvatar assistant={{ ...robot, avatar: null, icon: "scout" }} />);
    expect(icon.querySelectorAll('[data-tag="path"]').length).toBeGreaterThan(1);
    expect(icon.querySelector('[data-tag="defs"]')).toBeNull();
    const chosen = draw(<AssistantAvatar assistant={{ ...robot, icon: "scout" }} />);
    expect(chosen.querySelector('[data-testid="assistant-robot-idle"]')).not.toBeNull();
  });

  it("an image avatar loads its signed url, falls back to the robot until it arrives or fails", () => {
    const assistant = { id, avatar: { kind: "image", revision: 4 }, icon: null } as const;
    expect(
      draw(<AssistantAvatar assistant={assistant} />).querySelector(
        '[data-testid="assistant-robot-idle"]',
      ),
    ).not.toBeNull();
    // The environment comes from the assistant list when the caller has none.
    expect(mocks.environment).toBe("hub");
    expect(mocks.resource).toEqual({ _tag: "assistant-avatar", assistantId: "a1" });
    expect(mocks.revision).toBe("4");

    mocks.asset = { _tag: "Success", url: "https://x/avatar" };
    const container = draw(
      <AssistantAvatar assistant={assistant} environmentId={"env" as never} />,
    );
    expect(mocks.environment).toBe("env");
    const image = container.querySelector<HTMLElement>("[data-image]")!;
    expect(image.getAttribute("data-image")).toBe("https://x/avatar");
    act(() => image.click());
    expect(container.querySelector("[data-image]")).toBeNull();
    expect(container.querySelector('[data-testid="assistant-robot-idle"]')).not.toBeNull();
  });
});

describe("AssistantIconGlyph", () => {
  it("draws a bare glyph in the given color, and nothing for an unknown id", () => {
    expect(
      JSON.parse(
        draw(<AssistantIconGlyph icon="spark" size={20} color="#fff" />)
          .querySelector('[data-tag="svg"]')!
          .getAttribute("data-props")!,
      ).color,
    ).toBe("#fff");
    expect(draw(<AssistantIconGlyph icon="laser" size={20} />).querySelector("svg")).toBeNull();
  });
});
