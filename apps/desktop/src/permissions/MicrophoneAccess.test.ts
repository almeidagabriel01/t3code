import { describe, expect, it, vi } from "vite-plus/test";

import { resolveMicrophoneAccess } from "./MicrophoneAccess.ts";

const deps = (overrides: Partial<Parameters<typeof resolveMicrophoneAccess>[0]> = {}) => ({
  platform: "darwin" as const,
  readStatus: () => "granted",
  ask: vi.fn(async () => true),
  ...overrides,
});

describe("resolveMicrophoneAccess", () => {
  it("leaves other platforms to the browser prompt", async () => {
    const input = deps({ platform: "linux" });
    expect(await resolveMicrophoneAccess(input)).toBe("unsupported");
    expect(input.ask).not.toHaveBeenCalled();
  });

  it.each(["granted", "denied", "restricted"])(
    "reports a settled %s status without asking",
    async (status) => {
      const input = deps({ readStatus: () => status });
      expect(await resolveMicrophoneAccess(input)).toBe(status);
      expect(input.ask).not.toHaveBeenCalled();
    },
  );

  it("is unavailable when the status cannot be read or is unknown", async () => {
    expect(
      await resolveMicrophoneAccess(
        deps({
          readStatus: () => {
            throw new Error("no TCC");
          },
        }),
      ),
    ).toBe("unavailable");
    expect(await resolveMicrophoneAccess(deps({ readStatus: () => "mystery" }))).toBe(
      "unavailable",
    );
  });

  it.each([
    [true, "granted"],
    [false, "denied"],
  ] as const)("asks macOS once while undetermined and maps %s to %s", async (answer, expected) => {
    const input = deps({ readStatus: () => "not-determined", ask: vi.fn(async () => answer) });
    const [first, second] = await Promise.all([
      resolveMicrophoneAccess(input),
      resolveMicrophoneAccess(input),
    ]);
    expect([first, second]).toEqual([expected, expected]);
    expect(input.ask).toHaveBeenCalledTimes(1);
  });

  it("is unavailable when the prompt fails, and asks again next time", async () => {
    const ask = vi.fn(async () => {
      throw new Error("prompt failed");
    });
    const input = deps({ readStatus: () => "not-determined", ask });
    expect(await resolveMicrophoneAccess(input)).toBe("unavailable");
    expect(await resolveMicrophoneAccess(input)).toBe("unavailable");
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
