import type { ReactNode } from "react";
import {
  RUNNER_LINUX_FULL_DESCRIPTION,
  RUNNER_LINUX_FULL_LABEL,
  RUNNER_SETTING_DEFAULTS,
  type RunnerSettingKey,
} from "@t3tools/client-runtime/state/runnerModel";
import type { HeavyQueueState, ServerSettings } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

type Settings = Pick<ServerSettings, RunnerSettingKey>;

const mocks = vi.hoisted(() => ({
  scope: { kind: "environment", environmentIds: ["env"] } as {
    kind: string;
    environmentIds: string[];
  },
  state: null as unknown as Pick<HeavyQueueState, "enabled" | "paused" | "linux">,
  settings: {} as Record<string, unknown>,
  mixed: [] as string[],
  target: null as string | null,
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
  SettingsSection: (props: { title: string; headerAction?: ReactNode; children: ReactNode }) => (
    <section aria-label={props.title}>
      {props.headerAction}
      {props.children}
    </section>
  ),
  useSettingsSearchTargetId: () => mocks.target,
  useSettingsSearchRevealedId: () => mocks.target,
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
    target?: string;
    state?: Partial<typeof mocks.state>;
  } = {},
) {
  mocks.update.mockReset();
  mocks.scope = {
    kind: over.scope ?? "environment",
    environmentIds: over.environmentIds ?? ["env"],
  };
  mocks.state = { enabled: true, paused: false, linux: null, ...over.state };
  mocks.settings = { ...RUNNER_SETTING_DEFAULTS, ...settings };
  mocks.mixed = over.mixed ?? [];
  mocks.target = over.target ?? null;
  return render(<RunnerSettingsSection />, { router: false }); // rows are mocked
}

const patches = () => mocks.update.mock.calls.map(([patch]) => patch);
const ON = { runnerEnabled: true } as const;

it("writes each Runner control to its own setting", async () => {
  await using screen = await setup({ ...ON, runnerWhere: "mac" });
  await userEvent.click(screen.getByRole("switch", { name: "Use the Runner" }));
  const where = screen.getByRole("group", { name: "Where heavy work runs" });
  await expect
    .element(where.getByRole("button", { name: "This Mac" }))
    .toHaveAttribute("aria-pressed", "true");
  await userEvent.click(where.getByRole("button", { name: "Hybrid" }));
  await userEvent.click(
    screen
      .getByRole("group", { name: "When Linux is offline" })
      .getByRole("button", { name: "Wait for Linux" }),
  );
  await userEvent.click(
    screen
      .getByRole("group", { name: "If nobody answers" })
      .getByRole("button", { name: "Cancel" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Increase Jobs at once on Linux" }));
  const host = screen.getByLabelText("Linux host");
  await host.fill(" pc ");
  await host.element().blur();
  expect(patches()).toEqual([
    { runnerEnabled: false },
    { runnerWhere: "automatic" },
    { runnerUnavailable: "wait" },
    { runnerDeadlineAction: "cancel" },
    { runnerLinuxSlots: 3 },
    { runnerHost: "pc" },
  ]);
});

it("saves the Mac first, Everything, failure and bring-back choices", async () => {
  await using screen = await setup({ ...ON, runnerWhere: "macFirst" });
  const where = screen.getByRole("group", { name: "Where heavy work runs" });
  await expect
    .element(where.getByRole("button", { name: "Mac first" }))
    .toHaveAttribute("aria-pressed", "true");
  await userEvent.click(where.getByRole("button", { name: "Linux" }));
  await userEvent.click(screen.getByRole("button", { name: "Increase Send to Linux after" }));
  await userEvent.click(screen.getByRole("switch", { name: "Bring results back" }));
  const failed = screen.getByRole("group", { name: "If a Linux run fails" });
  await expect
    .element(failed.getByRole("button", { name: "Tell the agent" }))
    .toHaveAttribute("aria-pressed", "true");
  await userEvent.click(failed.getByRole("button", { name: "Wait for Linux" }));
  expect(patches()).toEqual([
    { runnerWhere: "linux" },
    { runnerMacFirstAfter: 5 },
    // On by default: the switch turns it off.
    { runnerBringBack: false },
    { runnerDropped: "wait" },
  ]);
  await expect.element(screen.getByText("jobs", { exact: true }).first()).toBeVisible();

  await using linux = await setup({ ...ON, runnerWhere: "linux", runnerLinuxEverything: true });
  expect(linux.container.textContent).not.toContain("Send to Linux after");
  const everything = linux.getByRole("switch", { name: "Everything" });
  await expect.element(everything).toBeChecked();
  await userEvent.click(everything);
  const full = linux.getByRole("group", { name: "When Linux is full" });
  expect(
    full
      .getByRole("button")
      .elements()
      .map((button) => button.textContent),
  ).toEqual(Object.values(RUNNER_LINUX_FULL_LABEL));
  await expect
    .element(full.getByRole("button", { name: RUNNER_LINUX_FULL_LABEL.wait }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(linux.getByText(RUNNER_LINUX_FULL_DESCRIPTION.wait)).toBeVisible();
  await userEvent.click(full.getByRole("button", { name: RUNNER_LINUX_FULL_LABEL.mac }));
  expect(patches()).toEqual([{ runnerLinuxEverything: false }, { runnerLinuxFull: "mac" }]);

  await using balance = await setup({ ...ON, runnerWhere: "linux", runnerLinuxFull: "balance" });
  await expect.element(balance.getByText(RUNNER_LINUX_FULL_DESCRIPTION.balance)).toBeVisible();
});

it("clamps numbers to their range and rejects a bad host inline", async () => {
  await using screen = await setup(ON);
  const slots = screen.getByLabelText("Jobs at once on Linux");
  await slots.fill("99");
  await slots.element().blur();
  const host = screen.getByLabelText("Linux host");
  await host.fill("-oProxyCommand=x");
  await host.element().blur();
  await expect.element(screen.getByText("A host cannot start with a dash.")).toBeVisible();
  await expect.element(host).toHaveAttribute("aria-invalid", "true");
  expect(patches()).toEqual([{ runnerLinuxSlots: 16 }]);
  await host.fill("pc");
  await host.element().blur();
  mocks.update.mock.calls[1]![1].onFailed();
  await expect.element(host).toHaveValue(RUNNER_SETTING_DEFAULTS.runnerHost);
});

it("edits a command list as chips: remove, add on Enter, skip repeats, cap the length", async () => {
  await using screen = await setup({ ...ON, runnerWhere: "linux" });
  await userEvent.click(
    screen.getByRole("button", { name: "Remove vitest from Can run on Linux" }),
  );
  const add = screen.getByLabelText("Add a command to Can run on Linux");
  await add.fill(" rspec ");
  await userEvent.keyboard("{Enter}");
  await add.fill("lint");
  await userEvent.click(screen.getByRole("button", { name: "Add to Can run on Linux" }));
  await expect.element(add).toHaveValue("");
  expect(patches()).toEqual([
    {
      runnerLinuxCommands: RUNNER_SETTING_DEFAULTS.runnerLinuxCommands.filter(
        (c) => c !== "vitest",
      ),
    },
    { runnerLinuxCommands: [...RUNNER_SETTING_DEFAULTS.runnerLinuxCommands, "rspec"] },
  ]);

  await using full = await setup({
    ...ON,
    runnerMacOnly: Array.from({ length: 50 }, (_, index) => `cmd${index}`),
  });
  const macOnly = full.getByLabelText("Add a command to Always on this Mac");
  await macOnly.fill("one-more");
  await userEvent.keyboard("{Enter}");
  await expect.element(full.getByText("Keep it to 50 patterns.")).toBeVisible();
  await expect.element(macOnly).toHaveValue("one-more");
  expect(mocks.update).not.toHaveBeenCalled();
});

it("shows only the fields the current choices use", async () => {
  await using off = await setup({ runnerEnabled: false });
  expect(off.container.textContent).not.toContain("Where heavy work runs");
  expect(off.container.textContent).not.toContain("Linux host");

  await using mac = await setup({
    ...ON,
    runnerWhere: "mac",
    runnerUnavailable: "mac",
    runnerDropped: "wait",
  });
  for (const hidden of ["Can run on Linux", "Wait for an answer", "If nobody answers"]) {
    expect(mac.container.textContent).not.toContain(hidden);
  }
  await expect.element(mac.getByText("Always on this Mac")).toBeVisible();

  for (const where of ["mac", "automatic"] as const) {
    await using other = await setup({ ...ON, runnerWhere: where });
    expect(other.container.textContent).not.toContain("Send to Linux after");
    expect(other.container.querySelector('[aria-label="Everything"]')).toBeNull();
    expect(other.container.textContent).not.toContain("When Linux is full");
  }

  await using hybrid = await setup({ ...ON, runnerWhere: "automatic", runnerDropped: "ask" });
  await expect.element(hybrid.getByText("Can run on Linux")).toBeVisible();
  await expect.element(hybrid.getByText("Wait for an answer")).toBeVisible();

  // Everything sends every command, so the list goes and the Where line says it once.
  const EVERYTHING = "Every heavy command goes to Linux, except what has to stay on this Mac.";
  await using everything = await setup({
    ...ON,
    runnerWhere: "linux",
    runnerLinuxEverything: true,
  });
  await expect.element(everything.getByText(EVERYTHING)).toBeVisible();
  expect(everything.container.textContent!.split(EVERYTHING)).toHaveLength(2);
  expect(everything.container.textContent).not.toContain("Can run on Linux");
  expect(everything.container.textContent).not.toContain("Listed commands always run on Linux");
  await using listed = await setup({ ...ON, runnerWhere: "linux", runnerLinuxEverything: false });
  await expect.element(listed.getByText("Can run on Linux")).toBeVisible();
  await expect
    .element(
      listed.getByText("Listed commands always run on Linux. Everything else stays on this Mac."),
    )
    .toBeVisible();
  await expect.element(listed.getByText(EVERYTHING)).toBeVisible();
});

it("shows a hidden field a search lands on, with why it does nothing now", async () => {
  await using screen = await setup({ runnerEnabled: false }, { target: "runner-linux-commands" });
  await expect.element(screen.getByText("Can run on Linux")).toBeVisible();
  await expect
    .element(screen.getByText("Only applies while the Runner is on.").first())
    .toBeVisible();
  expect(screen.container.textContent).not.toContain("Linux host");

  await using everything = await setup(ON, { target: "runner-linux-everything" });
  await expect.element(everything.getByRole("switch", { name: "Everything" })).toBeVisible();
  await expect
    .element(everything.getByText("Only applies when Where jobs run is Linux."))
    .toBeVisible();

  await using full = await setup(ON, { target: "runner-linux-full" });
  await expect.element(full.getByRole("group", { name: "When Linux is full" })).toBeVisible();
  await expect.element(full.getByText("Only applies when Where jobs run is Linux.")).toBeVisible();
  // Off, the Runner's own reason wins, and the group still opens for the row.
  await using fullOff = await setup({ runnerEnabled: false }, { target: "runner-linux-full" });
  await expect.element(fullOff.getByRole("group", { name: "When Linux is full" })).toBeVisible();
  const offRow = fullOff
    .getByRole("heading", { name: "When Linux is full" })
    .element().parentElement!;
  expect(offRow.textContent).toContain("Only applies while the Runner is on.");
  expect(offRow.textContent).not.toContain("Where jobs run is Linux");

  await using folded = await setup(ON, { target: "runner-ssh-timeout" });
  await expect.element(folded.getByLabelText("SSH timeout")).toBeVisible();
});

it("folds the connection checks until opened", async () => {
  await using screen = await setup(ON);
  expect(screen.container.querySelector('[aria-label="SSH timeout"]')).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Connection checks" }));
  await expect.element(screen.getByLabelText("SSH timeout")).toBeVisible();
});

it("says how Linux is doing in the header and on the host row", async () => {
  await using screen = await setup(ON, { state: { linux: LINUX } });
  await expect.element(screen.getByText("Linux online", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Linux online · 0 of 2 running")).toBeVisible();
  await using offline = await setup(ON, { state: { linux: { ...LINUX, online: false } } });
  // The header and the host row both say it when Linux gives no error.
  expect(offline.getByText("Linux offline", { exact: true }).elements()).toHaveLength(2);
  await using checking = await setup(ON, { state: { linux: { ...LINUX, online: null } } });
  await expect.element(checking.getByText("Checking Linux", { exact: true })).toBeVisible();
});

it("resets to the built-in value, but leaves machine rows alone in a project", async () => {
  await using env = await setup({
    ...ON,
    runnerWhere: "linux",
    runnerLinuxFull: "balance",
    runnerLinuxSlots: 4,
  });
  await userEvent.click(env.getByRole("button", { name: "Reset Where heavy work runs" }));
  await userEvent.click(env.getByRole("button", { name: "Reset When Linux is full" }));
  await userEvent.click(env.getByRole("button", { name: "Reset Jobs at once on Linux" }));
  expect(patches()).toEqual([
    { runnerWhere: "automatic" },
    { runnerLinuxFull: "wait" },
    { runnerLinuxSlots: 2 },
  ]);

  await using project = await setup(
    { ...ON, runnerWhere: "linux", runnerLinuxSlots: 4, runnerHost: "pc" },
    { scope: "project", mixed: ["runnerDropped", "runnerMacOnly"] },
  );
  const dropped = project.getByRole("group", { name: "If a Linux run fails" });
  for (const name of ["Tell the agent", "Ask me", "Run on this Mac", "Wait for Linux"]) {
    await expect
      .element(dropped.getByRole("button", { name }))
      .toHaveAttribute("aria-pressed", "false");
  }
  await expect.element(project.getByText(/Differs across the selected targets/)).toBeVisible();
  for (const name of ["Reset Jobs at once on Linux", "Reset Linux host"]) {
    expect(project.container.querySelector(`[aria-label="${name}"]`)).toBeNull();
  }
});

it("hides the Linux status across several environments", async () => {
  await using screen = await setup(ON, { environmentIds: ["a", "b"], state: { linux: LINUX } });
  await expect.element(screen.getByRole("switch", { name: "Use the Runner" })).toBeEnabled();
  expect(screen.container.textContent).not.toContain("Linux online");
});
