import { EnvironmentId, MessageId, RunId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  ASSISTANT_ROBOT_HUES,
  newAssistantLook,
  assistantGroupOwnerKey,
  assistantFace,
  assistantGroupThreadsOf,
  assistantPresence,
  assistantQueuedLabel,
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
    ["limited", "alert"],
    ["reading", "open"],
    ["waiting", "alert"],
    ["done", "happy"],
    ["sleeping", "closed"],
  ] as const)("a %s robot has %s eyes", (mood, eyes) => {
    expect(assistantRobotSpec({ hue: 210, variant: 0 }, mood).eyes).toBe(eyes);
  });

  it.each([
    ["idle", "blink", null],
    ["reading", "glance", null],
    ["working", "think", null],
    ["needs", null, "dot"],
    ["failed", null, "ring"],
    ["done", null, null],
    ["sleeping", null, null],
  ] as const)("a %s robot moves with %s and wears badge %s", (mood, motion, badge) => {
    const spec = assistantRobotSpec({ hue: 210, variant: 0 }, mood);
    expect(spec.motion).toBe(motion);
    expect(spec.badge?.kind ?? null).toBe(badge);
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

describe("assistantFace", () => {
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  const ago = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(now - ms));
  it.each([
    ["working on a reply", { mood: "working", reading: false, since: null }, "working"],
    ["working before saying anything", { mood: "working", reading: true, since: null }, "reading"],
    ["needing the user", { mood: "needs", reading: false, since: null }, "waiting"],
    ["failed", { mood: "failed", reading: false, since: null }, "failed"],
    ["never spoke", { mood: "idle", reading: false, since: null }, "idle"],
    ["just replied", { mood: "idle", reading: false, since: ago(3_000) }, "done"],
    ["replied a minute ago", { mood: "idle", reading: false, since: ago(60_000) }, "idle"],
    ["quiet for a day", { mood: "idle", reading: false, since: ago(24 * 3_600_000) }, "sleeping"],
    ["unparsable moment", { mood: "idle", reading: false, since: "soon" }, "idle"],
    ["a reply from the future", { mood: "idle", reading: false, since: ago(-5_000) }, "idle"],
  ] as const)("%s", (_name, presence, face) => {
    expect(assistantFace(presence, now)).toBe(face);
  });

  it("without a clock it never reports done or sleeping", () => {
    expect(assistantFace({ mood: "idle", reading: false, since: ago(3_000) })).toBe("idle");
    expect(assistantFace({ mood: "idle", reading: false, since: ago(9e8) })).toBe("idle");
  });
});

describe("assistantPresence", () => {
  it.each([
    ["no thread yet", null, { mood: "idle", detail: "Idle", since: null, queued: 0 }],
    ["queued messages", shell({ queuedMessageCount: 3 }), { mood: "idle", queued: 3 }],
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
      {
        mood: "working",
        detail: "Running the test suite now.",
        since: "2026-11-06T12:00:00.000Z",
        reading: false,
      },
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
      { mood: "working", detail: "Working", reading: true },
    ],
    [
      "a failed run",
      shell({ latestRunId: RunId.make("run-1"), status: "failed" }),
      { mood: "failed", detail: "Last run failed" },
    ],
    [
      "a usage limit",
      shell({ latestRunId: RunId.make("run-1"), status: "failed", lastErrorClass: "usage_limit" }),
      { mood: "limited", detail: "Usage limit", since: null },
    ],
    [
      "a finished reply",
      shell({ ...said("x".repeat(100)) }),
      { mood: "idle", detail: `${"x".repeat(79)}…`, since: "2026-11-06T12:00:00.000Z" },
    ],
  ] as const)("%s", (_name, thread, expected) => {
    expect(assistantPresence(thread)).toMatchObject(expected);
  });

  it("says until when a usage limit holds it, in the platform's format", () => {
    const thread = shell({
      latestRunId: RunId.make("run-1"),
      status: "failed",
      lastErrorClass: "usage_limit",
      usageLimitResetAt: "2026-11-14T15:30:00.000Z" as never,
    });
    const limitLabel = (resetAt: string | null | undefined) =>
      resetAt == null ? null : `Limit until <${resetAt}>`;
    expect(assistantPresence(thread, [], limitLabel)).toMatchObject({
      mood: "limited",
      detail: "Limit until <2026-11-14T15:30:00.000Z>",
    });
    expect(assistantPresence(thread, [], () => null).detail).toBe("Usage limit");
  });
});

describe("assistantPresence with group threads", () => {
  const working = shell({
    id: "assistant:ada:g-0123456789abcdef" as never,
    title: "Ada · Leadership",
    latestRunId: RunId.make("run-1"),
    activeRunId: RunId.make("run-1"),
    activityRunStatus: "running",
    status: "running",
  });
  const asking = shell({
    title: "Ada · Ops",
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("r1"),
      kind: "command_approval",
      createdAt: at,
    },
  } as never);
  const failed = shell({ title: "Ada · Ops", latestRunId: RunId.make("run-1"), status: "failed" });

  it.each([
    [
      "an idle assistant working in a group",
      null,
      [working],
      { mood: "working", detail: "Working in Leadership" },
    ],
    ["a group approval", null, [asking], { mood: "needs", detail: "Needs your approval in Ops" }],
    ["a failed group task leaves it idle", null, [failed], { mood: "idle", detail: "Idle" }],
    [
      "its own conversation comes first",
      shell({ pendingGuestMessageCount: 1 }),
      [working],
      { mood: "needs", detail: "A guest message waits for you" },
    ],
  ] as const)("%s", (_name, own, groups, expected) => {
    expect(assistantPresence(own, groups)).toMatchObject(expected);
  });

  it("finds only the assistant's group threads in its environment", () => {
    const shells = [
      { environmentId: "e1", id: "assistant:ada:g-0123456789abcdef" },
      { environmentId: "e1", id: "assistant:ada:3" },
      { environmentId: "e2", id: "assistant:ada:g-0123456789abcdef" },
      { environmentId: "e1", id: "assistant:adam:g-0123456789abcdef" },
    ];
    expect(assistantGroupThreadsOf(shells, "e1", "ada")).toEqual([shells[0]]);
    expect(shells.map(assistantGroupOwnerKey)).toEqual(["e1:ada", undefined, "e2:ada", "e1:adam"]);
  });
});

describe("assistantQueuedLabel", () => {
  it.each([
    [0, null],
    [1, "1 queued"],
    [3, "3 queued"],
  ] as const)("%s", (queued, label) => {
    expect(assistantQueuedLabel(queued)).toBe(label);
  });
});

describe("newAssistantLook", () => {
  it("gives each of the first eight assistants its own color and face, the same every time", () => {
    const looks = Array.from({ length: 8 }, (_, index) => newAssistantLook(index));
    expect(new Set(looks.map((look) => look.hue)).size).toBe(8);
    expect(new Set(looks.map((look) => look.variant)).size).toBe(8);
    expect(newAssistantLook(3)).toEqual(looks[3]);
    expect(newAssistantLook(0)).toEqual({ hue: 210, variant: 0 });
  });
});
