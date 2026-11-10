import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";
import { render } from "../../../test/render";
import { EnvironmentScopeMenu, ProjectScopeMenu } from "./SettingsScopeSentence";
import type { SettingsScopeSearch } from "./settingsScope";

function group(name: string, hosts = ["laptop"], archived = false): SidebarProjectSnapshot {
  const members = hosts.map((host) => member(name, host));
  return {
    ...members[0]!,
    projectKey: name,
    displayName: name,
    memberProjects: members,
    archived,
  } as unknown as SidebarProjectSnapshot;
}

function member(name: string, host: string) {
  return {
    id: ProjectId.make(name),
    environmentId: EnvironmentId.make(host),
    title: name,
    workspaceRoot: `/repos/${name}`,
    physicalProjectKey: `laptop:/repos/${name}`,
    environmentLabel: "Laptop",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

function Harness({
  names,
  onChange,
}: {
  names: string[];
  onChange: (s: SettingsScopeSearch) => void;
}) {
  const [value, setValue] = useState<SettingsScopeSearch>({});
  return (
    <ProjectScopeMenu
      value={value}
      groups={names.map((name) => group(name))}
      environments={[] as unknown as EnvironmentPresentation[]}
      singleEnvironment={false}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

it.each([
  ["menu", ["alpha", "beta", "gamma"]],
  ["combobox", ["alpha", "beta", "gamma", "delta", "eps", "zeta", "eta"]],
])("selects several projects and clears them with All projects (%s)", async (_variant, names) => {
  const changes: SettingsScopeSearch[] = [];
  await using _screen = await render(<Harness names={names} onChange={(s) => changes.push(s)} />, {
    router: false,
  });
  await page.getByLabelText("Project scope: All projects").click();
  await page.getByText("alpha", { exact: true }).click();
  await page.getByText("beta", { exact: true }).click();
  await expect
    .element(page.getByLabelText("Project scope: alpha, beta"))
    .toHaveTextContent("2 projects");
  expect(changes).toEqual([]);
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(changes).toEqual([{ project: '["alpha","beta"]' }]));

  await page.getByLabelText("Project scope: alpha, beta").click();
  await page.getByText("All projects", { exact: true }).last().click();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(changes.at(-1)).toEqual({}));
  await expect.element(page.getByLabelText("Project scope: All projects")).toBeVisible();
});

it("offers only the environments of the selected projects", async () => {
  const environments = ["laptop", "desktop", "server"].map((id) => ({
    environmentId: EnvironmentId.make(id),
    label: id,
    displayUrl: null,
    serverConfig: null,
    connection: { phase: "connected" },
  })) as unknown as EnvironmentPresentation[];
  const changes: SettingsScopeSearch[] = [];
  await using _screen = await render(
    <EnvironmentScopeMenu
      value={{ project: '["alpha","beta","gone"]' }}
      groups={[group("alpha", ["laptop", "desktop"]), group("beta", ["desktop"])]}
      environments={environments}
      singleEnvironment={false}
      onChange={(next) => changes.push(next)}
    />,
    { router: false },
  );
  await page.getByLabelText("Environment scope: All environments").click();
  await expect.element(page.getByRole("menuitemradio", { name: /^laptop/ })).toBeVisible();
  await expect.element(page.getByRole("menuitemradio", { name: /^desktop/ })).toBeVisible();
  await expect
    .element(page.getByRole("menuitemradio", { name: /^server/ }))
    .not.toBeInTheDocument();
  await page.getByRole("menuitemradio", { name: /^desktop/ }).click();
  await vi.waitFor(() => expect(changes[0]?.machine).toBe("desktop"));
});

it("marks archived projects in the project menu", async () => {
  await using _screen = await render(
    <ProjectScopeMenu
      value={{}}
      groups={[group("old", ["laptop"], true)]}
      environments={[] as unknown as EnvironmentPresentation[]}
      singleEnvironment={false}
      onChange={() => {}}
    />,
    { router: false },
  );
  await page.getByLabelText("Project scope: All projects").click();
  await expect.element(page.getByText("Archived")).toBeVisible();
});
