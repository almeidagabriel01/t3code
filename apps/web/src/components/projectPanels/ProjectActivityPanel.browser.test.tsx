import type { ActivityEntry } from "@t3tools/client-runtime/state/thread-activity";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

const mocks = vi.hoisted(() => ({
  entries: [] as ActivityEntry[],
  navigate: vi.fn(),
}));

vi.mock("../activity/useActivity", () => ({ useActivityEntries: () => mocks.entries }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));

import { ProjectActivityPanel } from "./ProjectActivityPanel";

const entry = (id: string, rank: 0 | 2, over: Record<string, unknown> = {}): ActivityEntry =>
  ({
    key: `env:${id}`,
    rank,
    thread: {
      environmentId: "env",
      id,
      projectId: "p1",
      title: `Thread ${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      latestRun: null,
      ...over,
    },
  }) as unknown as ActivityEntry;

function setup(entries: ActivityEntry[]) {
  mocks.entries = entries;
  mocks.navigate.mockReset();
}

const panel = () => (
  <ProjectActivityPanel environmentId={"env" as EnvironmentId} projectId={"p1" as ProjectId} />
);

it("lists the project's runs newest first with what happened, and opens a thread on click", async () => {
  const ended = (status: string, completedAt: string) => ({
    latestRun: { status, completedAt, startedAt: null, requestedAt: null },
  });
  setup([
    entry("asks", 0, { updatedAt: "2026-01-01T03:00:00.000Z" }),
    entry("failed", 2, ended("failed", "2026-01-01T04:00:00.000Z")),
    entry("done", 2, ended("completed", "2026-01-01T01:00:00.000Z")),
    entry("stopped", 2, ended("interrupted", "2026-01-01T02:00:00.000Z")),
    entry("elsewhere", 2, { ...ended("completed", "2026-01-01T05:00:00.000Z"), projectId: "p2" }),
  ]);
  await using screen = await render(panel());
  const rows = screen.getByRole("list", { name: "Project activity" }).getByRole("button");
  await expect.element(rows.first()).toBeVisible();
  expect(rows.elements().map((row) => row.firstElementChild?.textContent)).toEqual([
    "Thread failed",
    "Thread asks",
    "Thread stopped",
    "Thread done",
  ]);
  expect(rows.elements().map((row) => row.querySelector("[data-slot=badge]")?.textContent)).toEqual(
    ["Failed", "Needs you", "Interrupted", "Finished"],
  );
  await userEvent.click(rows.nth(1));
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "env", threadId: "asks" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Open all activity" }));
  expect(mocks.navigate).toHaveBeenLastCalledWith({ to: "/activity" });
});

it("says so when the project has nothing new", async () => {
  setup([entry("elsewhere", 0, { projectId: "p2" })]);
  await using screen = await render(panel());
  await expect.element(screen.getByText("Nothing new in this project")).toBeVisible();
});
