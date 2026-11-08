import type { EnvironmentId, ServerProviderSkill } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import { GlobalSkillsSettings } from "./GlobalSkillsSettings";

const mocks = vi.hoisted(() => ({
  disabled: [] as string[],
  skills: [] as unknown[],
  phase: "connected" as string,
  scopeKind: "environment" as string,
  can: true,
  update: vi.fn(),
  rescan: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("./SettingsScopeContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({
    environment: {
      environmentId: "env",
      connection: { phase: mocks.phase },
      serverConfig: {},
    },
    scope: { kind: mocks.scopeKind },
  }),
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useEnvironmentSettings: (
    _id: string,
    select: (settings: { disabledGlobalSkills: string[] }) => unknown,
  ) => select({ disabledGlobalSkills: mocks.disabled }),
}));
vi.mock("../../state/server", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await importOriginal<typeof import("../../state/server")>()),
    serverEnvironment: {
      configValueAtom: () => Atom.make({ providers: [{ skills: mocks.skills }] }),
      updateSettings: { id: "update", permissionAtom: () => Atom.make(mocks.can) },
    },
  };
});
vi.mock("../../state/globalSkills", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    globalSkillsEnvironment: {
      rescan: { id: "rescan", permissionAtom: () => Atom.make(mocks.can) },
      remove: { id: "remove", permissionAtom: () => Atom.make(mocks.can) },
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { id: string }) =>
    command.id === "update" ? mocks.update : command.id === "rescan" ? mocks.rescan : mocks.remove,
}));

const skill = (name: string, extra: Partial<ServerProviderSkill> = {}): ServerProviderSkill => ({
  name,
  path: `/skills/${name}`,
  scope: "t3",
  enabled: true,
  ...extra,
});
const folderResult = {
  _tag: "Success",
  value: { globalSkillsDir: "/home/me/.t3/skills", skills: [] },
};

function setup(skills: unknown[] = [], disabled: string[] = []) {
  mocks.skills = skills;
  mocks.disabled = disabled;
  mocks.phase = "connected";
  mocks.scopeKind = "environment";
  mocks.can = true;
  for (const mock of [mocks.update, mocks.rescan, mocks.remove]) {
    mock.mockReset();
    mock.mockResolvedValue(folderResult);
  }
}

const mount = () => render(<GlobalSkillsSettings />, { router: false }); // scope and settings are mocked

it("lists T3 skills once, even when several providers publish them, and toggles by name", async () => {
  setup(
    [skill("t3:one", { displayName: "One", description: "Does one" }), skill("t3:two")],
    ["t3:two"],
  );
  await using _screen = await mount();
  await expect.element(page.getByText("One (t3:one)")).toBeVisible();
  await expect.element(page.getByText("Does one")).toBeVisible();
  await expect.element(page.getByRole("switch", { name: "Enable t3:two" })).not.toBeChecked();
  await userEvent.click(page.getByRole("switch", { name: "Enable t3:one" }));
  expect(mocks.update).toHaveBeenCalledWith({
    environmentId: "env" as EnvironmentId,
    input: { patch: { disabledGlobalSkills: ["t3:two", "t3:one"] } },
  });
  await userEvent.click(page.getByRole("switch", { name: "Enable t3:two" }));
  expect(mocks.update).toHaveBeenLastCalledWith({
    environmentId: "env" as EnvironmentId,
    input: { patch: { disabledGlobalSkills: [] } },
  });
});

it("says there are none yet, rescans to show the folder, and copies nothing before that", async () => {
  setup();
  await using _screen = await mount();
  await expect.element(page.getByText("No T3 skills yet")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Copy path" })).toBeDisabled();
  await userEvent.click(page.getByRole("button", { name: "Rescan" }));
  await expect.element(page.getByText("/home/me/.t3/skills")).toBeVisible();
  expect(mocks.rescan).toHaveBeenCalledWith({ environmentId: "env", input: {} });
  await expect.element(page.getByRole("button", { name: "Copy path" })).toBeEnabled();
});

it("removes a skill only after confirming", async () => {
  setup([skill("t3:one")]);
  await using _screen = await mount();
  await userEvent.click(page.getByRole("button", { name: "Remove", exact: true }));
  expect(mocks.remove).not.toHaveBeenCalled();
  await userEvent.click(
    page.getByRole("alertdialog").getByRole("button", { name: "Remove", exact: true }),
  );
  await vi.waitFor(() =>
    expect(mocks.remove).toHaveBeenCalledWith({
      environmentId: "env" as EnvironmentId,
      input: { name: "t3:one" },
    }),
  );
});

it("shows why a rescan or a toggle failed", async () => {
  setup([skill("t3:one")]);
  mocks.rescan.mockResolvedValue({ _tag: "Failure", cause: Cause.fail("Could not rescan.") });
  mocks.update.mockResolvedValue({ _tag: "Failure", cause: Cause.fail("Managed by Acme.") });
  await using _screen = await mount();
  await userEvent.click(page.getByRole("button", { name: "Rescan" }));
  await expect.element(page.getByText(/Could not rescan/)).toBeVisible();
  await userEvent.click(page.getByRole("switch", { name: "Enable t3:one" }));
  await expect.element(page.getByText(/Managed by Acme/)).toBeVisible();
});

it("leaves toggles read-only for a project scope and asks to connect first", async () => {
  setup([skill("t3:one")]);
  mocks.scopeKind = "project";
  {
    await using _screen = await mount();
    await expect.element(page.getByText(/Environment-wide setting/)).toBeVisible();
    await expect.element(page.getByRole("switch", { name: "Enable t3:one" })).toBeDisabled();
  }
  mocks.phase = "connecting";
  await using _screen = await mount();
  await expect.element(page.getByText(/Connect an environment/)).toBeVisible();
});
