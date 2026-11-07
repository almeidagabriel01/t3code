import { EnvironmentId, MessageId, RunId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  ASSISTANT_ROBOT_HUES,
  assistantPresence,
  assistantRobotLook,
  assistantRobotSpec,
} from "./assistantRobot.ts";
import { presentThreadShell } from "./state/models.ts";
import { v2ThreadShell } from "./state/orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("environment-local");
const at = DateTime.makeUnsafe("2026-11-06T12:00:00.000Z");

const shell = (overrides: Partial<typeof v2ThreadShell>) =>
  presentThreadShell(environmentId, { ...v2ThreadShell, ...overrides } as typeof v2ThreadShell);

const said = (text: string, role: "assistant" | "user" = "assistant") => ({
  latestVisibleMessage: { id: MessageId.make("m1"), role, text, updatedAt: at },
});

describe("assistantRobotLook", () => {
  it("uses the assistant's own robot, else one its id always derives", () => {
    expect(assistantRobotLook({ id: "a", avatar: { kind: "robot", hue: 42, variant: 5 } })).toEqual(
      { hue: 42, variant: 5 },
    );
    expect(assistantRobotLook({ id: "a", avatar: { kind: "robot", hue: 42 } })).toEqual({
      hue: 42,
      variant: 0,
    });
    const derived = assistantRobotLook({ id: "jarvis", avatar: null });
    expect(assistantRobotLook({ id: "jarvis", avatar: { kind: "image", revision: 1 } })).toEqual(
      derived,
    );
    expect(ASSISTANT_ROBOT_HUES).toContain(derived.hue);
    expect(derived.variant).toBeGreaterThanOrEqual(0);
    expect(derived.variant).toBeLessThan(8);
  });
});

describe("assistantRobotSpec", () => {
  it.each([
    ["idle", "open"],
    ["working", "focused"],
    ["needs", "alert"],
    ["failed", "crossed"],
  ] as const)("a %s robot has %s eyes", (mood, eyes) => {
    expect(assistantRobotSpec({ hue: 210, variant: 0 }, mood).eyes).toBe(eyes);
  });

  it("every variant is a distinct antenna and ear pair, and out-of-range input wraps", () => {
    const looks = Array.from({ length: 8 }, (_, variant) => {
      const spec = assistantRobotSpec({ hue: 0, variant }, "idle");
      return `${spec.antenna}/${spec.ears}`;
    });
    expect(new Set(looks).size).toBe(8);
    expect(assistantRobotSpec({ hue: 370, variant: 9 }, "idle")).toEqual(
      assistantRobotSpec({ hue: 10, variant: 1 }, "idle"),
    );
    expect(assistantRobotSpec({ hue: -30, variant: -1 }, "idle").gradientFrom).toBe(
      "hsl(330 85% 66%)",
    );
  });
});

describe("assistantPresence", () => {
  it.each([
    ["no thread yet", null, { mood: "idle", detail: "Idle", since: null }],
    [
      "an approval",
      shell({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("r1"),
          kind: "command_approval",
          createdAt: at,
        },
      } as never),
      { mood: "needs", detail: "Needs your approval", since: null },
    ],
    [
      "a question",
      shell({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("r1"),
          kind: "user_input",
          createdAt: at,
        },
      } as never),
      { mood: "needs", detail: "Asked you a question", since: null },
    ],
    [
      "a guest message",
      shell({ pendingGuestMessageCount: 1 }),
      { mood: "needs", detail: "A guest message waits for you", since: null },
    ],
    [
      "a run that already said what it does",
      shell({
        latestRunId: RunId.make("run-1"),
        activeRunId: RunId.make("run-1"),
        activityRunStatus: "running",
        activityRunStartedAt: at,
        status: "running",
        ...said("\n  Running the test suite now.\nThen the build."),
      }),
      { mood: "working", detail: "Running the test suite now.", since: "2026-11-06T12:00:00.000Z" },
    ],
    [
      "a run that has not spoken",
      shell({
        latestRunId: RunId.make("run-1"),
        activeRunId: RunId.make("run-1"),
        activityRunStatus: "running",
        status: "running",
        ...said("do the thing", "user"),
      }),
      { mood: "working", detail: "Working" },
    ],
    [
      "a failed run",
      shell({ latestRunId: RunId.make("run-1"), status: "failed" }),
      { mood: "failed", detail: "Last run failed" },
    ],
    [
      "a usage limit",
      shell({ latestRunId: RunId.make("run-1"), status: "failed", lastErrorClass: "usage_limit" }),
      { mood: "failed", detail: "Hit a usage limit", since: null },
    ],
    [
      "a finished reply",
      shell({ ...said("x".repeat(100)) }),
      { mood: "idle", detail: `${"x".repeat(79)}…`, since: "2026-11-06T12:00:00.000Z" },
    ],
  ] as const)("%s", (_name, thread, expected) => {
    expect(assistantPresence(thread)).toMatchObject(expected);
  });
});
