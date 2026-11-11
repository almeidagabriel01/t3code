import type { DeviceUserInput } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createPhoneGesture,
  createPhoneInputSender,
  createPhoneTextBuffer,
  phoneKeyText,
  type PhoneInputState,
} from "./phoneInput.ts";

type Step = readonly ["begin" | "move" | "end", number, number, number];

describe("createPhoneGesture", () => {
  it.each<{ name: string; steps: ReadonlyArray<Step>; expected: ReadonlyArray<DeviceUserInput> }>([
    {
      name: "a still press is a tap where it began",
      steps: [
        ["begin", 0.5, 0.5, 0],
        ["move", 0.51, 0.505, 40],
        ["end", 0.51, 0.51, 90],
      ],
      expected: [{ type: "tap", x: 0.5, y: 0.5 }],
    },
    {
      name: "a drag is a swipe that took as long as the drag",
      steps: [
        ["begin", 0.5, 0.8, 1_000],
        ["move", 0.5, 0.5, 1_200],
        ["end", 0.5, 0.2, 1_350.4],
      ],
      expected: [{ type: "swipe", x: 0.5, y: 0.8, toX: 0.5, toY: 0.2, durationMs: 350 }],
    },
    {
      name: "a flick shorter than the runner allows is lengthened",
      steps: [
        ["begin", 0.1, 0.5, 0],
        ["end", 0.9, 0.5, 5],
      ],
      expected: [{ type: "swipe", x: 0.1, y: 0.5, toX: 0.9, toY: 0.5, durationMs: 16 }],
    },
    {
      name: "a drag held past the runner's limit is cut to it",
      steps: [
        ["begin", 0.1, 0.1, 0],
        ["end", 0.1, 0.9, 30_000],
      ],
      expected: [{ type: "swipe", x: 0.1, y: 0.1, toX: 0.1, toY: 0.9, durationMs: 10_000 }],
    },
    {
      name: "an end without a begin sends nothing",
      steps: [["end", 0.4, 0.4, 0]],
      expected: [],
    },
  ])("$name", ({ steps, expected }) => {
    const sent: Array<DeviceUserInput> = [];
    let time = 0;
    const gesture = createPhoneGesture(
      (input) => sent.push(input),
      () => time,
    );
    for (const [phase, x, y, at] of steps) {
      time = at;
      gesture.touch(phase, x, y);
    }
    expect(sent).toEqual(expected);
  });
});

describe("phoneKeyText", () => {
  it.each([
    [{ key: "a" }, "a"],
    [{ key: "Enter" }, "\n"],
    [{ key: "Backspace" }, "\b"],
    [{ key: "ArrowLeft" }, null],
    [{ key: "v", metaKey: true }, null],
    [{ key: "c", ctrlKey: true }, null],
  ])("%o types %j", (event, expected) => {
    expect(phoneKeyText({ metaKey: false, ctrlKey: false, altKey: false, ...event })).toBe(
      expected,
    );
  });
});

describe("createPhoneTextBuffer", () => {
  it("sends typed keys as one text once typing pauses, in chunks the contract accepts", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const buffer = createPhoneTextBuffer(send);
    buffer.add("h");
    buffer.add("i");
    vi.advanceTimersByTime(399);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send.mock.calls).toEqual([[{ type: "text", text: "hi" }]]);
    buffer.add("x".repeat(2_500));
    buffer.flush();
    expect(send.mock.calls.slice(1).map(([input]) => input.text.length)).toEqual([2_000, 500]);
    buffer.flush();
    expect(send).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

describe("createPhoneInputSender", () => {
  it("sends one input at a time, in order, and reports the last failure until one lands", async () => {
    const runs: Array<{ input: DeviceUserInput; settle: (error: string | null) => void }> = [];
    const states: PhoneInputState[] = [];
    const send = createPhoneInputSender(
      (input) => new Promise((settle) => runs.push({ input, settle })),
      (state) => states.push(state),
    );
    send({ type: "tap", x: 0.1, y: 0.1 });
    send({ type: "button", button: "home" });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0]!.settle("The phone is locked.");
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]!.input).toEqual({ type: "button", button: "home" });
    expect(states.at(-1)).toEqual({ pending: true, error: "The phone is locked." });
    runs[1]!.settle(null);
    await vi.waitFor(() => expect(states.at(-1)).toEqual({ pending: false, error: null }));
  });

  it("reports a thrown failure and keeps sending", async () => {
    const states: PhoneInputState[] = [];
    const run = vi
      .fn<(input: DeviceUserInput) => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("Socket closed"))
      .mockRejectedValueOnce("nope")
      .mockResolvedValueOnce(null);
    const send = createPhoneInputSender(run, (state) => states.push(state));
    send({ type: "text", text: "a" });
    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({ pending: false, error: "Socket closed" }),
    );
    send({ type: "text", text: "b" });
    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({ pending: false, error: "The phone did not take the input." }),
    );
    send({ type: "text", text: "c" });
    await vi.waitFor(() => expect(states.at(-1)).toEqual({ pending: false, error: null }));
  });
});
