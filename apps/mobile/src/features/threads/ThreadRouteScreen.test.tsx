import { RegistryContext } from "@effect/atom-react";
import type { ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { harness, Nothing, noop } = vi.hoisted(() => ({
  harness: {
    selectedThread: null as { environmentId: string; id: string; title: string } | null,
  },
  Nothing: () => null,
  noop: () => undefined,
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: {},
  useNavigation: () => ({}),
  useRoute: () => ({ name: "Thread" }),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <i role="progressbar" />,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: Nothing }));
vi.mock("../../components/LoadingScreen", () => ({
  LoadingScreen: ({ message }: { message: string }) => <p>{message}</p>,
}));
vi.mock("./ThreadScreenHost", () => ({
  ThreadScreenHost: ({ children }: { children: ReactNode }) => <>{children}</>,
  ThreadScreenFallback: (props: { children: ReactNode; header?: ReactNode }) => (
    <>
      {props.header}
      {props.children}
    </>
  ),
  ThreadScreenBinding: (props: { selectedThread: { title: string } }) => (
    <p>thread: {props.selectedThread.title}</p>
  ),
}));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: harness.selectedThread,
    selectedThreadCreation: null,
    selectedThreadDetailRef: null,
    selectedThreadProject: null,
    selectedEnvironmentConnection: null,
  }),
}));
vi.mock("../../state/use-thread-detail", async () => {
  const Option = await import("effect/Option");
  const detail = {
    data: Option.none(),
    error: Option.none(),
    status: "ready",
    history: { hasMoreHistory: false, loading: false, error: null },
  };
  return { useSelectedThreadDetailState: () => detail };
});
vi.mock("../../state/use-thread-composer-state", () => ({
  useThreadComposerState: () => ({
    selectedThreadFeed: [],
    selectedThreadQueueCount: 0,
    selectedThreadQueuedMessages: [],
    sideChatUnavailableReason: null,
  }),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnections: () => ({ onReconnectEnvironment: noop }),
  useRemoteConnectionStatus: () => ({ connectionState: "connected" }),
  useRemoteEnvironmentRuntime: () => ({ connectionState: "connected", serverConfig: null }),
}));
vi.mock("../../state/workspace", () => ({ useConnectionsReady: () => true }));
vi.mock("../../state/shell", () => ({
  useEnvironmentShellReadiness: () => ({ cacheRead: true, status: "ready", hasError: false }),
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: {} }));
vi.mock("../../state/threads", () => ({ threadEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => noop }));
vi.mock("../../state/use-vcs-action-state", () => ({
  dismissGitActionResult: noop,
  useGitActionProgress: () => null,
}));
vi.mock("../../state/use-terminal-session", () => ({
  useKnownTerminalSessions: () => ({ sessions: null }),
}));
vi.mock("../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({}),
}));
vi.mock("../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({}),
}));
vi.mock("../../state/use-selected-thread-requests", () => ({
  useSelectedThreadRequests: () => ({}),
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: null }),
}));
vi.mock("../../state/pending-thread-creation", () => ({ clearPendingThreadCreationOutcome: noop }));
vi.mock("../../state/recover-failed-thread-draft", () => ({ recoverFailedThreadDraft: noop }));
vi.mock("../../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => noop }));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
vi.mock("../../lib/commandMetadata", () => ({ makeTurnCommandMetadata: noop }));
vi.mock("../../lib/projectThreadStartTurn", () => ({ buildProjectThreadStartTurnInput: noop }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "uuid" }));
vi.mock("../connection/connectionTone", () => ({ connectionTone: () => "default" }));
vi.mock("../terminal/terminalMenu", () => ({
  buildTerminalMenuSessions: () => [],
  nextOpenTerminalId: noop,
  resolveProjectScriptTerminalId: noop,
}));
vi.mock("../terminal/terminalLaunchContext", () => ({
  resolvePreferredThreadWorktreePath: noop,
  stagePendingTerminalLaunch: noop,
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  Inspector: Nothing,
  useAdaptiveWorkspaceLayout: () => ({
    layout: { variant: "compact" },
    panes: { auxiliaryPaneVisible: false },
    showInspector: noop,
    toggleAuxiliaryPane: noop,
  }),
}));
vi.mock("../layout/workspace-inspector-sheet", () => ({ InspectorSheetContext: {} }));
vi.mock("../layout/workspace/useAndroidWorkspaceNavigation", () => ({
  useAndroidWorkspaceBack: noop,
  useWorkspaceBackNavigation: () => noop,
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => noop,
}));
vi.mock("../files/thread-file-navigator-pane", () => ({ ThreadFileNavigatorPane: Nothing }));
vi.mock("../settings/settings-navigation", () => ({ openSettings: noop }));
vi.mock("./useRememberThreadProject", () => ({ useRememberThreadProject: noop }));
vi.mock("./use-worktree-setup", () => ({
  useWorktreeSetup: () => ({ snapshot: null, visible: null }),
}));
vi.mock("./GitActionProgressOverlay", () => ({ GitActionProgressOverlay: Nothing }));
vi.mock("./useUnavailableThreadDraftRedirect", () => ({
  useUnavailableThreadDraftRedirect: noop,
}));
vi.mock("./NewTaskDraftRouteScreen", () => ({ NewTaskDraftRouteScreen: Nothing }));
vi.mock("./git/GitOverviewSheet", () => ({ GitOverviewSheet: Nothing }));
vi.mock("./threadContentPresentation", () => ({
  projectThreadContentPresentation: () => ({ kind: "ready" }),
}));
vi.mock("./ThreadHeader", () => ({ ThreadHeader: Nothing }));
vi.mock("./resume-thread", () => ({ resumeThread: noop }));
vi.mock("./thread-inspector-preview", () => ({
  InspectorContentScope: Nothing,
  ThreadInspectorHeader: Nothing,
  ThreadInspectorPreview: Nothing,
}));
vi.mock("./useStartSideChat", () => ({ useStartSideChatWithPrompt: () => noop }));

