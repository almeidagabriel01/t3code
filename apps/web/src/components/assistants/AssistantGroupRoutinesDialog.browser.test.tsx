import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { render } from "../../../test/render";
import { AssistantGroupRoutinesHost } from "./AssistantGroupRoutinesDialog";
import { assistantGroupRoutinesAtom } from "./assistantTeamState";

const environmentId = EnvironmentId.make("laptop");

const routine = (id: string, extra: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: ScheduledTaskId.make(id),
  title: id,
  prompt: `@ada ${id}`,
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:00" },
  projectId: ProjectId.make("project"),
  threadId: null,
  assistantTeamId: "t1",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: "2099-01-01T12:00:00.000Z",
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
  ...extra,
});

const state = vi.hoisted(() => ({
  tasks: [] as ReadonlyArray<ScheduledTask> | undefined,
  error: null as string | null,
  commands: [] as Array<{ kind: string; input: unknown }>,
  fail: false,
  toast: vi.fn(),
}));

vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: state.tasks === undefined ? undefined : { tasks: state.tasks },
    error: state.error,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((_command: unknown, options: { label: string }) =>
    async (request: { input: unknown }) => {
      state.commands.push({ kind: options.label, input: request.input });
      return state.fail ? { _tag: "Failure", cause: Cause.fail("nope") } : { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (() => true) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));
vi.mock(import("../ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { add: state.toast } as never,
}));
vi.mock(import("../../confirmDialog"), () => ({
  requestConfirmDialog: (async () => true) as never,
}));

const see = (row: ReturnType<typeof page.getByTestId>, text: string) =>
  expect.element(row.getByText(text, { exact: false }).first()).toBeVisible();

const Host = () => (
  <AppAtomRegistryProvider>
    <AssistantGroupRoutinesHost />
  </AppAtomRegistryProvider>
);

function setup(tasks: ReadonlyArray<ScheduledTask> | undefined) {
  state.tasks = tasks;
  state.error = null;
  state.commands = [];
  state.fail = false;
  state.toast.mockClear();
  appAtomRegistry.set(assistantGroupRoutinesAtom, { environmentId, teamId: "t1" as never });
}

it("lists only this group's routines with their state, and acts on them", async () => {
  setup([
    routine("Monday"),
    routine("Elsewhere", { assistantTeamId: "t2" }),
    routine("Failing", {
      lastRunStatus: "failed",
      lastRunError: "This group is archived.",
      maxRuns: 5,
      runCount: 2,
      missedRunPolicy: "once",
    }),
    routine("Done", {
      enabled: false,
      nextRunAt: null,
      maxRuns: 1,
      runCount: 1,
      lastRunStatus: "succeeded",
    }),
    routine("Held", { enabled: false, nextRunAt: null }),
    routine("Waiting", { nextRunAt: null }),
  ]);
  await using _screen = await render(<Host />, { router: "/assistants" });
  const rows = page.getByTestId("group-routine");
  await see(rows.nth(0), "Monday");
  expect(page.getByText("Elsewhere").query()).toBeNull();
  await see(rows.nth(0), "Daily at 09:00");
  await see(rows.nth(0), "Next run");
  await see(rows.nth(1), "This group is archived.");
  await see(rows.nth(1), "2 of 5 runs");
  await see(rows.nth(1), "catches up once if missed");
  await see(rows.nth(1), "failed");
  await see(rows.nth(2), "Stopped at its run limit");
  await see(rows.nth(2), "posted");
  await see(rows.nth(3), "Paused");
  await see(rows.nth(4), "Not scheduled");

  await userEvent.click(rows.nth(0).getByRole("button", { name: "Run now" }));
  await userEvent.click(rows.nth(0).getByRole("button", { name: "Pause" }));
  await userEvent.click(rows.nth(3).getByRole("button", { name: "Resume" }));
  await userEvent.click(rows.nth(0).getByRole("button", { name: "Delete Monday" }));
  await vi.waitFor(() =>
    expect(state.commands.map((command) => command.kind)).toEqual([
      "group routine run now",
      "group routine enabled",
      "group routine enabled",
      "group routine delete",
    ]),
  );
  expect(state.commands[1]!.input).toEqual({ id: "Monday", enabled: false });
  expect(state.commands[2]!.input).toEqual({ id: "Held", enabled: true });
});

it("reports a failed action, and opens the editor from Edit and New routine", async () => {
  setup([routine("Monday")]);
  state.fail = true;
  await using screen = await render(<Host />, { router: "/assistants" });
  await userEvent.click(page.getByRole("button", { name: "Run now" }));
  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not update the routine" }),
    ),
  );
  await userEvent.click(page.getByRole("button", { name: "Edit" }));
  await vi.waitFor(() =>
    expect(screen.router?.state.location.search).toMatchObject({ environmentId, taskId: "Monday" }),
  );
  expect(appAtomRegistry.get(assistantGroupRoutinesAtom)).toBeNull();
  setup([routine("Monday")]);
  await screen.rerender(<Host />);
  await userEvent.click(page.getByRole("button", { name: "New routine" }));
  await vi.waitFor(() =>
    expect(screen.router?.state.location.search).toMatchObject({
      environmentId,
      assistantTeamId: "t1",
    }),
  );
});

it.each([
  ["loading", undefined, null, "Loading routines…"],
  ["empty", [], null, "No routines in this group yet."],
  ["failed", undefined, "offline", "offline"],
] as const)("says when routines are %s", async (_name, tasks, error, text) => {
  setup(tasks);
  state.error = error;
  await using _screen = await render(<Host />, { router: "/assistants" });
  await expect.element(page.getByText(text)).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Close" }).last());
  expect(appAtomRegistry.get(assistantGroupRoutinesAtom)).toBeNull();
});
