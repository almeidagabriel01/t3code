import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageBarChip } from "./UsageBarChip";
import { ChipSummary } from "./UsageChipSummary";

const base = {
  percent: 45,
  label: "2h",
  labelFirst: false,
  bar: true,
  fillClass: "bg-warning",
  textClass: "text-warning",
  tickPercent: 40,
  delta: { text: "+5%", className: "text-warning" },
} as const;

describe("UsageBarChip", () => {
  it("draws a bar with its own fill, tick, percentage, label and pace delta", async () => {
    await using screen = await render(<UsageBarChip {...base} />, { router: false });
    const fill = screen.container.querySelector<HTMLElement>(".bg-warning");
    expect(fill?.style.width).toBe("45%");
    expect(screen.container.querySelector("[aria-hidden]")).not.toBeNull();
    await expect.element(screen.getByText("45% 2h")).toBeVisible();
    await expect.element(screen.getByText("+5%")).toBeInTheDocument();
  });

  it("renders extra windows as text led by their name, without bar or delta", async () => {
    await using screen = await render(
      <UsageBarChip
        {...base}
        bar={false}
        labelFirst
        label="Opus"
        tickPercent={null}
        delta={null}
      />,
      { router: false },
    );
    expect(screen.container.querySelector(".bg-warning")).toBeNull();
    await expect.element(screen.getByText("Opus 45%")).toBeInTheDocument();
  });
});

describe("ChipSummary", () => {
  const limits = {
    checkedAt: "2026-10-27T12:00:00.000Z",
    windows: [
      { id: "s", kind: "session", label: "Session", usedPercent: 45 },
      { id: "w", kind: "weekly", label: "Weekly", usedPercent: 30 },
    ],
  } as unknown as ServerProviderUsageLimits;

  it("shows session and weekly, each with its own bar, in verbose mode", async () => {
    await using screen = await render(
      <ChipSummary limits={limits} mode="verbose" display="used" />,
      { router: false },
    );
    await expect.element(screen.getByText("45% Session")).toBeInTheDocument();
    await expect.element(screen.getByText("30% wk")).toBeInTheDocument();
    expect(screen.container.querySelectorAll("[style*='width']").length).toBe(2);
  });

  it("shows only the tightest window, without a bar, in compact mode", async () => {
    await using screen = await render(
      <ChipSummary limits={limits} mode="compact" display="remaining" />,
      { router: false },
    );
    await expect.element(screen.getByText("55% Session")).toBeInTheDocument();
    expect(screen.container.textContent).not.toContain("wk");
    expect(screen.container.querySelectorAll("[style*='width']").length).toBe(0);
  });
});
