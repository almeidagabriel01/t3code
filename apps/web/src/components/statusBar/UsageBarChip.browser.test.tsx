import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageBarChip } from "./UsageBarChip";
import { ChipSummary } from "./UsageChipSummary";

const base = {
  percent: 45,
  name: "Session",
  resets: "2h",
  bar: true,
  extra: false,
  divider: false,
  fillClass: "bg-warning",
  textClass: "text-warning",
  tickPercent: 40,
  delta: { text: "+5%", className: "text-warning" },
} as const;

describe("UsageBarChip", () => {
  it("reads name, percentage, bar, then time left and pace delta", async () => {
    await using screen = await render(<UsageBarChip {...base} />, { router: false });
    const fill = screen.container.querySelector<HTMLElement>(".bg-warning");
    expect(fill?.style.width).toBe("45%");
    const chip = screen.container.firstElementChild!;
    // The number comes before its bar, never after it.
    const parts = [...chip.children].map((part) =>
      part.querySelector("[style*='width']") ? "bar" : part.textContent,
    );
    expect(parts).toEqual(["Session", "45%", "bar", "2h", "+5%"]);
    expect(chip.querySelector(".bg-foreground\\/15")).toBeNull();
  });

  it("renders an extra window as name and percentage after a divider, without bar or delta", async () => {
    await using screen = await render(
      <UsageBarChip
        {...base}
        bar={false}
        extra
        divider
        name="Fable"
        resets={null}
        tickPercent={null}
        delta={null}
      />,
      { router: false },
    );
    expect(screen.container.querySelector(".bg-warning")).toBeNull();
    const chip = screen.container.firstElementChild!;
    expect(chip.className).toContain("max-xl:hidden");
    expect(chip.textContent).toBe("Fable45%");
    expect(chip.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
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
    expect(screen.container.textContent).toBe("Session45%Week30%");
    expect(screen.container.querySelectorAll("[style*='width']").length).toBe(2);
    // One divider, between the two windows.
    expect(screen.container.querySelectorAll("[aria-hidden='true'].w-px").length).toBe(1);
  });

  it("shows only the tightest window, without a bar, in compact mode", async () => {
    await using screen = await render(
      <ChipSummary limits={limits} mode="compact" display="remaining" />,
      { router: false },
    );
    expect(screen.container.textContent).toBe("Session55%");
    expect(screen.container.querySelectorAll("[style*='width']").length).toBe(0);
  });

  describe("weekly bar split", () => {
    const week = { id: "w", kind: "weekly", label: "Weekly", usedPercent: 84 } as const;
    const fable = {
      id: "f",
      kind: "weekly",
      label: "Weekly · Fable",
      usedPercent: 40,
      weekUsedSharePercent: 20,
      weekAllowancePercent: 50,
    } as const;
    const withWindows = (windows: unknown[]) =>
      ({ checkedAt: "2026-10-27T12:00:00.000Z", windows }) as unknown as ServerProviderUsageLimits;
    const weekBar = (container: HTMLElement) => container.querySelector<HTMLElement>("[role=img]");

    it("draws the scoped model as a lighter segment inside the used fill and describes the split", async () => {
      await using screen = await render(
        <ChipSummary limits={withWindows([week, fable])} mode="verbose" display="used" />,
        { router: false },
      );
      const bar = weekBar(screen.container)!;
      expect(bar.getAttribute("aria-label")).toBe("Week 84% used: Fable 20%, other models 64%");
      const models = bar.querySelectorAll<HTMLElement>("[data-week-split=model]");
      expect(models).toHaveLength(1);
      expect(models[0]!.className).toContain("opacity-50");
      const fill = models[0]!.parentElement!;
      expect(fill.style.width).toBe("84%");
      const rest = fill.firstElementChild as HTMLElement;
      expect(parseFloat(rest.style.width)).toBeCloseTo((64 / 84) * 100, 3);
      expect(parseFloat(models[0]!.style.width)).toBeCloseTo((20 / 84) * 100, 3);
    });

    it("puts the model share at the used end of the track when the bar fills with what is left", async () => {
      await using screen = await render(
        <ChipSummary limits={withWindows([week, fable])} mode="verbose" display="remaining" />,
        { router: false },
      );
      const bar = weekBar(screen.container)!;
      expect(bar.getAttribute("aria-label")).toBe(
        "Week 16% left, used Fable 20%, other models 64%",
      );
      const model = bar.querySelector<HTMLElement>("[data-week-split=model]")!;
      expect(model.parentElement!.style.left).toBe("80%");
      expect(model.parentElement!.style.width).toBe("20%");
    });

    it("keeps one tone when no scoped window carries a share", async () => {
      await using screen = await render(
        <ChipSummary
          limits={withWindows([week, { ...fable, weekUsedSharePercent: undefined }])}
          mode="verbose"
          display="used"
        />,
        { router: false },
      );
      expect(weekBar(screen.container)).toBeNull();
      expect(screen.container.querySelector("[data-week-split]")).toBeNull();
    });
  });
});
