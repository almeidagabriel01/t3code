import type { Assistant } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => {
  const syncStatus = { label: "syncStatus" };
  const projectBindingGet = { label: "projectBindingGet" };
  const forgetCommand = { label: "forget" };
  return {
    Children: ({ children }: { children?: ReactNode }) => children,
    mocks: {
      syncStatus,
      projectBindingGet,
      forgetCommand,
      sync: { state: "ready", memorySpaceId: "space-1" } as unknown,
      canRead: true,
      pages: {} as Record<string, unknown[]>,
      failList: false,
      binding: { projectKey: { kind: "repository", groupingKey: "repo" } } as unknown,
      forget: vi.fn(),
      // Stable like the app's compiled hooks: a new function each render would re-run the effects.
      getSync: vi.fn(),
      getBinding: vi.fn(),
      navigate: vi.fn(),
      selectDetail: vi.fn(),
      confirm: vi.fn(),
      alert: vi.fn(),
    },
  };
});
vi.mock("react-native", () => ({ View: Children }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000001" }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Dialog", () => ({ confirm: mocks.confirm, alert: mocks.alert }));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string }) => (
    <>
      {props.label} {props.description}
    </>
  ),
}));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    accessibilityLabel: string;
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/IconButton", () => ({
  IconButton: (props: { accessibilityLabel: string; onPress: () => void }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress} />
  ),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { environmentId: "hub", id: "project-1", title: "Website", repositoryIdentity: null },
  ],
}));
vi.mock("../../state/memory", () => ({
  memoryEnvironment: {
    syncStatus: {
      ...mocks.syncStatus,
      permissionAtom: () => ({}),
    },
    projectBindingGet: { ...mocks.projectBindingGet, permissionAtom: () => ({}) },
    forget: mocks.forgetCommand,
    list: (args: { input: { scope: { kind: string } } }) => ({ scope: args.input.scope }),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { scope: { kind: string } } | null) =>
    atom === null
      ? { data: null, error: null }
      : mocks.failList && atom.scope.kind === "project"
        ? { data: null, error: "boom" }
        : {
            data: Option.some({ items: mocks.pages[atom.scope.kind] ?? [] }),
            error: null,
          },
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => mocks.canRead }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === mocks.forgetCommand
      ? mocks.forget
      : (command as { label?: string }).label === "syncStatus"
        ? mocks.getSync
        : mocks.getBinding,
}));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.selectDetail,
}));

import { AssistantWorkMemorySection } from "./AssistantWorkMemorySection";

const assistant = (overrides: Partial<Assistant> = {}) =>
  ({
    id: "ada",
    projectId: "project-1",
    threadId: "assistant:ada:2",
    scope: "all",
    ...overrides,
  }) as unknown as Assistant;
const item = (
  memoryId: string,
  text: string,
  scope: unknown,
  threadId: string | null,
  at: string,
) => ({
  memoryId,
  memorySpaceId: "space-1",
  status: "active",
  scope,
  revision: { createdAtUtc: at, revisionId: `rev-${memoryId}` },
  payload: {
    text,
    evidence:
      threadId === null
        ? []
        : [{ origin: "thread", sourceThread: { environmentId: "hub", threadId }, messageIds: [] }],
  },
});

let root: Root;
let container: HTMLDivElement;
const render = (input: Assistant = assistant()) =>
  act(async () => {
    root.render(<AssistantWorkMemorySection environmentId={"hub" as never} assistant={input} />);
  });
