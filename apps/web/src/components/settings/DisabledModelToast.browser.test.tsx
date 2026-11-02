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

import { providerInstanceEntriesFor } from "../../providerInstances";
import { toastManager } from "../ui/toast";

// The real picker disables such models, so only a stub reaches the guard inside each row.
vi.mock(import("../chat/ProviderModelPicker"), () => ({
  ProviderModelPicker: ((props: {
    triggerAriaLabel: string;
    onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  }) => (
    <button
      type="button"
      onClick={() => props.onInstanceModelChange(codex.instanceId, "synthetic-model")}
    >
      {props.triggerAriaLabel}
    </button>
  )) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ control, children }) => (
    <div>
      {control}
      {children}
    </div>
  ),
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
}));

import { FallbackModelsRow } from "./FallbackModelsRow";
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
      name: "Synthetic",
      isCustom: false,
      isDefault: true,
      capabilities: {},
    },
  ],
  slashCommands: [],
  skills: [],
};
const modelSelection = { instanceId: codex.instanceId, model: "synthetic-model" };

const props = (update: (patch: unknown) => void) => ({
  settings: {
    ...DEFAULT_UNIFIED_SETTINGS,
    folderModelDefaults: [{ folder: "/work", modelSelection }],
    fallbackModelSelections: [modelSelection],
  },
  providers: [codex],
  update: update as never,
  mixed: false,
  anchor: modelSelection,
  environmentId: EnvironmentId.make("device"),
  instanceEntries: providerInstanceEntriesFor([codex], DEFAULT_UNIFIED_SETTINGS, null),
  getModelDisabledReason: () => "Out of usage",
});

it.each([
  ["Model for /work", "Folder model not saved", FolderModelsRow],
  ["Fallback model 1", "Fallback model not saved", FallbackModelsRow],
  ["Add fallback model", "Fallback model not saved", FallbackModelsRow],
] as const)(
  "picking a disabled model from %s toasts and saves nothing",
  async (name, title, Row) => {
    const update = vi.fn();
    using add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await using _screen = await render(<Row {...props(update)} />, { router: false });

    await userEvent.click(page.getByRole("button", { name }));
    expect(add).toHaveBeenCalledWith({ type: "error", title, description: "Out of usage" });
    expect(update).not.toHaveBeenCalled();
  },
);
