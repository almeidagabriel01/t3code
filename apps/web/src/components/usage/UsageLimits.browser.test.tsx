import { ProviderDriverKind, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { LimitWindows } from "./UsageLimits";

const now = Date.parse("2026-11-09T12:00:00.000Z");
const windows: ServerProviderUsageWindow[] = [
  { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 60 },
  {
    id: "weekly-opus",
    kind: "weekly",
    label: "Weekly Opus",
    usedPercent: 30,
    weekUsedSharePercent: 25,
    weekAllowancePercent: 40,
  },
];

describe("LimitWindows weekly split", () => {
  it("draws the model share over the week bar and words the split and allowance", async () => {
    await using screen = await render(
      <LimitWindows driver={ProviderDriverKind.make("claudeAgent")} windows={windows} now={now} />,
    );

    await userEvent.tab();
    await expect
      .element(screen.getByText("Week 40% left, used Weekly Opus 25%, other models 35%"))
      .toBeVisible();
    await userEvent.tab();
    await expect.element(screen.getByText("Up to 40% of the weekly limit")).toBeVisible();
    expect(document.querySelectorAll("[data-week-split='model']")).toHaveLength(1);
  });
});