const button = (label: string, index = 0) => {
  const found = Array.from(container.querySelectorAll("button")).filter(
    (entry) => entry.getAttribute("aria-label") === label,
  )[index];
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  for (const mock of [mocks.forget, mocks.navigate, mocks.selectDetail, mocks.confirm, mocks.alert])
    mock.mockReset();
  mocks.sync = { state: "ready", memorySpaceId: "space-1" };
  mocks.getSync.mockImplementation(() => Promise.resolve({ _tag: "Success", value: mocks.sync }));
  mocks.getBinding.mockImplementation(() =>
    Promise.resolve({ _tag: "Success", value: mocks.binding }),
  );
  mocks.canRead = true;
  mocks.failList = false;
  mocks.pages = {
    user: [
      item(
        "learned",
        "Prefers short answers",
        { kind: "user" },
        "assistant:ada:1",
        "2026-11-01T00:00:00Z",
      ),
      item("typed", "Typed by the user", { kind: "user" }, null, "2026-11-02T00:00:00Z"),
      item("other", "Learned by Bob", { kind: "user" }, "assistant:bob:1", "2026-11-03T00:00:00Z"),
    ],
    project: [
      item(
        "repo",
        "Uses pnpm here",
        { kind: "project" },
        "assistant:ada:g-abc",
        "2026-11-04T00:00:00Z",
      ),
    ],
    thread: [item("own", "Asked for tea", { kind: "thread" }, null, "2026-11-05T00:00:00Z")],
  };
  mocks.pages.thread![0] = {
    ...(mocks.pages.thread![0] as object),
    scope: { kind: "thread", thread: { environmentId: "hub", threadId: "assistant:ada:2" } },
  };
});
afterEach(() => act(() => root.unmount()));

describe("AssistantWorkMemorySection", () => {
  it("lists what its conversations taught, newest first, with scope and source", async () => {
    await render(assistant({ scope: "project" }));
    const text = container.textContent!;
    expect(text.indexOf("Asked for tea")).toBeLessThan(text.indexOf("Uses pnpm here"));
    expect(text.indexOf("Uses pnpm here")).toBeLessThan(text.indexOf("Prefers short answers"));
    expect(text).toContain("Website · from a conversation");
    expect(text).toContain("User · from a conversation");
    expect(text).not.toContain("Typed by the user");
    expect(text).not.toContain("Learned by Bob");
  });

  it("leaves the project's memories out for an assistant with no project", async () => {
    await render();
    expect(container.textContent).not.toContain("Uses pnpm here");
    expect(container.textContent).toContain("Prefers short answers");
  });

  it("opens a memory in Memory to edit, and its source conversation", async () => {
    await render();
    act(() => button("Edit memory: Asked for tea").click());
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsMemory", {
      environmentId: "hub",
      memorySpaceId: "space-1",
      memoryId: "own",
    });
    act(() => button("Open source conversation", 1).click());
    expect(mocks.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "assistant:ada:1" },
    });
  });

  it("forgets a memory after confirming, and says when the server refuses", async () => {
    mocks.forget.mockResolvedValueOnce({ _tag: "Success", value: { outcome: "accepted" } });
    await render();
    act(() => button("Forget memory").click());
    const request = mocks.confirm.mock.lastCall![0];
    expect(request).toMatchObject({ destructive: true, confirmText: "Forget" });
    await act(async () => request.onConfirm());
    expect(mocks.forget).toHaveBeenCalledWith({
      environmentId: "hub",
      input: {
        memorySpaceId: "space-1",
        memoryId: "own",
        expectedHeads: ["rev-own"],
        operationId: "00000000-0000-4000-8000-000000000001",
      },
    });
    expect(mocks.alert).not.toHaveBeenCalled();

    mocks.forget.mockResolvedValueOnce({ _tag: "Success", value: { outcome: "rejected" } });
    await act(async () => mocks.confirm.mock.lastCall![0].onConfirm());
    expect(mocks.alert).toHaveBeenCalledWith(
      "Could not forget this memory",
      "Open it in Memory to review the record before trying again.",
    );
    mocks.forget.mockResolvedValueOnce({ _tag: "Failure" });
    await act(async () => mocks.confirm.mock.lastCall![0].onConfirm());
    expect(mocks.alert).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "no read permission",
      () => {
        mocks.canRead = false;
      },
      "Memory read permission is required",
    ],
    [
      "no memory space",
      () => {
        mocks.sync = { state: "disabled", retainedLocalSpaceId: null };
      },
      "Memory is off or still getting ready",
    ],
    [
      "nothing learned",
      () => {
        mocks.pages = {};
      },
      "Nothing remembered yet.",
    ],
  ] as [string, () => void, string][])("%s", async (_name, arrange, message) => {
    arrange();
    await render();
    expect(container.textContent).toContain(message);
  });

  it("says when a scope could not be read", async () => {
    mocks.failList = true;
    mocks.pages = {};
    await render(assistant({ scope: "project" }));
    expect(container.textContent).toContain("Some memories could not be loaded.");
  });
});
