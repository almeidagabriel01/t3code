import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

import "../../index.css";
import { providerInstanceEntriesFor } from "../../providerInstances";

vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ title, control, resetAction, children }) => (
    <div>
      <h3>{title}</h3>
      {control}
      {resetAction}
      {children}
    </div>
  ),
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
}));

import { FolderModelsRow } from "./FolderModelsRow";

const codex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    {
      slug: "synthetic-model",
      name: "Synthetic Display",
      isCustom: false,
      isDefault: true,
      capabilities: {},
    },
  ],
  slashCommands: [],
  skills: [],
};
const modelSelection = { instanceId: codex.instanceId, model: "synthetic-model" };

const row = (
  rules: typeof DEFAULT_UNIFIED_SETTINGS.folderModelDefaults,
  update: (patch: unknown) => void,
  mixed = false,
) => {
  const settings = { ...DEFAULT_UNIFIED_SETTINGS, folderModelDefaults: rules };
  return (
    <FolderModelsRow
      settings={settings}
      providers={[codex]}
      update={update as never}
      mixed={mixed}
      anchor={modelSelection}
      environmentId={EnvironmentId.make("device")}
      instanceEntries={providerInstanceEntriesFor([codex], settings, null)}
    />
  );
};

it("shows each rule with the model's display name and removes it", async () => {
  const update = vi.fn();
  await using _screen = await render(row([{ folder: "/Users/me/work", modelSelection }], update), {
    router: false,
  });

  await expect.element(page.getByText("/Users/me/work")).toBeVisible();
  await expect.element(page.getByText("Synthetic Display")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Remove /Users/me/work" }));
  expect(update).toHaveBeenCalledWith({ folderModelDefaults: [] });
});

it("adds a rule with the typed folder and the default model", async () => {
  const update = vi.fn();
  await using _screen = await render(row([], update), { router: false });

  await userEvent.click(page.getByRole("button", { name: "Add folder" }));
  await userEvent.click(page.getByRole("button", { name: "Cancel" }));
  await expect.element(page.getByLabelText("Folder")).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Add folder" }));
  await userEvent.fill(page.getByLabelText("Folder"), "  ~/work/ ");
  await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
  expect(update).toHaveBeenCalledWith({
    folderModelDefaults: [{ folder: "~/work", modelSelection }],
  });
});

it("shows only Mixed when the selected environments differ", async () => {
  await using _screen = await render(
    row([{ folder: "/Users/me/work", modelSelection }], vi.fn(), true),
    { router: false },
  );

  await expect.element(page.getByText("Mixed")).toBeVisible();
  await expect.element(page.getByText("/Users/me/work")).not.toBeInTheDocument();
});
