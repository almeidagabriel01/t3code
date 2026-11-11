import { describe, expect, it } from "@effect/vitest";

import { phoneInputCommand, phonePointSize, phoneRunnerIssue } from "./PhoneInput.ts";

describe("phonePointSize", () => {
  it.each([
    ["a 3x iPhone at full size", { width: 1179, height: 2556 }, [393, 852]],
    [
      "a 3x Pro Max the helper scaled to 1920",
      { width: 884, height: 1920, sourceWidth: 1320, sourceHeight: 2868 },
      [440, 956],
    ],
    [
      "the same phone held sideways",
      { width: 1920, height: 884, sourceWidth: 2868, sourceHeight: 1320 },
      [956, 440],
    ],
    ["a 2x LCD iPhone", { width: 828, height: 1792 }, [414, 896]],
    ["a 2x iPhone SE", { width: 750, height: 1334 }, [375, 667]],
    ["a Plus's downsampled 1080p panel", { width: 1080, height: 1920 }, [414, 736]],
    // 812 points, within the half point the 2.88 downsampling leaves.
    ["a mini's downsampled panel", { width: 1080, height: 2340 }, [375, 812.5]],
    [
      "a 2x iPad",
      { width: 1334, height: 1920, sourceWidth: 1640, sourceHeight: 2360 },
      [820, 1180],
    ],
  ] as const)("%s", (_name, screen, [width, height]) => {
    const size = phonePointSize(screen);
    expect(size.width).toBeCloseTo(width, 5);
    expect(size.height).toBeCloseTo(height, 5);
  });
});

describe("phoneInputCommand", () => {
  const points = { width: 393, height: 852 };
  it.each([
    [
      { type: "tap", x: 0.5, y: 0.25 },
      { command: "press", positionals: ["197", "213"] },
    ],
    [
      { type: "swipe", x: 0.5, y: 0.8, toX: 0.5, toY: 0.2, durationMs: 300 },
      {
        command: "gesture",
        positionals: [],
        input: {
          kind: "pan",
          origin: { x: 197, y: 682 },
          delta: { x: 0, y: -512 },
          durationMs: 300,
        },
      },
    ],
    [
      { type: "text", text: "hi\n" },
      { command: "type", positionals: ["hi\n"] },
    ],
    [
      { type: "button", button: "home" },
      { command: "home", positionals: [] },
    ],
    [
      { type: "button", button: "appSwitcher" },
      { command: "app-switcher", positionals: [] },
    ],
  ] as const)("%o", (input, expected) => {
    expect(phoneInputCommand(input, points)).toEqual(expected);
  });
});

describe("phoneRunnerIssue", () => {
  it.each([
    ["signing_no_development_team", "signing_missing"],
    ["signing_provisioning_profile_missing", "signing_missing"],
    ["bundle_identifier_already_registered", "signing_missing"],
    ["device_developer_mode_disabled", "developer_mode_off"],
    ["devtools_security_developer_mode_disabled", "developer_mode_off"],
    ["build_failed_unclassified", undefined],
    [undefined, undefined],
  ] as const)("%s → %s", (reason, expected) => {
    expect(phoneRunnerIssue(reason)).toBe(expected);
  });
});
