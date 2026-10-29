import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

const environmentId = EnvironmentId.make("device");
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
      name: "synthetic-model",
      isCustom: false,
      isDefault: true,
      capabilities: {},
    },
  ],
  slashCommands: [],
  skills: [],
};

const mocks = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_UNIFIED_SETTINGS,
  update: vi.fn(),
}));

vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => mocks.settings }));
vi.mock("../../state/environments", () => ({
  useEnvironmentProviders: () => new Map([[environmentId, [codex]]]),
}));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return { serverEnvironment: { updateSettings: { permissionAtom: () => allowed } } };
});
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingsRow: ({
    title,
    control,
    status,
  }: {
    title?: ReactNode;
    control?: ReactNode;
    status?: ReactNode;
  }) => (
    <div>
      {title}
      {control}
      {status}
    </div>
  ),
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));

import { MemoryGenerationSettings } from "./MemoryGenerationSettings";

// The switch's hit area is zero-sized without the app stylesheet, so click the element itself.
async function toggle(container: HTMLElement, label: string) {
  await act(async () =>
    container.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`)!.click(),
  );
}

async function mountSettings() {
  const registry = AtomRegistry.make();
  const screen = await render(
    <RegistryContext value={registry}>
      <MemoryGenerationSettings environmentId={environmentId} />
    </RegistryContext>,
    // The settings rows need no router.
    { router: false },
  );
  return { screen, [Symbol.dispose]: () => registry.dispose() };
}

it("turns summaries off and on, and follows the text generation model until a separate one is chosen", async () => {
  mocks.update.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.settings = { ...DEFAULT_UNIFIED_SETTINGS, memoryEnabled: true, memoryModelSelection: null };
  using mounted = await mountSettings();
  await using screen = mounted.screen;

  await toggle(screen.container, "Remember conversations");
  expect(mocks.update).toHaveBeenLastCalledWith({
    environmentId,
    input: { patch: { memoryEnabled: false } },
  });

  await expect.element(screen.getByText(/^Automatic · /)).toBeVisible();
  await toggle(screen.container, "Use a separate memory model");
  expect(mocks.update).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      patch: {
        memoryModelSelection: expect.objectContaining({ instanceId: "codex" }),
      },
    },
  });

  mocks.settings = {
    ...mocks.settings,
    memoryModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "synthetic-model",
    },
  };
  await screen.rerender(
    <RegistryContext value={AtomRegistry.make()}>
      <MemoryGenerationSettings environmentId={environmentId} />
    </RegistryContext>,
  );
  await toggle(screen.container, "Use a separate memory model");
  expect(mocks.update).toHaveBeenLastCalledWith({
    environmentId,
    input: { patch: { memoryModelSelection: null } },
  });
});
