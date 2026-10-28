import { describe, expect, it } from "vite-plus/test";

import { shouldStartPan, wheelToHorizontalDelta } from "./boardPan";

describe("shouldStartPan", () => {
  const base = { button: 0, pointerType: "mouse", onInteractive: false };
  it("starts only for a primary mouse press on background", () => {
    expect(shouldStartPan(base)).toBe(true);
    expect(shouldStartPan({ ...base, button: 2 })).toBe(false);
    expect(shouldStartPan({ ...base, pointerType: "touch" })).toBe(false);
    expect(shouldStartPan({ ...base, onInteractive: true })).toBe(false);
  });
});

describe("wheelToHorizontalDelta", () => {
  it("maps vertical wheel to horizontal and leaves horizontal gestures alone", () => {
    expect(wheelToHorizontalDelta(0, 40)).toBe(40);
    expect(wheelToHorizontalDelta(30, 5)).toBeNull();
  });
});