import { appAtomRegistry } from "../../state/atom-registry";
import { setStartingSideChat, startingSideChatsAtom } from "../../state/starting-side-chats";
import { ThreadRouteScreen } from "./ThreadRouteScreen";

const sideChatId = "side" as ThreadId;

it("shows a starting side chat's message, then why it failed, then the thread itself", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  appAtomRegistry.set(startingSideChatsAtom, {});
  // The empty shell can arrive before the turn starts; the message must stay.
  harness.selectedThread = { environmentId: "env", id: "side", title: "Side chat thread" };
  setStartingSideChat(sideChatId, { prompt: "why does this fail?", error: null });
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ThreadRouteScreen route={{ params: { environmentId: "env", threadId: "side" } }} />
      </RegistryContext.Provider>,
    ),
  );
  expect(host.querySelector("h1")?.textContent).toBe("Side chat");
  expect(host.textContent).toContain("why does this fail?");
  expect(host.textContent).toContain("Starting the side chat…");
  expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(host.textContent).not.toContain("thread: Side chat thread");

  // A failed fork leaves no thread behind: the screen says why.
  harness.selectedThread = null;
  await act(async () =>
    setStartingSideChat(sideChatId, { prompt: "why does this fail?", error: "offline" }),
  );
  expect(host.textContent).toContain("why does this fail?");
  expect(host.textContent).toContain("Side chat not started");
  expect(host.textContent).toContain("offline");
  expect(host.textContent).toContain("Your message is back in the main chat.");
  expect(host.textContent).not.toContain("Starting the side chat…");
  expect(host.querySelector('[role="progressbar"]')).toBeNull();

  // A failure whose thread exists after all gives way to the thread.
  harness.selectedThread = { environmentId: "env", id: "side", title: "Side chat thread" };
  await act(async () =>
    setStartingSideChat(sideChatId, { prompt: "why does this fail?", error: "timed out" }),
  );
  expect(host.textContent).toContain("thread: Side chat thread");
  expect(host.textContent).not.toContain("Side chat not started");

  await act(async () => setStartingSideChat(sideChatId, null));
  expect(host.textContent).toContain("thread: Side chat thread");
  expect(host.textContent).not.toContain("why does this fail?");

  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
