import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import type { UsageItem } from "./usageItems.logic";

const mocks = vi.hoisted(() => ({
  items: [] as UsageItem[],
  consume: vi.fn(async (_value: unknown) => ({ _tag: "Success", value: { outcome: "reset" } })),
  toast: vi.fn(),
}));

vi.mock("./useUsageItems", () => ({
  useUsageItems: () => ({ environmentIds: [], items: mocks.items }),
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.consume }));
vi.mock("../ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/toast")>()),
  toastManager: { add: mocks.toast },
}));

import { UsageSegments } from "./UsageSegments";

const codex = (availableCount: number) =>
  ({
    key: "codex",
    environmentId: "env" as EnvironmentId,
    environmentIds: ["env" as EnvironmentId],
    entry: {
      instanceId: "codex" as ProviderInstanceId,
      driverKind: "codex",
      displayName: "Codex",
      snapshot: { auth: { type: "chatgpt", label: "ChatGPT Pro" } },
    },
    limits: {
      checkedAt: "2026-11-09T12:00:00.000Z",
      windows: [{ id: "weekly", kind: "weekly", label: "Week", usedPercent: 90 }],
      resetCredits: { availableCount },
    },
    showBadge: false,
    environmentLabel: null,
  }) as unknown as UsageItem;

function setup(items: UsageItem[]) {
  mocks.items = items;
  mocks.consume.mockClear();
  mocks.toast.mockClear();
}

describe("UsageSegments reset credits", () => {
  it("uses a banked reset from the status bar after confirming, then reports the outcome", async () => {
    setup([codex(2)]);
    await using screen = await render(<UsageSegments />);
    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    await expect.element(page.getByText("2 reset credits banked")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Use reset" }));

    await expect.element(page.getByText("Use a reset credit?")).toBeVisible();
    await expect.element(page.getByText(/one credit on Codex/)).toBeVisible();
    await expect.element(page.getByText("2 reset credits banked")).not.toBeInTheDocument();
    expect(mocks.consume).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: "Use credit" }));
    expect(mocks.consume.mock.calls).toEqual([
      [{ environmentId: "env", input: { instanceId: "codex" } }],
    ]);
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "info",
        title: "Reset applied. Your windows have cleared.",
      }),
    );
    await expect.element(page.getByText("Use a reset credit?")).not.toBeInTheDocument();
  });

  it("cancelling spends nothing, and an account with no banked reset shows no reset row", async () => {
    setup([codex(1)]);
    await using screen = await render(<UsageSegments />);
    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    await userEvent.click(page.getByRole("button", { name: "Use reset" }));
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
    await expect.element(page.getByText("Use a reset credit?")).not.toBeInTheDocument();
    expect(mocks.consume).not.toHaveBeenCalled();

    setup([codex(0)]);
    await screen.rerender(<UsageSegments />);
    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    expect(page.getByRole("button", { name: "Use reset" }).query()).toBeNull();
  });
});
