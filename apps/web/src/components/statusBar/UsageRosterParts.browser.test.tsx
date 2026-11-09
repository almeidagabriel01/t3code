import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { UsageSession } from "@t3tools/client-runtime/state/usageSessions";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import { LimitName, ResetText, UsageSessionsList } from "./UsageRosterParts";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const weekly = {
  id: "w",
  kind: "weekly",
  label: "Weekly · Fable",
  usedPercent: 40,
  resetsAt: new Date(NOW + (3 * 24 + 12) * 3_600_000).toISOString(),
} as ServerProviderUsageWindow;

describe("ResetText and LimitName", () => {
  it("shows the day, the countdown or both depending on the setting, and the short name", async () => {
    await using screen = await render(
      <ResetText window={weekly} now={NOW} mode="day" hour12={undefined} />,
      { router: false },
    );
    const text = () => screen.container.textContent ?? "";
    expect(text()).not.toMatch(/\dd\d|·/);
    expect(text()).toMatch(/\d/);
    await screen.rerender(<ResetText window={weekly} now={NOW} mode="countdown" hour12={false} />);
    expect(text()).toBe("3d12h");
    await screen.rerender(<ResetText window={weekly} now={NOW} mode="both" hour12={undefined} />);
    expect(text()).toMatch(/ · 3d12h$/);
    await screen.rerender(<LimitName window={weekly} />);
    expect(text()).toBe("Fable");
  });
});

const session = (title: string, state: UsageSession["state"]) =>
  ({
    environmentId: "env",
    threadId: title,
    projectKey: "env:p",
    title,
    state,
    model: "m",
    elapsed: "1m",
  }) as unknown as UsageSession;

describe("UsageSessionsList", () => {
  const titles = new Map([["env:p", "Project"]]);

  it("counts only running sessions and keeps finished ones collapsed until expanded", async () => {
    await using screen = await render(
      <UsageSessionsList
        sessions={[
          session("live", "working"),
          session("done-1", "recent"),
          session("done-2", "recent"),
        ]}
        titles={titles}
      />,
    );
    await expect.element(screen.getByText("Sessions · 1 running")).toBeVisible();
    await userEvent.click(screen.getByText("Sessions · 1 running"));
    await expect.element(screen.getByText("live")).toBeVisible();
    await expect.element(screen.getByText("Finished · 2")).toBeVisible();
    expect(screen.container.textContent).not.toContain("done-1");
    await userEvent.click(screen.getByText("Finished · 2"));
    await expect.element(screen.getByText("done-1")).toBeVisible();
  });

  it("drops the count when nothing is running", async () => {
    await using screen = await render(
      <UsageSessionsList sessions={[session("done", "recent")]} titles={titles} />,
    );
    await expect.element(screen.getByText("Sessions", { exact: true })).toBeVisible();
    expect(screen.container.textContent).not.toContain("running");
  });
});
