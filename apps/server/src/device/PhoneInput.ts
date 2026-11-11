import type { DeviceIssueReason, DeviceUserInput } from "@t3tools/contracts";

/** The capture helper's `/config`: the encoded frame, and the captured one before scaling. */
export interface CaptureScreen {
  readonly width: number;
  readonly height: number;
  /** Absent from helpers built before it; the encoded size is the captured one only below 1920. */
  readonly sourceWidth?: number | undefined;
  readonly sourceHeight?: number | undefined;
}

/**
 * The screen in UIKit points, oriented like the frame: agent-device's iOS runner taps at point
 * offsets from the app's origin, while the capture is in pixels.
 */
export const phonePointSize = (screen: CaptureScreen) => {
  const width = screen.sourceWidth ?? screen.width;
  const height = screen.sourceHeight ?? screen.height;
  const short = Math.min(width, height);
  const aspect = Math.max(width, height) / short;
  // iPads are 2x; iPhones 3x, except the 2x LCD ones and two downsampled 1080-pixel panels:
  // the Plus (414 points across) and the mini (375).
  const scale =
    aspect < 1.7 ? 2 : short <= 828 ? 2 : short === 1080 ? 1080 / (aspect < 1.8 ? 414 : 375) : 3;
  return { width: width / scale, height: height / scale };
};

/** An `agent_device.command` request without its session and target flags. */
export interface AgentDeviceRequest {
  readonly command: string;
  readonly positionals: ReadonlyArray<string>;
  readonly input?: Readonly<Record<string, unknown>>;
}

const point = (value: number) => Math.round(value);

export const phoneInputCommand = (
  input: DeviceUserInput,
  points: { readonly width: number; readonly height: number },
): AgentDeviceRequest => {
  switch (input.type) {
    case "tap":
      return {
        command: "press",
        positionals: [
          String(point(input.x * points.width)),
          String(point(input.y * points.height)),
        ],
      };
    case "swipe": {
      const x = point(input.x * points.width);
      const y = point(input.y * points.height);
      return {
        command: "gesture",
        positionals: [],
        input: {
          kind: "pan",
          origin: { x, y },
          delta: {
            x: point(input.toX * points.width) - x,
            y: point(input.toY * points.height) - y,
          },
          durationMs: input.durationMs,
        },
      };
    }
    case "text":
      return { command: "type", positionals: [input.text] };
    case "button":
      return { command: input.button === "home" ? "home" : "app-switcher", positionals: [] };
  }
};

/** What only the user can fix, from agent-device's runner failure reasons. */
export const phoneRunnerIssue = (reason: string | undefined): DeviceIssueReason | undefined => {
  if (reason === undefined) return undefined;
  if (reason.startsWith("signing_") || reason === "bundle_identifier_already_registered")
    return "signing_missing";
  if (reason.endsWith("developer_mode_disabled")) return "developer_mode_off";
  return undefined;
};
