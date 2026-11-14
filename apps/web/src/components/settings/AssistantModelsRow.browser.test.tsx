import {
  AssistantId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

import "../../index.css";
import { providerInstanceEntriesFor } from "../../providerInstances";

vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ title, control, children }) => (
    <div>
      <h3>{title}</h3>
      {control}
      {children}
    </div>
  ),
}));

import { AssistantModelsRow } from "./AssistantModelsRow";

const claude: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    {
      slug: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      isCustom: false,
      isDefault: true,
      capabilities: {},
    },
  ],
  slashCommands: [],
  skills: [],
};
const opus = { instanceId: claude.instanceId, model: "claude-opus-5-5" };
const ada = AssistantId.make("ada");
const beto = AssistantId.make("beto");
const assistants = [
  { id: ada, name: "Ada" },
  { id: beto, name: "Beto" },
];

type Save = (
  assistantId: AssistantId,
  selection: ModelSelection | null,
  onFailed: (message: string) => void,
) => void;

const row = (selections: Record<string, ModelSelection>, save: Save) => (
  <AssistantModelsRow
    settings={DEFAULT_UNIFIED_SETTINGS}
    providers={[claude]}
    anchor={opus}
    selections={selections}
    assistants={assistants}
    save={save}
    environmentId={EnvironmentId.make("device")}
    instanceEntries={providerInstanceEntriesFor([claude], DEFAULT_UNIFIED_SETTINGS, null)}
  />
);

it("lists each exception by assistant name and model display name, and removes only that one", async () => {
  const save = vi.fn<Save>();
  await using _screen = await render(row({ ada: opus }, save), { router: false });

  await expect.element(page.getByText("Ada")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Model for Ada" }))
    .toHaveTextContent("Opus 5.5");
  expect(document.body.textContent).not.toContain("claude-opus-5-5");
  await userEvent.click(page.getByRole("button", { name: "Remove Ada" }));
  expect(save).toHaveBeenCalledWith(ada, null, expect.any(Function));
});

it("adds an exception for a chosen assistant that has none yet", async () => {
  const save = vi.fn<Save>();
  await using _screen = await render(row({ ada: opus }, save), { router: false });

  await userEvent.click(page.getByRole("button", { name: "Add assistant" }));
  await userEvent.click(page.getByRole("combobox", { name: "Assistant" }));
  await expect.element(page.getByRole("option", { name: "Ada" })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("option", { name: "Beto" }));
  await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
  expect(save).toHaveBeenCalledWith(beto, opus, expect.any(Function));
  await expect.element(page.getByLabelText("Assistant")).not.toBeInTheDocument();
});

it("keeps the stored exception and shows the server's error inline when a save fails", async () => {
  const save = vi.fn<Save>((_assistantId, _selection, onFailed) =>
    onFailed("Provider instance claudeAgent is disabled."),
  );
  await using _screen = await render(row({ ada: opus }, save), { router: false });

  await userEvent.click(page.getByRole("button", { name: "Remove Ada" }));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Provider instance claudeAgent is disabled.");
  await expect.element(page.getByRole("button", { name: "Model for Ada" })).toBeVisible();
});
