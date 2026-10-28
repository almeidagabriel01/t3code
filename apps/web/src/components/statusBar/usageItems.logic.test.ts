import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectUsageItems, type UsagePresentations } from "./usageItems.logic";

const limits = (usedPercent: number) => ({
  checkedAt: "2026-10-27T12:00:00.000Z",
  windows: [{ id: "s", kind: "session", label: "5h", usedPercent }],
});

const provider = (
  instanceId: string,
  options: {
    email?: string;
    usageLimits?: ReturnType<typeof limits> | undefined;
    displayName?: string;
  },
) =>
  ({
    instanceId,
    driver: "claudeAgent",
    displayName: options.displayName,
    enabled: true,
    installed: true,
    availability: "available",
    status: "ready",
    auth: { status: "authenticated", ...(options.email ? { email: options.email } : {}) },
    models: [],
    slashCommands: [],
    skills: [],
    checkedAt: "2026-10-27T12:00:00.000Z",
    ...(options.usageLimits ? { usageLimits: options.usageLimits } : {}),
  }) as unknown as ServerProvider;

const environment = (label: string, providers: ServerProvider[]) => ({
  entry: { target: { label } },
  serverConfig: {
    providers,
    settings: {
      providerInstances: {
        claudeAgent_beyond: { driver: "claudeAgent", enabled: true, config: {} },
      },
      projectSettingsOverrides: {},
    },
    usageLimitSources: [],
  },
});

const presentations = (
  ...entries: Array<readonly [string, ReturnType<typeof environment>]>
): UsagePresentations =>
  new Map(
    entries.map(([id, value]) => [id as EnvironmentId, value]),
  ) as unknown as UsagePresentations;

describe("collectUsageItems", () => {
  it("keeps two instances of one environment apart even when they report the same account", () => {
    const items = collectUsageItems(
      presentations([
        "env-a",
        environment("Local", [
          provider("claudeAgent", { email: "me@example.com", usageLimits: limits(5) }),
          provider("claudeAgent_beyond", {
            email: "me@example.com",
            usageLimits: limits(72),
            displayName: "Claude Beyond",
          }),
        ]),
      ]),
    );
    expect(items.map((item) => item.entry.instanceId)).toEqual([
      "claudeAgent",
      "claudeAgent_beyond",
    ]);
    expect(items.every((item) => item.showBadge)).toBe(true);
  });

  it("keeps an instance that reported no usage, as unavailable", () => {
    const items = collectUsageItems(
      presentations([
        "env-a",
        environment("Local", [
          provider("claudeAgent", { usageLimits: limits(5) }),
          provider("claudeAgent_beyond", {}),
        ]),
      ]),
    );
    expect(items.map((item) => [item.entry.instanceId, item.limits === undefined])).toEqual([
      ["claudeAgent", false],
      ["claudeAgent_beyond", true],
    ]);
  });

  it("shows an account once across environments and names the environments", () => {
    const shared = () => [
      provider("claudeAgent", { email: "me@example.com", usageLimits: limits(5) }),
    ];
    const items = collectUsageItems(
      presentations(
        ["env-a", environment("Local", shared())],
        ["env-b", environment("Remote", shared())],
      ),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.environmentLabel).toBe("Local, Remote");
  });
});
