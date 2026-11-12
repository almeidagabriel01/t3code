import type { ReactNode } from "react";
import { RUNNER_DEFAULTS, type HeavyQueueState, type ServerSettings } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

type Settings = Pick<ServerSettings, keyof typeof RUNNER_DEFAULTS>;

const mocks = vi.hoisted(() => ({
  scope: { kind: "environment", environmentIds: ["env"] } as {
    kind: string;
    environmentIds: string[];
  },
  state: null as unknown as Pick<HeavyQueueState, "enabled" | "paused" | "linux">,
  settings: {} as Record<string, unknown>,
  mixed: [] as string[],
  update: vi.fn(),
}));

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ scope: mocks.scope, environment: { environmentId: "env" } }),
}));
vi.mock("../../state/heavyQueue", () => ({ useHeavyQueue: () => mocks.state }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: (select: (settings: Record<string, unknown>) => unknown) =>
    select(mocks.settings),
  useScopedSettingsMixed: (keys: string[]) => keys.some((key) => mocks.mixed.includes(key)),
  useUpdateScopedSettings: () => mocks.update,
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" aria-label={`Reset ${label}`} onClick={onClick}>
      Reset
    </button>
  ),
  SettingsRow: (props: {
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    resetAction?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      <h3>{props.title}</h3>
      <p>{props.description}</p>
      <p>{props.status}</p>
      {props.resetAction}
      {props.control}
      {props.children}
    </div>
  ),
}));

import { RunnerSettingsSection } from "./RunnerSettings";

const LINUX = {
  host: "remoto",
  online: true,
  slots: 2,
  running: 0,
  load1: null,
  cpuCount: null,
  availableMemoryBytes: null,
  totalMemoryBytes: null,
};

function setup(
  settings: Partial<Settings> = {},
  over: {
    scope?: string;
    environmentIds?: string[];
    mixed?: string[];
    state?: Partial<typeof mocks.state>;
  } = {},
) {
  mocks.update.mockReset();
  mocks.scope = {
    kind: over.scope ?? "environment",
    environmentIds: over.environmentIds ?? ["env"],
  };
  mocks.state = { enabled: true, paused: false, linux: null, ...over.state };
  mocks.settings = { ...RUNNER_DEFAULTS, ...settings };
  mocks.mixed = over.mixed ?? [];
  return render(<RunnerSettingsSection />, { router: false }); // rows are mocked
}

const patches = () => mocks.update.mock.calls.map(([patch]) => patch);

it("writes each Runner row to its own setting", async () => {
  await using screen = await setup();
  await userEvent.click(screen.getByRole("switch", { name: "Use the Runner" }));
  const where = screen.getByRole("combobox", { name: "Where heavy work runs" });
  await expect.element(where).toHaveTextContent("This Mac");
  await userEvent.click(where);
  await userEvent.click(screen.getByRole("option", { name: "Automatic" }));
  await userEvent.click(screen.getByRole("combobox", { name: "When Linux is offline" }));
  await userEvent.click(screen.getByRole("option", { name: "Wait for Linux" }));
  await userEvent.click(screen.getByRole("combobox", { name: "If nobody answers" }));
  await userEvent.click(screen.getByRole("option", { name: "Cancel" }));
  for (const [label, value] of [
    ["Send to Linux after", "5"],
    ["Jobs at once on Linux", "4"],
    ["Linux host", " pc "],
  ] as const) {
    const field = screen.getByLabelText(label);
    await field.fill(value);
    await field.element().blur();
  }
  expect(patches()).toEqual([
    { runnerEnabled: true },
    { runnerWhere: "automatic" },
    { runnerUnavailable: "wait" },
    { runnerDeadlineAction: "cancel" },
    { runnerOverflow: 5 },
    { runnerLinuxSlots: 4 },
    { runnerHost: "pc" },
  ]);
});

