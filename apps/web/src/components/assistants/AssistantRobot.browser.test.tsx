import { newAssistantLook } from "@t3tools/client-runtime/assistantRobot";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import "../../index.css";
import { AssistantRobot } from "./AssistantRobot";

const eyesState = (container: HTMLElement, testId: string) => {
  const eyes = container.querySelector(`[data-testid="${testId}"] .assistant-robot-eyes`);
  if (!eyes) throw new Error(`no eyes in ${testId}`);
  return getComputedStyle(eyes).animationPlayState;
};

// regression: every animated robot blinked forever, including the ones scrolled off screen
it("animates a robot on screen and pauses one off screen", async () => {
  const look = newAssistantLook(0);
  await using screen = await render(
    <div>
      <div data-testid="on">
        <AssistantRobot look={look} animated />
      </div>
      <div data-testid="off" style={{ position: "fixed", top: -2000 }}>
        <AssistantRobot look={look} animated />
      </div>
    </div>,
    { router: false }, // a bare svg needs no route
  );
  await vi.waitFor(() => expect(eyesState(screen.container, "on")).toBe("running"));
  expect(eyesState(screen.container, "off")).toBe("paused");
});
