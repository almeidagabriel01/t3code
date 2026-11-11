import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { startMainAppLocationTracking } from "../sidebar/mainAppLocation";
import { ActivityPage } from "./ActivityPage";

const env = EnvironmentId.make("environment-one");
const needsYou = makeThreadFixture({
  id: ThreadId.make("thread-b"),
  environmentId: env,
  title: "Needs approval",
  hasPendingApprovals: true,
});

vi.mock("../../state/entities", () => ({
  useThreadShells: () => [needsYou],
  useProjects: () => [],
  useDelegatedUnderParent: () => new Set(),
  useQuietThreadShell: () => null,
}));
vi.mock("../../state/decisions", () => ({
  useDecisionEntries: () => ({ open: [] }),
  useOpenDecisionThreadKeys: () => new Set(),
}));
vi.mock("./useActivityRead", () => ({
  useActivityRead: () => ({
    canMarkAllRead: false,
    canClearRead: false,
    markAllRead: vi.fn(),
    clearRead: vi.fn(),
  }),
}));
vi.mock("../decisions/DecisionsSection", () => ({ DecisionsSection: () => null }));
vi.mock("../ChatView", () => ({ default: () => null }));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));

describe("ActivityPage", () => {
  it("remembers a thread opened from Activity as the place Close returns to", async () => {
    await using screen = await render(<ActivityPage />, { router: "/activity" });
    const router = screen.router!;
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
    await userEvent.click(screen.getByRole("button", { name: /Needs approval/ }));
    await userEvent.click(screen.getByRole("button", { name: "Close activity" }));
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe("/environment-one/thread-b"),
    );
  });
});