it("rejects invalid numbers and hosts inline, saves nothing, and restores a failed save", async () => {
  await using screen = await setup();
  const overflow = screen.getByLabelText("Send to Linux after");
  for (const [value, message] of [
    ["21", "Use 0 to 20 jobs."],
    ["2.5", "Use a whole number of jobs."],
    ["", "Use a whole number of jobs."],
  ] as const) {
    await overflow.fill(value);
    await overflow.element().blur();
    await expect.element(screen.getByText(message)).toBeVisible();
    await expect.element(overflow).toHaveAttribute("aria-invalid", "true");
  }
  const host = screen.getByLabelText("Linux host");
  await host.fill("-oProxyCommand=x");
  await host.element().blur();
  await expect.element(screen.getByText("A host cannot start with a dash.")).toBeVisible();
  expect(mocks.update).not.toHaveBeenCalled();

  const minutes = screen.getByLabelText("Wait for an answer");
  await minutes.fill("9");
  await minutes.element().blur();
  expect(patches()).toEqual([{ runnerAskMinutes: 9 }]);
  mocks.update.mock.calls[0]![1].onFailed();
  await expect.element(minutes).toHaveValue(String(RUNNER_DEFAULTS.runnerAskMinutes));
});

it("normalizes a pattern list on blur and refuses one that is too long", async () => {
  await using screen = await setup();
  const linux = screen.getByLabelText("Commands that may run on Linux");
  await expect.element(linux).toHaveValue(RUNNER_DEFAULTS.runnerLinuxCommands.join("\n"));
  await linux.fill("  vitest \n\nvitest\n lint ");
  await linux.element().blur();
  await expect.element(linux).toHaveValue("vitest\nlint");
  const macOnly = screen.getByLabelText("Commands that stay on this Mac");
  await macOnly.fill(Array.from({ length: 51 }, (_, index) => `cmd${index}`).join("\n"));
  await macOnly.element().blur();
  await expect.element(screen.getByText("Keep it to 50 patterns.")).toBeVisible();
  expect(patches()).toEqual([{ runnerLinuxCommands: ["vitest", "lint"] }]);
});

it("says what the queue and the Runner do together, and how Linux is doing", async () => {
  await using screen = await setup(
    { runnerEnabled: true, runnerWhere: "automatic" },
    { state: { enabled: false, linux: LINUX } },
  );
  await expect
    .element(
      screen.getByText(
        "No queue: jobs start here right away until 3 jobs run, then listed commands go to Linux.",
      ),
    )
    .toBeVisible();
  await expect.element(screen.getByText("Linux online · 0 of 2 running")).toBeVisible();
  await expect.element(screen.getByRole("switch", { name: "Use the Runner" })).toBeEnabled();
});

it("resets to the built-in value, but leaves machine rows alone in a project", async () => {
  await using env = await setup({ runnerWhere: "linux", runnerLinuxSlots: 4 });
  await userEvent.click(env.getByRole("button", { name: "Reset Where heavy work runs" }));
  await userEvent.click(env.getByRole("button", { name: "Reset Jobs at once on Linux" }));
  expect(patches()).toEqual([{ runnerWhere: "mac" }, { runnerLinuxSlots: 2 }]);

  await using project = await setup(
    { runnerWhere: "linux", runnerLinuxSlots: 4, runnerHost: "pc" },
    { scope: "project", mixed: ["runnerDropped"] },
  );
  await expect
    .element(project.getByRole("combobox", { name: "When Linux drops a job" }))
    .toHaveTextContent("Mixed");
  for (const name of ["Reset Jobs at once on Linux", "Reset Linux host"]) {
    expect(project.container.querySelector(`[aria-label="${name}"]`)).toBeNull();
  }
});

it("keeps the rows editable but drops the mode line across several environments", async () => {
  await using screen = await setup({}, { environmentIds: ["a", "b"] });
  await expect.element(screen.getByRole("switch", { name: "Use the Runner" })).toBeEnabled();
  expect(screen.container.textContent).not.toContain("Heavy jobs wait their turn");
});
