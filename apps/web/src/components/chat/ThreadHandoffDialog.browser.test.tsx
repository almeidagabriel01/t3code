import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { act, render } from "../../../test/render";

const environmentId = EnvironmentId.make("device");
const threadId = ThreadId.make("source-thread");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

const provider = (instanceId: ProviderInstanceId, model: string): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [{ slug: model, name: model, isCustom: false, isDefault: true, capabilities: {} }],
  slashCommands: [],
  skills: [],
});

const mocks = vi.hoisted(() => ({
  handoff: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("~/hooks/useSettings", () => ({ useEnvironmentSettings: () => DEFAULT_UNIFIED_SETTINGS }));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({
    projectId: "project-1",
    title: "Fix login",
    providerInstanceId: codex,
    modelSelection: { instanceId: codex, model: "gpt-test" },
    worktreePath: "/repo/.wt/login",
  }),
  useProject: () => ({ workspaceRoot: "/repo" }),
  waitForThreadShell: () => Promise.resolve(true),
}));
vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    EMPTY_SERVER_PROVIDERS: [],
    serverEnvironment: {
      providersValueAtom: () =>
        Atom.make([provider(codex, "gpt-test"), provider(claude, "claude-test")]),
    },
  };
});
vi.mock("~/state/orchestration", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return { orchestrationEnvironment: { handoffThread: { permissionAtom: () => allowed } } };
});
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.handoff }));
vi.mock("./ProviderModelPicker", () => ({
  ProviderModelPicker: (props: {
    onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  }) => (
    <button type="button" onClick={() => props.onInstanceModelChange(claude, "claude-test")}>
      Pick Claude
    </button>
  ),
}));

import { openThreadHandoffDialog, ThreadHandoffDialogHost } from "./ThreadHandoffDialog";

it("starts a new session with the chosen agent and context, then opens it", async () => {
  mocks.handoff
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { threadId: ThreadId.make("new-thread") } });
  mocks.navigate.mockReset();
  await using screen = await render(
    <RegistryContext value={appAtomRegistry}>
      <ThreadHandoffDialogHost />
    </RegistryContext>,
    // The dialog only needs the navigate function, mocked above.
    { router: false },
  );
  openThreadHandoffDialog(scopeThreadRef(environmentId, threadId));

  await expect.element(screen.getByText("Hand off to another agent")).toBeVisible();
  await expect.element(screen.getByText("/repo/.wt/login")).toBeVisible();
  await userEvent.click(screen.getByText("Pick Claude"));
  await userEvent.click(screen.getByRole("combobox", { name: "Context" }));
  await userEvent.click(screen.getByRole("option", { name: "Full transcript" }));
  await expect
    .element(screen.getByRole("option", { name: "Full transcript" }))
    .not.toBeInTheDocument();
  // The app stylesheet is absent here, so the popup's footer sits under its inert backdrop.
  await act(async () =>
    (screen.getByRole("button", { name: "Start new session" }).element() as HTMLElement).click(),
  );

  expect(mocks.handoff).toHaveBeenCalledWith({
    environmentId,
    input: {
      sourceThreadId: threadId,
      modelSelection: expect.objectContaining({ instanceId: claude, model: "claude-test" }),
      mode: "full",
      clientRequestId: expect.any(String),
    },
  });
  await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
});
