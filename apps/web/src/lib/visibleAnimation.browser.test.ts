import { expect, it, vi } from "vite-plus/test";

import { observeVisibleAnimation } from "./visibleAnimation";

const stateOf = (element: HTMLElement) =>
  element.style.getPropertyValue("--visible-animation-state");

function observed() {
  const element = document.createElement("div");
  element.style.height = "10px";
  document.body.append(element);
  const stop = observeVisibleAnimation(element);
  return {
    element,
    [Symbol.dispose]: () => {
      stop?.();
      element.remove();
    },
  };
}

it("pauses an on-screen animation while the document is hidden", async () => {
  let visibility: DocumentVisibilityState = "visible";
  using _visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockImplementation(() => visibility);
  using animation = observed();
  await vi.waitFor(() => expect(stateOf(animation.element)).toBe("running"));

  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(stateOf(animation.element)).toBe("paused");
});

it("pauses an on-screen animation while the user prefers reduced motion", async () => {
  const query = Object.assign(new EventTarget(), { matches: false });
  using _media = vi.spyOn(window, "matchMedia").mockReturnValue(query as unknown as MediaQueryList);
  using animation = observed();
  await vi.waitFor(() => expect(stateOf(animation.element)).toBe("running"));

  query.matches = true;
  query.dispatchEvent(new Event("change"));
  expect(stateOf(animation.element)).toBe("paused");
});
