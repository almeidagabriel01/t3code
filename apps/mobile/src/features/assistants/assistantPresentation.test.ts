import type { AssistantSpend } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ View: () => null }));
vi.mock("react-native-svg", () => ({ default: () => null, Path: () => null }));
vi.mock("uniwind", () => ({ withUniwind: (component: unknown) => component }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("../../state/assistants", () => ({ useAssistantEntries: () => null }));
vi.mock("../../state/assets", () => ({ useAssetUrlState: () => null }));

import { assistantAdvancedSummary, budgetSpendLine } from "./assistantPresentation";

const budget = (period: "daily" | "weekly" | "monthly") =>
  ({ period, spentUsd: 1.5 }) as NonNullable<AssistantSpend["budget"]>;

describe("budgetSpendLine", () => {
  it.each([
    [{ todayUsd: 0, periodUsd: 4, partial: false }, "in the last 30 days", false],
    [{ todayUsd: 0, periodUsd: 4, partial: true }, "in the last 30 days", true],
    [{ todayUsd: 0, periodUsd: 4, partial: false, budget: budget("daily") }, "today", false],
    [{ todayUsd: 0, periodUsd: 4, partial: false, budget: budget("weekly") }, "this week", false],
    [{ todayUsd: 0, periodUsd: 4, partial: true, budget: budget("monthly") }, "this month", true],
  ] satisfies Array<[AssistantSpend, string, boolean]>)("%j", (spend, when, partial) => {
    const line = budgetSpendLine(spend);
    expect(line.startsWith("At least ")).toBe(partial);
    expect(line).toContain(` ${when} · estimated at API prices`);
    expect(line).toContain("budget" in spend ? "1.50" : "4.00");
  });
});

describe("assistantAdvancedSummary", () => {
  const base = {
    toolAccess: "workspace-write",
    workspace: "host",
    budget: { enabled: false, amount: "" },
    connectors: [],
    askBeforeActing: true,
  } as const;

  it("summarizes the defaults of a new assistant", () => {
    expect(assistantAdvancedSummary(base)).toBe(
      "Edit files · This Mac · no spending limit · no connectors · asks before messaging other threads",
    );
  });

  it.each([
    [{ workspace: "sandbox" }, "Sandbox container"],
    [{ budget: { enabled: true, amount: " 5 " } }, "$5 limit"],
    [{ budget: { enabled: true, amount: "" } }, "spending limit"],
    [{ connectors: [1] }, "1 connector"],
    [{ connectors: [1, 2] }, "2 connectors"],
    [{ askBeforeActing: false }, "messages other threads freely"],
    [{ toolAccess: "full" }, "Full access"],
  ] as const)("reflects %j", (change, part) => {
    expect(assistantAdvancedSummary({ ...base, ...change })).toContain(part);
  });
});
