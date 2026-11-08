import type { EnvironmentId, ThreadId, ThreadWorkspaceStatus } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    data: null as unknown,
    refresh: vi.fn(),
    restore: vi.fn(),
    canRestore: true,
  },
}));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { error: unknown }) => result.error,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: mocks.data, refresh: mocks.refresh }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    threadWorkspaceStatus: () => "status",
    restoreThreadWorkspace: "restore",
  },
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => mocks.canRestore }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.restore }));

import { ThreadWorkspaceNotice } from "./ThreadWorkspaceNotice";

const environmentId = "env" as EnvironmentId;
const threadId = "thread" as ThreadId;

async function mount(turnKey = "run:false") {
  const host = document.createElement("div");
  const root = createRoot(host);
  const element = (key: string) => (
    <ThreadWorkspaceNotice
      environmentId={environmentId}
      threadId={threadId}
      worktreePath="/worktrees/p/feat"
      turnKey={key}
    />
  );
  await act(async () => root.render(element(turnKey)));
  return {
    host,
    rerender: (key: string) => act(async () => root.render(element(key))),
    unmount: () => act(() => root.unmount()),
    button: () => host.querySelector("button"),
  };
}

const cleaned: ThreadWorkspaceStatus = { state: "cleaned", snapshot: null };

describe("ThreadWorkspaceNotice", () => {
  beforeEach(() => {
    mocks.data = cleaned;
    mocks.canRestore = true;
    mocks.refresh.mockReset();
    mocks.restore.mockReset();
  });

  it("renders nothing while the worktree is ready", async () => {
    mocks.data = { state: "ready", snapshot: null };
    const view = await mount();
    expect(view.host.textContent).toBe("");
    await view.unmount();
  });

  it("restores on press and refetches the status", async () => {
    mocks.restore.mockResolvedValue({ _tag: "Success" });
    const view = await mount();
    expect(view.host.textContent).toContain("No saved changes remain");
    await act(async () => view.button()?.click());
    expect(mocks.restore).toHaveBeenCalledWith({ environmentId, input: { threadId } });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    await view.unmount();
  });

  it("shows why a restore failed and keeps the button", async () => {
    mocks.restore.mockResolvedValue({ _tag: "Failure", error: new Error("Conflicts.") });
    const view = await mount();
    await act(async () => view.button()?.click());
    expect(view.host.textContent).toContain("Conflicts.");
    expect(view.button()?.disabled).toBe(false);
    expect(mocks.refresh).not.toHaveBeenCalled();
    await view.unmount();
  });

  it("disables Restore without permission and refetches when a turn changes", async () => {
    mocks.canRestore = false;
    const view = await mount("run:false");
    expect(view.button()?.disabled).toBe(true);
    expect(mocks.refresh).not.toHaveBeenCalled();
    await view.rerender("run:true");
    expect(mocks.refresh).toHaveBeenCalledOnce();
    await view.unmount();
  });
});
