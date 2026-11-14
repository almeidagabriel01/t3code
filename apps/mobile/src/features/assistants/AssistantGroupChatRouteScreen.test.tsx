import { applyAssistantGroupsEvent } from "@t3tools/client-runtime/assistantGroupChat";
import { ASSISTANT_GROUP_MESSAGE_MAX_CHARS, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { act, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Item = { message: { id: string } };

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    /** Group threads that wait on the user's approval. */
    waiting: new Set<string>(),
    live: null as unknown,
    teams: [] as unknown[],
    environmentIds: ["hub"],
    canPost: true,
    canAct: true,
    canMarkRead: true,
    markRead: vi.fn(),
    markUnread: vi.fn(),
    markReadFlow: vi.fn(),
    appState: "active",
    post: vi.fn(),
    taskAction: vi.fn(),
    olderThan: vi.fn(),
    alert: vi.fn(),
    dispatch: vi.fn(),
    goBack: vi.fn(),
    selectDetail: vi.fn(),
    openTeam: { edit: vi.fn(), settings: vi.fn() },
    openEditor: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    scrollToEnd: vi.fn(),
    scrollToIndex: vi.fn(),
    pick: vi.fn(),
    pickMedia: vi.fn(),
    drafts: new Map<string, string>(),
    draftListeners: new Set<() => void>(),
    flush: vi.fn(),
    editor: null as null | { onSubmit?: (alternate: boolean) => void },
    prepare: vi.fn(),
    release: vi.fn(),
    converse: vi.fn(),
    clear: vi.fn(),
    voiceStart: vi.fn(),
    voicePhase: "idle",
    dismissKeyboard: vi.fn(),
    voiceInput: null as null | {
      ownerKey: string;
      readDraftMessage: () => string | null;
      subscribeToDraftChanges: (onChange: () => void) => () => void;
      onChangeDraftMessage: (value: string) => void;
      onChangeSelection: (selection: { start: number; end: number }) => void;
    },
    decisions: [] as unknown[],
    /** Member thread titles the store knows. */
    shells: new Map<string, string>(),
    /** Member threads that run in their own worktree. */
    worktrees: new Map<string, string>(),
    /** Member threads' projects, when not the request's. */
    threadProjects: new Map<string, string>(),
    openedLink: vi.fn(),
    /** Each render of a message's markdown, with the link handlers it got. */
    markdownRender: vi.fn(),
    subscribe: vi.fn(),
    /** Mobile preferences as the atom holds them; saving replaces them and re-renders. */
    preferences: {} as { assistantGroupTabs?: Record<string, string> },
    preferenceListeners: new Set<() => void>(),
    savePreferences: vi.fn(),
    navigate: vi.fn(),
    writeSettings: vi.fn(),
    canWriteSettings: true,
    /** Members' own models in project p1, by assistant id. */
    exceptions: {} as Record<string, unknown>,
    /** Project p2 turns the codex instance off. */
    codexOffInBeta: false,
  },
}));
vi.mock("react-native", () => ({
  Keyboard: { dismiss: () => mocks.dismissKeyboard() },
  // Measured once mounted, like a laid-out view.
  View: (props: {
    children?: ReactNode;
    testID?: string;
    role?: string;
    accessibilityLabel?: string;
    onLayout?: (event: { nativeEvent: { layout: object } }) => void;
  }) => (
    <div
      data-testid={props.testID}
      data-role={props.role}
      data-label={props.accessibilityLabel}
      ref={
        props.onLayout &&
        (() =>
          props.onLayout?.({ nativeEvent: { layout: { x: 24, y: 0, width: 80, height: 44 } } }))
      }
    >
      {props.children}
    </div>
  ),
  ScrollView: Children,
  StyleSheet: { hairlineWidth: 1 },
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
  AppState: {
    get currentState() {
      return mocks.appState;
    },
    addEventListener: () => ({ remove: () => {} }),
  },
  Pressable: (props: {
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean };
    disabled?: boolean;
    onPress?: () => void;
    children?: ReactNode;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-selected={props.accessibilityState?.selected}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("../../lib/composerImages", () => ({
  pickComposerFiles: (...args: unknown[]) => mocks.pick(...args),
  pickComposerMedia: (...args: unknown[]) => mocks.pickMedia(...args),
  convertPastedImagesToAttachments: async () => [],
}));
vi.mock("react-native-reanimated", () => {
  const animation = {
    duration: () => animation,
    easing: () => animation,
    reduceMotion: () => animation,
  };
  return {
    default: {
      View: (props: { children?: ReactNode; testID?: string }) => (
        <div data-testid={props.testID}>{props.children}</div>
      ),
    },
    Easing: { out: () => () => 0, cubic: () => 0 },
    FadeIn: animation,
    FadeOut: animation,
    ReduceMotion: { System: "system" },
    useReducedMotion: () => false,
    withTiming: (value: number) => value,
  };
});
// The editor hands the composer its text as typed; ComposerEditor.ios.test covers the native side.
vi.mock("../../components/ComposerEditor", async () => {
  const { useImperativeHandle } = await import("react");
  return {
    ComposerEditor: (props: {
      ref?: Ref<unknown>;
      placeholder?: string;
      editable?: boolean;
      readOnly?: boolean;
      value: string;
      onChangeText: (value: string) => void;
      onSelectionChange: (selection: { start: number; end: number }) => void;
      onSubmit?: (alternate: boolean) => void;
    }) => {
      mocks.editor = props;
      useImperativeHandle(props.ref, () => ({ flushPendingInput: mocks.flush }));
      return (
        <textarea
          aria-label="Message the group"
          placeholder={props.placeholder}
          disabled={props.editable === false || props.readOnly === true}
          value={props.value}
          onChange={(event) => {
            props.onChangeText(event.target.value);
            const at = event.target.selectionStart;
            props.onSelectionChange({ start: at, end: at });
          }}
        />
      );
    },
  };
});
vi.mock("../../state/use-composer-drafts", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    mocks.draftListeners.add(listener);
    return () => mocks.draftListeners.delete(listener);
  };
  const set = (key: string, text: string) => {
    mocks.drafts.set(key, text);
    for (const listener of mocks.draftListeners) listener();
  };
  return {
    composerDraftsAtom: "drafts",
    useComposerDraft: (key: string) => ({
      text: useSyncExternalStore(subscribe, () => mocks.drafts.get(key) ?? ""),
    }),
    getComposerDraftSnapshot: (key: string) => ({ text: mocks.drafts.get(key) ?? "" }),
    setComposerDraftText: set,
    clearComposerDraftContent: (key: string) => set(key, ""),
  };
});
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    subscribe: (_atom: unknown, listener: () => void) => {
      mocks.draftListeners.add(listener);
      return () => mocks.draftListeners.delete(listener);
    },
  },
}));
vi.mock("../../components/ComposerToolbar", () => ({
  ComposerActionButton: (props: {
    accessibilityLabel: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      onClick={props.onPress}
    />
  ),
}));
vi.mock("../threads/ComposerAttachmentButton", () => ({
  ComposerAttachmentButton: (props: {
    disabled?: boolean;
    onPickMedia: () => Promise<void>;
    onPickFiles: () => Promise<void>;
  }) => (
    <>
      <button
        aria-label="Add attachment:Photo Library"
        disabled={props.disabled}
        onClick={() => void props.onPickMedia()}
      />
      <button
        aria-label="Add attachment:Choose Files"
        disabled={props.disabled}
        onClick={() => void props.onPickFiles()}
      />
    </>
  ),
}));
vi.mock("../threads/ComposerCommandPopover", () => ({ ComposerPopoverSurface: Children }));
vi.mock("../threads/ThreadComposer", () => ({ ComposerSurface: Children }));
vi.mock("../threads/AssistantMarkdownContent", () => ({
  AssistantMarkdownContent: (props: {
    markdown: string;
    linkHandlers: {
      onLinkPress: (href: string) => void;
      linkCustomization?: (href: string) => { label?: string } | undefined;
    };
  }) => (
    <span>
      {mocks.markdownRender(props.markdown, props.linkHandlers)}
      {props.markdown}
      <button
        aria-label={`link in ${props.markdown}`}
        onClick={() => {
          props.linkHandlers.onLinkPress("t3-mention:mention/ada");
          props.linkHandlers.onLinkPress("src/app.ts");
        }}
      />
    </span>
  ),
}));
// One host per screen; each message's links carry the context they were built with. Like the real
// host, its builders stay the same while a preview opens and closes.
vi.mock("../threads/useThreadMarkdownLinks", async () => {
  const { useMemo, useState } = await import("react");
  const linksFor = (context: unknown) => ({
    linkHandlers: {
      onLinkPress: (href: string) => mocks.openedLink(href, context),
      fileContextMenu: () => undefined,
      onFileContextMenuAction: () => {},
    },
    renderImage: () => null,
  });
  const imageSources = () => null;
  return {
    useMarkdownLinks: (host: { linksFor: typeof linksFor }, context: unknown) =>
      useMemo(() => host.linksFor(context), [host.linksFor, context]),
    useMarkdownLinkHost: () => {
      const [file, setFile] = useState<unknown>(null);
      return {
        linksFor,
        onPressPreview: setFile,
        expandedFile: file,
        expandedVideo: null,
        closeFilePreview: () => setFile(null),
        closeVideoPreview: () => {},
        fileShareSourceIdentifier: "share",
        imageSources,
      };
    },
  };
});
vi.mock("../../components/ui/NativePresentation", () => ({ PresentationSource: Children }));
vi.mock("../../components/ui/VideoPreviewModal", () => ({
  VideoPreviewModal: () => <div data-testid="video-preview" />,
}));
vi.mock("../layout/workspace/useAndroidWorkspaceNavigation", () => ({
  useWorkspaceBackNavigation: () => mocks.goBack,
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ appearance: { baseFontSize: 16 } }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => ({ "--color-icon-subtle": "#888888" }),
}));
vi.mock("../threads/thread-work-log", () => ({ ThreadDisclosureChevron: () => null }));
vi.mock("../threads/ThreadFeed", () => {
  const styles = { user: { nativeTextStyle: {} }, assistant: { nativeTextStyle: {} } };
  return { useMarkdownStyles: () => styles };
});
vi.mock("../settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 16, lineHeight: 22 }),
}));
vi.mock("../../lib/composerChipPresentation", () => ({
  contextChipPresentation: () => ({ accent: "#000000" }),
}));
vi.mock("../../lib/contextChipIconSource", () => ({
  contextChipIconSource: (icon: { name: string }) => icon.name,
}));
vi.mock("../../lib/contextChipIcons.generated", () => ({
  CONTEXT_CHIP_ICON_SOURCES: { folder: 1 },
}));
vi.mock("../../lib/attachmentUpload", () => ({
  prepareTurnAttachments: (...args: unknown[]) => mocks.prepare(...args),
  releasePendingAttachmentUploads: (...args: unknown[]) => mocks.release(...args),
}));
vi.mock("../../state/assets", () => ({ useAssetUrl: () => "https://hub/asset" }));
vi.mock("../../lib/assetImageSource", () => ({
  assetImageSource: (_environmentId: string, _resource: unknown, url: string) => ({ uri: url }),
}));
vi.mock("expo-image", () => ({ Image: () => <i>thumb</i> }));
vi.mock("../../components/ui/FilePreviewModal", () => ({
  FilePreviewModal: (props: { source: { name: string; kind: string } | null }) => (
    <div data-testid="preview">{props.source && `${props.source.kind}:${props.source.name}`}</div>
  ),
}));
vi.mock("../../native/ChipIconImages", () => {
  const faces = new Map();
  return { useAssistantFaceImages: () => faces };
});
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: Children }));
vi.mock("react-native-keyboard-controller", () => ({ KeyboardAvoidingView: Children }));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: (props: {
    ref?: Ref<unknown>;
    data: Item[];
    keyExtractor: (item: Item) => string;
    renderItem: (info: { item: Item }) => ReactNode;
    onStartReached: () => void;
    initialScrollIndex?: number;
    initialScrollAtEnd?: boolean;
    onScroll: (event: {
      nativeEvent: {
        contentSize: { height: number };
        contentOffset: { y: number };
        layoutMeasurement: { height: number };
      };
    }) => void;
    ListHeaderComponent: ReactNode;
    ListEmptyComponent: ReactNode;
    contentInset?: { top: number };
  }) => {
    useImperativeHandle(props.ref, () => ({
      scrollToEnd: mocks.scrollToEnd,
      scrollToIndex: mocks.scrollToIndex,
    }));
    const scroll = (y: number) =>
      props.onScroll({
        nativeEvent: {
          contentSize: { height: 1000 },
          contentOffset: { y },
          layoutMeasurement: { height: 400 },
        },
      });
    return (
      <div
        data-testid="list"
        data-initial-index={props.initialScrollIndex}
        data-at-end={String(props.initialScrollAtEnd)}
        data-inset-top={props.contentInset?.top}
      >
        {props.ListHeaderComponent}
        <button aria-label="start reached" onClick={props.onStartReached} />
        <button aria-label="scroll up" onClick={() => scroll(0)} />
        <button aria-label="scroll down" onClick={() => scroll(600)} />
        {props.data.length === 0
          ? props.ListEmptyComponent
          : props.data.map((item) => (
              <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
            ))}
      </div>
    );
  },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    goBack: mocks.goBack,
    dispatch: mocks.dispatch,
    navigate: mocks.navigate,
  }),
  // The tablet sidebar opens the chat by id, outside any navigator screen.
  useRoute: () => {
    throw new Error("useRoute outside a navigator screen");
  },
  StackActions: { push: (name: string, params: unknown) => ({ name, params }) },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode; testID?: string }) => (
    <span data-testid={props.testID}>{props.children}</span>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
type MockMenuItem =
  | { title: string; subtitle?: string; disabled?: boolean; onPress: () => void }
  | { title: string; items: Array<MockMenuItem> };
type MockMenuAction = Extract<MockMenuItem, { onPress: () => void }>;
const flattenMenu = (items: Array<MockMenuItem>): Array<MockMenuAction> =>
  items.flatMap((item) => ("items" in item ? flattenMenu(item.items) : [item]));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: (props: {
    title: string;
    subtitle?: string;
    onBack?: () => void;
    onBackToList?: () => void;
    hideBottomBorder?: boolean;
    menus?: Array<{ items: Array<MockMenuItem> }>;
  }) => (
    <header
      data-back={props.onBack === undefined ? "none" : "back"}
      data-border={props.hideBottomBorder ? "hidden" : "shown"}
    >
      <button aria-label="header:back to list" onClick={props.onBackToList} />
      <h1>{props.title}</h1>
      <p>{props.subtitle}</p>
      {/* Submenu titles, so a test can see what a nested entry is called. */}
      {props.menus?.[0]?.items.flatMap((item) =>
        "items" in item
          ? [
              <span key={item.title} data-testid="header-submenu">
                {item.title}
              </span>,
              ...item.items.flatMap((child) =>
                "items" in child
                  ? [
                      <span key={child.title} data-testid="header-submenu">
                        {child.title}
                      </span>,
                    ]
                  : [],
              ),
            ]
          : [],
      )}
      {flattenMenu(props.menus?.[0]?.items ?? []).map((item) => (
        <button
          key={item.title}
          aria-label={`header:${item.title}`}
          data-subtitle={item.subtitle}
          disabled={item.disabled}
          onClick={item.onPress}
        />
      ))}
    </header>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../voice-input/useVoiceInputController", () => ({
  useVoiceInputController: (input: typeof mocks.voiceInput) => {
    mocks.voiceInput = input;
    return {
      isAvailable: true,
      state: { phase: mocks.voicePhase, error: null, errorAction: null },
      audioLevels: [],
      elapsedSeconds: 0,
      isBusy: false,
      freezesEditor: false,
      blocksSubmission: false,
      start: mocks.voiceStart,
      stop: vi.fn(),
      cancel: vi.fn(),
    };
  },
}));
vi.mock("../voice-input/ComposerDictationControl", () => ({
  ComposerDictationStartAction: (props: { onStart: () => void; disabled?: boolean }) => (
    <button aria-label="Start dictation" disabled={props.disabled} onClick={props.onStart} />
  ),
  ComposerDictationError: () => null,
  ComposerDictationToolbar: (props: { children?: ReactNode }) => (
    <div data-testid="dictation-toolbar">{props.children}</div>
  ),
  ComposerDictationCancelAction: () => null,
  ComposerDictationStatus: () => null,
  ComposerDictationPrimaryAction: () => null,
}));
vi.mock("../../state/decisions", () => ({
  useDecisionEntries: () => ({ open: mocks.decisions, settled: [] }),
}));
vi.mock("../decisions/DecisionCard", () => ({
  DecisionCard: (props: { decision: { title: string } }) => (
    <div data-testid="decision-card">{props.decision.title}</div>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (...args: unknown[]) => mocks.alert(...args),
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string; detail: string }) => (
    <p>{`${props.title}: ${props.detail}`}</p>
  ),
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    accessibilityLabel?: string;
    actions: Array<{
      id: string;
      title: string;
      state?: string;
      attributes?: { disabled?: boolean };
    }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          // Scoped by the menu's label so two menus listing the same names stay apart.
          aria-label={`${props.accessibilityLabel ?? "menu"}:${action.title}`}
          data-state={action.state}
          disabled={action.attributes?.disabled}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        />
      ))}
    </>
  ),
}));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: (props: { markdown: string }) => <span>{props.markdown}</span>,
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.selectDetail,
}));
const PROJECTS = vi.hoisted(() => [
  { environmentId: "hub", id: "p1", title: "Alpha", workspaceRoot: "/repo/alpha" },
  { environmentId: "hub", id: "p2", title: "Beta", workspaceRoot: "/repo/beta" },
  { environmentId: "other", id: "p3", title: "Elsewhere" },
]);
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "hub",
        label: "Hub",
        serverConfig: {
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            projectSettingsOverrides: {
              p1: {
                defaultModelSelection: { instanceId: "codex", model: "gpt-5.5" },
                assistantModelSelections: mocks.exceptions,
              },
              ...(mocks.codexOffInBeta
                ? { p2: { providerInstances: { codex: { enabled: false } } } }
                : {}),
            },
          },
        },
      },
    ],
  }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: (environments: Array<{ environmentId: string }>) =>
    new Set(mocks.canWriteSettings ? environments.map((entry) => entry.environmentId) : []),
}));
vi.mock("../settings/settings-environment-filter", () => ({
  connectedSettingsTargets: (environments: unknown[]) => environments,
}));
vi.mock("../settings/useSettingsWriter", () => ({ useSettingsWriter: () => mocks.writeSettings }));
vi.mock("../settings/components/SettingsModelPicker", () => ({
  modelDisplayName: (_options: unknown, selection: { model: string }) => `name:${selection.model}`,
}));
vi.mock("../../lib/modelOptions", () => ({ buildModelOptions: () => [] }));
vi.mock("../../state/entities", () => ({
  useQuietThreadShell: (ref: { threadId: string } | null) => {
    const title = ref === null ? undefined : mocks.shells.get(ref.threadId);
    const worktreePath = ref === null ? undefined : mocks.worktrees.get(ref.threadId);
    const projectId = ref === null ? undefined : mocks.threadProjects.get(ref.threadId);
    return title === undefined && worktreePath === undefined && projectId === undefined
      ? null
      : { title: title ?? "", worktreePath: worktreePath ?? null, projectId };
  },
  useProject: (ref: { environmentId: string; projectId: string } | null) =>
    PROJECTS.find(
      (project) => project.environmentId === ref?.environmentId && project.id === ref.projectId,
    ) ?? null,
  useProjects: () => PROJECTS,
  useEnvironmentServerConfig: () => null,
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null || !mocks.waiting.has(ref.threadId)
      ? null
      : {
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          pendingSubagentRequest: null,
          pendingGuestMessageCount: 0,
          queuedMessageCount: 0,
          runtime: null,
          blockedOnThreadWait: false,
          latestRun: null,
          source: { latestVisibleMessage: null },
        },
}));
// The store hands out the same entries until they change.
let entries: { teams: unknown; environmentIds: unknown; active: unknown; archived: [] } | undefined;
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => {
    if (entries?.teams !== mocks.teams || entries.environmentIds !== mocks.environmentIds) {
      entries = {
        teams: mocks.teams,
        environmentIds: mocks.environmentIds,
        active: members.map((assistant) => ({ environmentId: "hub", assistant })),
        archived: [],
      };
    }
    return entries;
  },
  useAssistantGroupChat: (...args: unknown[]) => {
    mocks.subscribe(...args);
    return mocks.live;
  },
  useAssistantGroupActions: () => ({
    canPost: mocks.canPost,
    canAct: mocks.canAct,
    canMarkRead: mocks.canMarkRead,
    markRead: mocks.markRead,
    post: mocks.post,
    taskAction: mocks.taskAction,
    olderThan: mocks.olderThan,
  }),
}));
vi.mock("../../components/ui/useBarInset", () => ({ useBarInset: () => 100 }));
vi.mock("../../components/ui/GlassSurface", async () => ({
  GlassSurface: (await import("react-native")).View,
}));
vi.mock("expo-glass-effect", () => ({
  GlassView: Children,
  isGlassEffectAPIAvailable: () => false,
}));
vi.mock("uniwind", () => ({ withUniwind: (component: unknown) => component }));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));
vi.mock("@effect/atom-react", async () => {
  const { useSyncExternalStore } = await import("react");
  const { AsyncResult } = await import("effect/reactivity");
  let held: unknown;
  let result: unknown;
  const subscribe = (listener: () => void) => {
    mocks.preferenceListeners.add(listener);
    return () => mocks.preferenceListeners.delete(listener);
  };
  return {
    useAtomValue: () =>
      useSyncExternalStore(subscribe, () => {
        if (held !== mocks.preferences) {
          held = mocks.preferences;
          result = AsyncResult.success(mocks.preferences);
        }
        return result;
      }),
    useAtomSet: () => mocks.savePreferences,
  };
});
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: (props: { assistant: { name: string } }) => (
    <i>{`av:${props.assistant.name}`}</i>
  ),
}));
vi.mock("./assistantTeamTarget", () => ({ useOpenAssistantTeam: () => mocks.openTeam }));
vi.mock("./useUsageLimitLabel", () => ({
  useUsageLimitLabel: () => (resetAt: string | null | undefined) =>
    resetAt == null ? null : `Limit until <${resetAt}>`,
}));
vi.mock("./openAssistantEditor", () => ({ useOpenAssistantEditor: () => mocks.openEditor }));
vi.mock("./useAssistantFlows", () => ({
  useAssistantTeamFlows: () => ({
    canAct: true,
    canMarkRead: mocks.canMarkRead,
    canConverse: true,
    converse: mocks.converse,
    clear: mocks.clear,
    archive: mocks.archive,
    restore: mocks.restore,
    markRead: mocks.markReadFlow,
    markUnread: mocks.markUnread,
  }),
}));

import { AssistantGroupChatRouteScreen } from "./AssistantGroupChatRouteScreen";

const member = (id: string, name: string, role: string) => ({
  id,
  name,
  handle: id,
  role,
  icon: null,
  avatar: null,
  archivedAt: null,
  projectId: "p1",
  projectIds: ["p1", "p2"],
});
const members = [
  member("ada", "Ada", "Dev"),
  member("beto", "Beto", ""),
  member("jarvis", "Jarvis", ""),
];
const team = (extra: object = {}) => ({
  environmentId: "hub",
  team: {
    id: "g1",
    name: "Crew",
    memberIds: ["ada", "beto", "jarvis"],
    leadId: "jarvis",
    archivedAt: null,
    projectIds: [],
    ...extra,
  },
});
const message = (id: string, seq: number, extra: object = {}) => ({
  id,
  teamId: "g1",
  seq,
  author: "assistant",
  assistantId: "ada",
  authorLabel: null,
  kind: "message",
  text: id,
  replyToMessageId: null,
  taskId: null,
  createdAt: `2026-11-07T10:00:0${seq}Z`,
  ...extra,
});
const task = (id: string, status: string, ownerId: string, extra: object = {}) => ({
  id,
  teamId: "g1",
  rootId: id,
  parentId: null,
  kind: "root",
  requestMessageId: "m1",
  ownerId,
  instruction: `do ${id}`,
  status,
  reason: null,
  threadId: `assistant:${ownerId}:g-0123456789abcdef`,
  createdAt: `2026-11-07T10:00:0${id.length}Z`,
  updatedAt: "2026-11-07T10:00:09Z",
  ...extra,
});
const snapshot = (messages: object[], tasks: object[] = [], hasMore = false): unknown =>
  applyAssistantGroupsEvent(null, { type: "snapshot", messages, tasks, hasMore } as never);

const FEED = [
  message("m1", 1, { author: "user", assistantId: null, text: "@ada build @everyone" }),
  message("m2", 2, { kind: "routing", author: "assistant", text: "Jarvis assigned Ada" }),
  message("m3", 3, { text: "Ada says hi", taskId: "t1" }),
  message("m4", 4, {
    assistantId: "beto",
    text: "Beto replies",
    replyToMessageId: "m3",
  }),
];

let root: Root;
let container: HTMLDivElement;
const render = () =>
  act(() =>
    root.render(
      <AssistantGroupChatRouteScreen
        route={
          {
            key: "k",
            name: "AssistantGroupChat",
            params: { environmentId: "hub", teamId: "g1" },
          } as never
        }
      />,
    ),
  );
const byLabel = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const click = (label: string) => act(async () => byLabel(label)?.click());
const input = () =>
  container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message the group"]')!;
const type = (value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input(),
      value,
    );
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
const text = () => container.textContent ?? "";
const recipients = () => container.querySelector('[data-testid="group-recipients"]')?.textContent;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  Object.assign(mocks, {
    teams: [team()],
    environmentIds: ["hub"],
    canPost: true,
    canAct: true,
    canMarkRead: true,
    appState: "active",
    decisions: [],
    voicePhase: "idle",
    shells: new Map(),
    worktrees: new Map(),
    threadProjects: new Map(),
    live: snapshot(FEED, [
      task("t1", "paused", "ada", { reason: "stopped" }),
      task("t22", "running", "beto"),
    ]),
  });
  for (const fn of [
    mocks.post,
    mocks.taskAction,
    mocks.olderThan,
    mocks.alert,
    mocks.dispatch,
    mocks.selectDetail,
    mocks.openEditor,
    mocks.archive,
    mocks.restore,
    mocks.scrollToEnd,
    mocks.scrollToIndex,
    mocks.pickMedia,
    mocks.flush,
    mocks.markRead,
    mocks.markUnread,
    mocks.markReadFlow,
    mocks.openTeam.edit,
    mocks.pick,
    mocks.prepare,
    mocks.release,
    mocks.converse,
    mocks.clear,
    mocks.voiceStart,
    mocks.openedLink,
    mocks.markdownRender,
    mocks.subscribe,
    mocks.savePreferences,
    mocks.navigate,
    mocks.writeSettings,
  ])
    fn.mockReset();
  mocks.preferences = {};
  mocks.preferenceListeners.clear();
  mocks.savePreferences.mockImplementation(
    (update: { transform: (current: typeof mocks.preferences) => object }) => {
      mocks.preferences = { ...mocks.preferences, ...update.transform(mocks.preferences) };
      for (const listener of mocks.preferenceListeners) listener();
    },
  );
  mocks.canWriteSettings = true;
  mocks.exceptions = {};
  mocks.codexOffInBeta = false;
  mocks.drafts.clear();
  mocks.draftListeners.clear();
  mocks.release.mockResolvedValue(undefined);
  mocks.markRead.mockResolvedValue({ ok: true, value: undefined });
  mocks.post.mockResolvedValue({ ok: true, value: {} });
  mocks.taskAction.mockResolvedValue({ ok: true, value: {} });
});
afterEach(() => act(() => root.unmount()));

describe("group chat feed", () => {
  it("draws a divider where a conversation started or was compacted, with the old messages above", () => {
    mocks.live = snapshot([
      message("old", 1),
      message("b1", 2, { author: "user", assistantId: null, kind: "boundary", text: "new" }),
      message("b2", 3, { author: "user", assistantId: null, kind: "boundary", text: "compact" }),
    ]);
    render();
    const dividers = [...container.querySelectorAll('[data-testid="group-boundary"]')];
    expect(dividers.map((node) => node.textContent)).toEqual([
      "New conversation started",
      "Context compacted",
    ]);
    expect(text()).toContain("old");
  });

  it("shows each kind of row, the header summary, roles, running count and task cards", () => {
    render();
    expect(container.querySelector("h1")?.textContent).toBe("Crew");
    expect(text()).toContain("@ada");
    expect(container.querySelectorAll('[data-testid="group-request"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="group-note"]')?.textContent).toContain(
      "Jarvis assigned Ada",
    );
    expect(container.querySelectorAll('[data-testid="group-answer"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="group-role"]')?.textContent).toBe("Dev");
    // Member mentions render as mention links, which the markdown view draws as chips.
    expect(text()).toContain(
      "[@ada](t3-mention:mention/ada) build [@everyone](t3-mention:mention/everyone)",
    );
    expect(container.querySelector('[data-testid="group-quoted-line"]')?.textContent).toBe(
      "Ada  Ada says hi",
    );
    expect(container.querySelector("h1 + p")?.textContent).toMatch(/ · 1 running$/);
    const statuses = Array.from(
      container.querySelectorAll('[data-testid="group-task-status"]'),
    ).map((node) => node.textContent);
    expect(statuses).toEqual(["Running", "Paused"]);
    expect(text()).toContain("Stopped");
  });

  it("names the owner on cards under a request and says when the lead is still choosing", () => {
    mocks.live = snapshot(
      [
        message("m1", 1, { author: "user", assistantId: null, text: "@ada go" }),
        message("m5", 5, { author: "user", assistantId: null, text: "who takes this?" }),
        message("m6", 6, { assistantId: "ada", text: "done" }),
        message("m7", 7, {
          author: "user",
          assistantId: null,
          text: "why?",
          replyToMessageId: "m6",
        }),
      ],
      [task("t1", "running", "ada")],
    );
    render();
    expect(container.querySelector('[data-testid="group-task-card"]')?.textContent).toContain(
      "Ada",
    );
    expect(container.querySelectorAll('[data-testid="group-routing"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="group-quoted-line"]')?.textContent).toBe(
      "Ada  done",
    );
    expect(container.querySelector('[data-testid="group-routing"]')?.textContent).toBe(
      "Jarvis (lead) is choosing who answers…",
    );
  });

  it("shows a task's expected result and resources, and why a queued one waits", () => {
    mocks.live = snapshot(
      [message("m1", 1, { author: "user", assistantId: null, text: "@ada go" })],
      [
        task("t1", "queued", "ada", {
          reason: "waiting for browser (used by Bo)",
          expectedResult: "the build is green",
          resources: ["folder:/w/app", "browser"],
        }),
        task("t22", "running", "bo"),
        task("t333", "usage_limited", "beto", { resetAt: "2099-01-01T09:30Z" }),
        task("t4444", "usage_limited", "jarvis"),
      ],
    );
    render();
    expect(container.querySelectorAll('[data-testid="group-task-expected"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="group-task-expected"]')?.textContent).toBe(
      "Expected: the build is green",
    );
    expect(container.querySelector('[data-testid="group-task-resources"]')?.textContent).toBe(
      "folder:/w/appbrowser",
    );
    // A usage limit says until when; without a reset ahead its badge says it alone.
    expect(
      Array.from(container.querySelectorAll('[data-testid="group-task-waiting"]'), (node) => [
        node.textContent,
      ]),
    ).toEqual([["waiting for browser (used by Bo)"], ["Limit until <2099-01-01T09:30Z>"]]);
  });

  it("says on a running card when its member waits for the user's approval", () => {
    mocks.waiting = new Set(["assistant:ada:g-0123456789abcdef"]);
    mocks.live = snapshot(
      [message("m1", 1, { author: "user", assistantId: null, text: "@ada go" })],
      [task("t1", "running", "ada"), task("t22", "running", "bo")],
    );
    render();
    const needs = container.querySelectorAll('[data-testid="group-task-needs"]');
    expect(needs).toHaveLength(1);
    expect(needs[0]?.textContent).toBe("Needs your approval · Open the conversation to answer");
    mocks.waiting = new Set();
  });

  it("says what to do in an empty chat, and nothing before the first snapshot", () => {
    mocks.live = null;
    render();
    expect(text()).not.toContain("No messages yet");
    mocks.live = snapshot([]);
    render();
    expect(text()).toContain("@ada to give one a task");
    expect(text()).toContain("Jarvis routes it");
    mocks.teams = [team({ memberIds: [] })];
    render();
    expect(text()).toContain("Add assistants to this group in Edit group");
  });

  it("a missing group says so once its environment loaded", () => {
    mocks.teams = [];
    render();
    expect(text()).toContain("Group not found");
    mocks.environmentIds = [];
    render();
    expect(text()).not.toContain("Group not found");
  });

  it("loads earlier messages from the button or by scrolling up, and shows them", async () => {
    mocks.live = snapshot(FEED, [], true);
    mocks.olderThan.mockResolvedValue({
      ok: true,
      value: {
        messages: [message("m0", 0, { author: "user", assistantId: null, text: "much older" })],
        tasks: [],
        hasMore: false,
      },
    });
    render();
    await click("Load earlier messages");
    expect(mocks.olderThan).toHaveBeenCalledOnce();
    expect(text()).toContain("much older");
    expect(byLabel("Load earlier messages")).toBeNull();
    await click("start reached");
    expect(mocks.olderThan).toHaveBeenCalledOnce();
  });

  it("a failed page is reported and the button stays", async () => {
    mocks.live = snapshot(FEED, [], true);
    mocks.olderThan.mockResolvedValue({ ok: false, message: "offline" });
    render();
    await click("start reached");
    expect(mocks.alert).toHaveBeenCalledWith("Could not load earlier messages", "offline");
    expect(byLabel("Load earlier messages")).not.toBeNull();
  });
});

describe("group composer", () => {
  it("picks a member from @, previews the recipients and sends", async () => {
    render();
    expect(recipients()).toBe("");
    await type("@");
    expect(byLabel("Mention Ada")).not.toBeNull();
    expect(byLabel("Mention everyone")).not.toBeNull();
    await click("Mention Ada");
    expect(input().value).toBe("@ada ");
    expect(byLabel("Mention Ada")).toBeNull();
    await type("@ada do it");
    expect(recipients()).toBe("To Ada");
    await click("Send");
    expect(mocks.post).toHaveBeenCalledWith({ teamId: "g1", text: "@ada do it" });
    expect(input().value).toBe("");
    expect(mocks.scrollToEnd).toHaveBeenCalledOnce();
  });

  it("previews everyone, the lead's routing and the missing mention", async () => {
    render();
    await type("@everyone ship");
    expect(recipients()).toBe("To everyone");
    await type("hello");
    expect(recipients()).toBe("Jarvis (lead) will route it");
    mocks.teams = [team({ leadId: null })];
    render();
    await type("hello again");
    expect(recipients()).toBe("Waits for a lead");
  });

  it("offers the group's projects after #, filters them and inserts the slug", async () => {
    render();
    await type("ship #");
    expect(byLabel("Mention project Alpha")).not.toBeNull();
    expect(byLabel("Mention project Beta")).not.toBeNull();
    await type("ship #be");
    expect(byLabel("Mention project Alpha")).toBeNull();
    await click("Mention project Beta");
    expect(input().value).toBe("ship #beta ");
    expect(byLabel("Mention project Beta")).toBeNull();
  });

  it("sends the text as typed, with mentions, project tags, list markers and code fences", async () => {
    render();
    const markdown = "@ada check #alpha\n\n- first\n- second\n\n```ts\nconst a = 1;\n```";
    await type(markdown);
    // Return on a hardware keyboard sends, as in the thread composer.
    await act(async () => mocks.editor!.onSubmit!(false));
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.post).toHaveBeenCalledWith({ teamId: "g1", text: markdown });
    expect(input().value).toBe("");
  });

  it("posts once when Return and Send land while an edit is still flushing", async () => {
    let finishFlush = () => {};
    mocks.flush.mockReturnValue(new Promise<void>((resolve) => (finishFlush = resolve)));
    render();
    await type("@ada go");
    await act(async () => {
      mocks.editor!.onSubmit!(false);
      byLabel("Send")!.click();
    });
    await act(async () => finishFlush());
    expect(mocks.post).toHaveBeenCalledOnce();
  });

  it("posts @member and #project as typed, and gives the editor the group's chips", async () => {
    render();
    expect(mocks.editor).toMatchObject({
      groupMentions: {
        members: expect.arrayContaining([expect.objectContaining({ handle: "ada", name: "Ada" })]),
        projects: [
          { id: "p1", name: "Alpha" },
          { id: "p2", name: "Beta" },
        ],
      },
    });
    await type("@ada fix #alpha");
    await click("Send");
    expect(mocks.post).toHaveBeenCalledWith({ teamId: "g1", text: "@ada fix #alpha" });
  });

  it("holds a message over the group's length limit", async () => {
    render();
    await type("x".repeat(ASSISTANT_GROUP_MESSAGE_MAX_CHARS + 1));
    await click("Send");
    expect(mocks.post).not.toHaveBeenCalled();
    expect(text()).toContain(`Messages can be up to`);
  });

  it("jumps from a reply's quoted line to the message it answers and tints it once", async () => {
    vi.useFakeTimers();
    try {
      render();
      await click("Show the message from Ada");
      expect(mocks.scrollToIndex).toHaveBeenCalledWith({
        index: 2,
        animated: true,
        viewPosition: 0.4,
      });
      expect(container.querySelectorAll('[data-testid="group-jump-highlight"]')).toHaveLength(1);
      await act(async () => vi.advanceTimersByTime(1200));
      expect(container.querySelector('[data-testid="group-jump-highlight"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers @everyone and marks the lead in the picker", async () => {
    render();
    await type("@e");
    expect(byLabel("Mention everyone")).not.toBeNull();
    expect(byLabel("Mention Ada")).toBeNull();
    await click("Mention everyone");
    expect(input().value).toBe("@everyone ");
    await type("@j");
    expect(byLabel("Mention Jarvis")?.textContent).toContain("lead");
  });

  it("keeps the draft and says to mention someone when the server asks for it", async () => {
    mocks.post.mockResolvedValue({ ok: false, message: "raw", reason: "mention_required" });
    render();
    await type("no mention");
    await click("Send");
    expect(text()).toContain("Mention a member with @, or set a lead in Edit group.");
    expect(input().value).toBe("no mention");
    await type("no mention!");
    expect(text()).not.toContain("Mention a member with @");
  });

  it("explains an archived refusal and shows any other message as is", async () => {
    mocks.post.mockResolvedValue({ ok: false, message: "raw", reason: "archived" });
    render();
    await type("hi");
    await click("Send");
    expect(text()).toContain("This group is archived. Restore it to write here.");
    mocks.post.mockResolvedValue({ ok: false, message: "server down", reason: null });
    await click("Send");
    expect(text()).toContain("server down");
  });

  it("replies to a member's message from the row button or its menu, then clears or sends", async () => {
    render();
    await click("Reply to Ada");
    expect(container.querySelector('[data-testid="group-reply-chip"]')?.textContent).toBe(
      "Replying to Ada",
    );
    await click("Cancel reply");
    expect(container.querySelector('[data-testid="group-reply-chip"]')).toBeNull();
    await click("menu:Reply");
    expect(text()).toContain("Replying to Ada");
    await type("@ada thanks");
    await click("Send");
    expect(mocks.post).toHaveBeenCalledWith({
      teamId: "g1",
      text: "@ada thanks",
      replyToMessageId: "m3",
    });
    expect(container.querySelector('[data-testid="group-reply-chip"]')).toBeNull();
  });

  it("does not send without text or permission", async () => {
    render();
    await click("Send");
    expect(mocks.post).not.toHaveBeenCalled();
    mocks.canPost = false;
    render();
    expect(input().disabled).toBe(true);
  });
});

describe("task cards", () => {
  it("stops a running task, resumes and cancels a paused one, and reassigns to another member", async () => {
    render();
    await click("Stop");
    expect(mocks.taskAction).toHaveBeenLastCalledWith({ taskId: "t22", action: "stop" });
    await click("Resume");
    expect(mocks.taskAction).toHaveBeenLastCalledWith({ taskId: "t1", action: "resume" });
    await click("Cancel");
    expect(mocks.taskAction).toHaveBeenLastCalledWith({ taskId: "t1", action: "cancel" });
    // Reassign lists the members but the owner.
    expect(byLabel("menu:Ada")).toBeNull();
    await click("menu:Beto");
    expect(mocks.taskAction).toHaveBeenLastCalledWith({
      taskId: "t1",
      action: "reassign",
      ownerId: "beto",
    });
  });

  it("reports a refused action and disables the buttons without permission", async () => {
    mocks.taskAction.mockResolvedValue({ ok: false, message: "nope" });
    render();
    await click("Stop");
    expect(mocks.alert).toHaveBeenCalledWith("Could not update the task", "nope");
    mocks.canAct = false;
    render();
    expect(byLabel("Stop")?.disabled).toBe(true);
    expect(byLabel("Reassign")?.disabled).toBe(true);
  });

  const openFirstConversation = () =>
    act(async () =>
      container.querySelectorAll<HTMLButtonElement>('[aria-label="Open conversation"]')[0]!.click(),
    );
  const THREAD = {
    name: "Thread",
    params: { environmentId: "hub", threadId: "assistant:beto:g-0123456789abcdef" },
  };

  it("selects the task's conversation as the detail", async () => {
    render();
    await openFirstConversation();
    expect(mocks.selectDetail).toHaveBeenCalledWith(THREAD);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});

describe("group header and archive", () => {
  it("its menu edits, adds an assistant, schedules and archives", async () => {
    render();
    await click("header:Edit group");
    expect(mocks.openTeam.edit).toHaveBeenCalledWith("hub", "g1");
    await click("header:Group settings");
    expect(mocks.openTeam.settings).toHaveBeenCalledWith("hub", "g1");
    await click("header:New assistant in this group");
    expect(mocks.openEditor).toHaveBeenCalledWith("hub", null, { teamId: "g1" });
    mocks.openTeam.settings.mockClear();
    await click("header:Group routines");
    expect(mocks.openTeam.settings).toHaveBeenCalledWith("hub", "g1", "routines");
    await click("header:Archive group");
    expect(mocks.archive).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
    expect(byLabel("header:Restore group")).toBeNull();
  });

  it("an archived group shows the banner, restores from it or the menu, and cannot be written to", async () => {
    mocks.teams = [team({ archivedAt: "2026-11-07T09:00:00Z" })];
    render();
    expect(text()).toContain("Archived · no new messages");
    expect(input().disabled).toBe(true);
    expect(input().placeholder).toBe("Restore the group to write here");
    expect(byLabel("Reply to Ada")?.disabled).toBe(true);
    expect(byLabel("menu:Reply")?.disabled).toBe(true);
    await click("Restore");
    expect(mocks.restore).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
    await click("header:Restore group");
    expect(mocks.restore).toHaveBeenCalledTimes(2);
    expect(byLabel("header:Archive group")).toBeNull();
  });
});

describe("read position", () => {
  const chat = (readSeq: number, unreadCount: number) => ({
    latestSeq: 4,
    readSeq,
    unreadCount,
    working: false,
    preview: null,
  });
  const newLine = () => container.querySelector('[data-testid="group-new-divider"]');
  const remount = () => {
    act(() => root.unmount());
    root = createRoot(container);
  };

  it("puts a New line above the first message others wrote past the read position, and keeps it", () => {
    mocks.teams = [team({ chat: chat(2, 2) })];
    render();
    const order = [...container.querySelectorAll("[data-testid]")].map((node) =>
      node.getAttribute("data-testid"),
    );
    // m3 is the first unread; the user's own and the routing message above it are skipped.
    expect(order.indexOf("group-new-divider")).toBe(order.indexOf("group-answer") - 1);
    mocks.teams = [team({ chat: chat(4, 0) })];
    render();
    expect(newLine()).not.toBeNull();
  });

  it("shows no New line when everything is read", () => {
    mocks.teams = [team({ chat: chat(4, 0) })];
    render();
    expect(newLine()).toBeNull();
  });

  it("opens on the New line only when several rows lie below it, else at the end", () => {
    const list = () => container.querySelector('[data-testid="list"]')!;
    mocks.teams = [team({ chat: chat(0, 3) })];
    render();
    // The line is near the end, so the list stays there.
    expect([list().getAttribute("data-initial-index"), list().getAttribute("data-at-end")]).toEqual(
      [null, "true"],
    );
    remount();
    mocks.live = snapshot([
      message("m1", 1),
      ...[2, 3, 4, 5, 6].map((seq) =>
        message(`x${seq}`, seq, { author: "user", assistantId: null }),
      ),
    ]);
    render();
    expect([list().getAttribute("data-initial-index"), list().getAttribute("data-at-end")]).toEqual(
      ["0", "false"],
    );
  });

  it("marks the chat read once the newest message has been in view, not while scrolled up", async () => {
    vi.useFakeTimers();
    mocks.teams = [team({ chat: chat(2, 2) })];
    render();
    await click("scroll up");
    vi.advanceTimersByTime(1000);
    expect(mocks.markRead).not.toHaveBeenCalled();
    await click("scroll down");
    vi.advanceTimersByTime(1000);
    expect(mocks.markRead).toHaveBeenCalledOnce();
    expect(mocks.markRead).toHaveBeenCalledWith("g1", { readSeq: 4 });
    vi.useRealTimers();
  });

  it("marks nothing read in the background, without permission, when already read, or while opened at the New line", async () => {
    vi.useFakeTimers();
    const unread = { teams: [team({ chat: chat(2, 2) })], canMarkRead: true, appState: "active" };
    for (const change of [
      { appState: "background" },
      { canMarkRead: false },
      { teams: [team({ chat: chat(4, 0) })] },
    ]) {
      Object.assign(mocks, unread, change);
      render();
      vi.advanceTimersByTime(1000);
      remount();
    }
    expect(mocks.markRead).not.toHaveBeenCalled();
    // Opened at the New line, far from the end: nothing is read until the user scrolls down.
    mocks.live = snapshot([
      message("m1", 1),
      ...[2, 3, 4, 5, 6].map((seq) =>
        message(`x${seq}`, seq, { author: "user", assistantId: null }),
      ),
    ]);
    mocks.teams = [team({ chat: chat(0, 1) })];
    mocks.canMarkRead = true;
    mocks.appState = "active";
    render();
    vi.advanceTimersByTime(1000);
    expect(mocks.markRead).not.toHaveBeenCalled();
    await click("scroll down");
    vi.advanceTimersByTime(1000);
    expect(mocks.markRead).toHaveBeenCalledWith("g1", { readSeq: 6 });
    // A server that sends no counters is left alone.
    remount();
    mocks.markRead.mockClear();
    mocks.teams = [team()];
    render();
    vi.advanceTimersByTime(1000);
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(newLine()).toBeNull();
    vi.useRealTimers();
  });

  it("marks a read group unread and an unread one read from the header menu", async () => {
    mocks.teams = [team({ chat: chat(4, 0) })];
    render();
    await click("header:Mark as unread");
    expect(mocks.markUnread).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
    mocks.teams = [team({ chat: chat(2, 2) })];
    render();
    await click("header:Mark as read");
    expect(mocks.markReadFlow).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
  });
});

describe("group attachments", () => {
  const draft = (name: string, type: "image" | "file" = "file") => ({
    id: `draft-${name}`,
    type,
    name,
    mimeType: type === "image" ? "image/png" : "application/pdf",
    sizeBytes: 2048,
  });
  const uploaded = (name: string, type: "image" | "file" = "file") => ({
    status: "ready",
    attachments: [
      {
        type,
        id: `pending-${name}`,
        name,
        mimeType: type === "image" ? "image/png" : "application/pdf",
        sizeBytes: 2048,
        dataUrl: "data:ignored",
      },
    ],
  });
  const chips = () => container.querySelectorAll('[data-testid="group-attachment-chip"]');

  it("attaches from the picker, keeps the others when one upload fails, and sends what is ready", async () => {
    mocks.pick.mockResolvedValue({
      files: [draft("shot.png", "image"), draft("sheet.pdf"), draft("broken.pdf")],
      error: null,
    });
    mocks.prepare.mockImplementation(async (input: { attachments: Array<{ name: string }> }) => {
      const { name } = input.attachments[0]!;
      if (name === "broken.pdf") throw new Error("Upload rejected (413)");
      return uploaded(name, name.endsWith(".png") ? "image" : "file");
    });
    render();
    await click("Add attachment:Choose Files");
    expect(chips()).toHaveLength(3);
    expect(text()).toContain("Upload rejected (413)");

    // The failed file holds the send until it is retried or removed; the others stay.
    await type("@ada see these");
    expect(byLabel("Send")!.disabled).toBe(true);
    await click("Remove broken.pdf");
    expect(chips()).toHaveLength(2);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(byLabel("Send")!.disabled).toBe(false);

    await click("Send");
    expect(mocks.post).toHaveBeenCalledWith({
      teamId: "g1",
      text: "@ada see these",
      attachments: [
        {
          type: "image",
          id: "pending-shot.png",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 2048,
        },
        {
          type: "file",
          id: "pending-sheet.pdf",
          name: "sheet.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
        },
      ],
    });
    expect(chips()).toHaveLength(0);
    expect(mocks.release).toHaveBeenCalledWith("hub", ["pending-shot.png", "pending-sheet.pdf"]);
  });

  it("removes an uploaded file's pending upload, and retries a failed one from its chip", async () => {
    mocks.pick.mockResolvedValue({ files: [draft("a.pdf"), draft("b.pdf")], error: null });
    let attempts = 0;
    mocks.prepare.mockImplementation(async (input: { attachments: Array<{ name: string }> }) => {
      const { name } = input.attachments[0]!;
      if (name === "b.pdf" && (attempts += 1) === 1) return { status: "abandoned" };
      return uploaded(name);
    });
    render();
    await click("Add attachment:Choose Files");
    expect(text()).toContain("Upload failed for 'b.pdf'.");
    await click("Retry b.pdf");
    expect(text()).not.toContain("Upload failed");
    await click("Remove a.pdf");
    expect(mocks.release).toHaveBeenCalledWith("hub", ["pending-a.pdf"]);
    expect(chips()).toHaveLength(1);
  });

  it("tells the user what the picker could not take, and when it fails outright", async () => {
    mocks.pick.mockResolvedValueOnce({
      files: [],
      error: "You can attach up to 100 files per message.",
    });
    render();
    await click("Add attachment:Choose Files");
    expect(mocks.alert).toHaveBeenCalledWith(
      "Could not attach",
      "You can attach up to 100 files per message.",
    );
    mocks.pick.mockRejectedValueOnce(new Error("Picker unavailable"));
    await click("Add attachment:Choose Files");
    expect(mocks.alert).toHaveBeenLastCalledWith("Could not attach", "Picker unavailable");
  });

  it("shows a message's files and opens one in the file preview", async () => {
    mocks.live = snapshot([
      message("m1", 1, {
        author: "user",
        assistantId: null,
        text: "@ada look",
        attachments: [
          { type: "image", id: "g-1", name: "shot.png", mimeType: "image/png", sizeBytes: 2048 },
          {
            type: "file",
            id: "g-2",
            name: "sheet.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4096,
          },
          { type: "file", id: "g-3", name: "notes.txt", mimeType: "text/plain", sizeBytes: 10 },
        ],
      }),
    ]);
    render();
    expect(
      container.querySelectorAll('[data-testid="group-message-attachments"] button'),
    ).toHaveLength(3);
    expect(text()).toContain("sheet.pdf");
    await click("Open shot.png");
    expect(container.querySelector('[data-testid="preview"]')!.textContent).toBe("image:shot.png");
    await click("Open sheet.pdf");
    expect(container.querySelector('[data-testid="preview"]')!.textContent).toBe("pdf:sheet.pdf");
    await click("Open notes.txt");
    expect(container.querySelector('[data-testid="preview"]')!.textContent).toBe(
      "document:notes.txt",
    );
  });
});

describe("requests", () => {
  const user = { author: "user", assistantId: null };
  const REQUESTS = [
    message("r1", 1, {
      ...user,
      text: "@ada fix the build",
      requestId: "r1",
      projectId: "p1",
      title: "Fix build",
    }),
    message("r1n", 2, {
      kind: "routing",
      text: "Jarvis assigned Ada",
      replyToMessageId: "r1",
      requestId: "r1",
    }),
    message("a1", 3, { text: "Fixed", taskId: "t1", requestId: "r1" }),
    message("r2", 4, { ...user, text: "ship it", requestId: "r2" }),
    message("n2", 5, {
      kind: "notice",
      assistantId: "jarvis",
      text: "Which project?",
      asksProject: true,
      replyToMessageId: "r2",
      requestId: "r2",
    }),
    message("r3", 6, {
      ...user,
      text: "@beto review",
      requestId: "r3",
      projectId: "p2",
      title: "Review",
    }),
  ];
  const TASKS = [
    task("t1", "completed", "ada", { requestMessageId: "r1", requestId: "r1" }),
    task("t2", "running", "beto", { requestMessageId: "r3", requestId: "r3" }),
  ];
  const read = { latestSeq: 6, readSeq: 6, unreadCount: 0, working: false, preview: null };
  const all = (id: string) =>
    [...container.querySelectorAll(`[data-testid="${id}"]`)].map((node) => node.textContent);
  const setup = (extra: object = {}) => {
    mocks.live = snapshot(REQUESTS, TASKS);
    mocks.teams = [team({ chat: read, ...extra })];
    render();
  };

  it("quotes the request being answered and opens its folded block to show it", async () => {
    setup();
    await click("Reply to request Review");
    expect(container.querySelector('[data-testid="group-reply-chip"]')?.textContent).toBe(
      "Replying to Review",
    );
    expect(text()).toContain("@beto review");
    await click("Request Review");
    expect(text()).not.toContain("(t3-mention:mention/beto) review");
    await click("Show the message from Review");
    expect(text()).toContain("[@beto](t3-mention:mention/beto) review");
    expect(mocks.scrollToIndex).toHaveBeenCalledOnce();
    await click("Cancel reply");
    expect(container.querySelector('[data-testid="group-reply-chip"]')).toBeNull();
  });

  it("links member and project mentions for the markdown view to draw as their chips", () => {
    mocks.live = snapshot([message("m1", 1, { ...user, text: "@ada ship #alpha" })]);
    render();
    // Each link names its member or project, so the chip can show that one's name.
    expect(text()).toContain(
      "[@ada](t3-mention:mention/ada) ship [#alpha](t3-mention:project/alpha)",
    );
  });

  const FOLDED_FIX = "Fix build, Finished · Alpha. Open request";

  it("draws each request with its title, project and status, the latest one last", () => {
    setup();
    // The finished request is folded to the thread's one activity line: title, status, project.
    expect(all("group-request-line")).toHaveLength(1);
    expect(byLabel(FOLDED_FIX)).not.toBeNull();
    expect(all("group-request-title")).toEqual(["ship it", "Review"]);
    expect(all("group-request-project")).toEqual(["Beta"]);
    expect(all("group-request-status")).toEqual(["Needs project", "Working"]);
  });

  it("folds a finished request, and the user's toggle opens and folds it again", async () => {
    setup();
    expect(text()).not.toContain("Fixed");
    expect(text()).toContain("[@beto](t3-mention:mention/beto) review");
    await click(FOLDED_FIX);
    expect(all("group-request-line")).toHaveLength(0);
    expect(text()).toContain("Fixed");
    await click("Request Fix build");
    expect(text()).not.toContain("Fixed");
    await click("Request Review");
    expect(text()).not.toContain("@beto review");
  });

  it("keeps a finished request open while it holds unread messages", () => {
    setup({ chat: { ...read, readSeq: 1, unreadCount: 2 } });
    expect(text()).toContain("Fixed");
  });

  const SCOPES = [
    { projectId: "p1", unreadCount: 0, waiting: false, readSeq: 6 },
    { projectId: "p2", unreadCount: 2, waiting: true, readSeq: 4 },
    { projectId: null, unreadCount: 1, waiting: false, readSeq: 5 },
  ];
  const TAB = {
    all: "All, 3 unread, Waiting on you",
    alpha: "Alpha",
    beta: "Beta, 2 unread, Waiting on you",
    general: "General, 1 unread",
  };
  const tabbed = (saved?: string, live = snapshot(REQUESTS, TASKS)) => {
    if (saved !== undefined) mocks.preferences = { assistantGroupTabs: { "hub:g1": saved } };
    mocks.live = live;
    mocks.teams = [team({ chat: { ...read, unreadCount: 3, scopes: SCOPES } })];
    render();
  };
  const selected = (label: string) => byLabel(label)?.getAttribute("aria-selected");
  const subscribed = () => mocks.subscribe.mock.lastCall;
  const remount = () => {
    act(() => root.unmount());
    root = createRoot(container);
  };

  it("shows no tab row and no project filter from a server without scopes", () => {
    setup();
    expect(container.querySelector('[data-testid="group-tabs"]')).toBeNull();
    expect(byLabel("header:All projects")).toBeNull();
    expect(byLabel("header:Beta")).toBeNull();
    expect(subscribed()).toEqual(["hub", "g1", undefined]);
  });

  it("draws no feed and marks nothing read while a member of a tabbed group has not loaded", async () => {
    vi.useFakeTimers();
    mocks.teams = [
      team({ memberIds: ["ghost"], chat: { ...read, unreadCount: 3, scopes: SCOPES } }),
    ];
    render();
    expect(container.querySelector('[data-testid="list"]')).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(mocks.markRead).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("names each tab with its unread count and a waiting dot, and opens on All without a saved tab", () => {
    tabbed("project:gone");
    const row = container.querySelector('[data-testid="group-tabs"]')!;
    // Announced like web's row: a group of toggle buttons, the open one selected.
    expect([row.getAttribute("data-role"), row.getAttribute("data-label")]).toEqual([
      "group",
      "Project tabs",
    ]);
    expect(
      [...row.querySelectorAll("button")].map((tab) => tab.getAttribute("aria-label")),
    ).toEqual(Object.values(TAB));
    expect(row.querySelectorAll('[data-testid="chip-attention"]')).toHaveLength(2);
    expect(selected(TAB.all)).toBe("true");
    expect(byLabel("header:All projects")).toBeNull();
  });

  // The build inlines Platform.OS; run with T3_MOBILE_TEST_PLATFORM=android for the in-flow row.
  it("pins the row under the iOS bar and grows the list's inset by its height; Android keeps it in flow", () => {
    const android = process.env.T3_MOBILE_TEST_PLATFORM === "android";
    tabbed();
    const list = container.querySelector('[data-testid="list"]')!;
    expect(list.getAttribute("data-inset-top")).toBe(android ? null : "44");
    expect(container.querySelector('[data-testid="group-tabs-glass"]') === null).toBe(android);
    // In flow on Android it sits above the list; pinned on iOS it draws over it, after it.
    const row = container.querySelector('[data-testid="group-tabs"]')!;
    expect(Boolean(row.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      android,
    );
  });

  it("switches tabs keeping the draft, sets the composer's project, and reopens on the saved tab", async () => {
    tabbed();
    await type("@beto again");
    await click(TAB.beta);
    expect(input().value).toBe("@beto again");
    expect(byLabel("Project: Beta")).not.toBeNull();
    expect(mocks.preferences).toEqual({ assistantGroupTabs: { "hub:g1": "project:p2" } });
    expect(subscribed()).toEqual(["hub", "g1", { projectId: "p2" }]);
    await click(TAB.general);
    expect(byLabel("Project: Lead decides")).not.toBeNull();
    // The open tab stays put: nothing is saved again.
    await click(TAB.general);
    expect(mocks.savePreferences).toHaveBeenCalledTimes(2);
    remount();
    render();
    expect(selected(TAB.general)).toBe("true");
    expect(subscribed()).toEqual(["hub", "g1", { projectId: null }]);
  });

  it("keeps the draft when a tab switch closes an open reply", async () => {
    tabbed("project:p2");
    await type("still here");
    await click("Reply to request Review");
    expect(text()).toContain("Replying to Review");
    await click(TAB.alpha);
    expect(container.querySelector('[data-testid="group-reply-chip"]')).toBeNull();
    expect(input().value).toBe("still here");
  });

  it("says how many tasks run in the whole group, even in a tab whose stream holds none", () => {
    mocks.preferences = { assistantGroupTabs: { "hub:g1": "project:p1" } };
    mocks.live = snapshot(REQUESTS.slice(0, 3), TASKS.slice(0, 1));
    mocks.teams = [team({ chat: { ...read, unreadCount: 3, scopes: SCOPES, runningCount: 2 } })];
    render();
    expect(container.querySelector("header p")?.textContent).toContain("2 running");
  });

  it("in a project tab shows only its requests, and pages and marks read in its scope", async () => {
    vi.useFakeTimers();
    mocks.olderThan.mockResolvedValue({
      ok: true,
      value: { messages: [], tasks: [], hasMore: false },
    });
    tabbed("project:p2", snapshot(REQUESTS, TASKS, true));
    expect(all("group-request-title")).toEqual(["Review"]);
    expect(text()).not.toContain("ship it");
    await click("start reached");
    expect(mocks.olderThan).toHaveBeenCalledWith("g1", expect.anything(), { projectId: "p2" });
    await click("scroll down");
    vi.advanceTimersByTime(1000);
    expect(mocks.markRead).toHaveBeenCalledWith("g1", { readSeq: 6, scope: { projectId: "p2" } });
    vi.useRealTimers();
  });

  it("in All folds every request to one line with its project, opens one in place, and marks nothing read", async () => {
    vi.useFakeTimers();
    tabbed(
      undefined,
      snapshot(
        [
          ...REQUESTS,
          message("r4", 7, {
            ...user,
            text: "old work",
            requestId: "r4",
            projectId: "p9",
            title: "Old",
          }),
        ],
        TASKS,
      ),
    );
    expect(all("group-request-title")).toEqual([]);
    const lines = () =>
      [...container.querySelectorAll('[data-testid="group-request-line"] button')].map((line) =>
        line.getAttribute("aria-label"),
      );
    expect(lines()).toEqual([
      "Fix build, Finished, Alpha. Expand request",
      "ship it, Needs project. Expand request",
      "Review, Working, Beta. Expand request",
      "Old, Routing, Removed project. Expand request",
    ]);
    await click("Review, Working, Beta. Expand request");
    expect(text()).toContain("[@beto](t3-mention:mention/beto) review");
    await click("Review, Working, Beta. Collapse request");
    expect(text()).not.toContain("(t3-mention:mention/beto) review");
    await click("scroll down");
    vi.advanceTimersByTime(1000);
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(subscribed()).toEqual(["hub", "g1", undefined]);
    vi.useRealTimers();
  });

  it("follows a new request to the tab that holds it, and stays in All", async () => {
    tabbed("project:p1");
    expect(byLabel("Project: Alpha")).not.toBeNull();
    await click("Project:Beta");
    await type("@beto ship");
    await click("Send");
    expect(mocks.post).toHaveBeenLastCalledWith({
      teamId: "g1",
      text: "@beto ship",
      projectId: "p2",
    });
    expect(selected(TAB.beta)).toBe("true");
    await click("Project:Lead decides");
    await type("anyone");
    await click("Send");
    expect(selected(TAB.general)).toBe("true");
    await click(TAB.all);
    await click("Project:Alpha");
    await type("@ada go");
    await click("Send");
    expect(selected(TAB.all)).toBe("true");
  });

  it("sends the picked project on a new request and lets the lead decide by default", async () => {
    setup();
    await type("@ada one");
    await click("Send");
    expect(mocks.post).toHaveBeenLastCalledWith({ teamId: "g1", text: "@ada one" });
    await click("Project:Alpha");
    expect(byLabel("Project:Alpha")?.getAttribute("data-state")).toBe("on");
    await type("@ada two");
    await click("Send");
    expect(mocks.post).toHaveBeenLastCalledWith({
      teamId: "g1",
      text: "@ada two",
      projectId: "p1",
    });
    // The pick is for one message.
    expect(byLabel("Project: Lead decides")).not.toBeNull();
  });

  it("shows the picked project's model beside it and opens that project's picker", async () => {
    setup();
    // The lead decides the project, so there is no project model to show.
    expect(container.querySelector('[aria-label^="Model for"]')).toBeNull();
    expect(text()).not.toContain("Model in");
    await click("Project:Alpha");
    await click("Model for Alpha: name:gpt-5.5");
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsProjectModel", {
      members: [{ environmentId: "hub", projectId: "p1" }],
    });
    mocks.canWriteSettings = false;
    render();
    expect(byLabel("Model for Alpha: name:gpt-5.5")?.disabled).toBe(true);
  });

  it("shows the group's default, else the members' own models, for a project without its own", async () => {
    setup();
    await click("Project:Beta");
    expect(byLabel("Model for Beta: Members' models")).not.toBeNull();
    setup({ defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" } });
    expect(byLabel("Model for Beta: name:gpt-5.4")).not.toBeNull();
    // A provider the project turned off is skipped, as the server does when the request starts.
    mocks.codexOffInBeta = true;
    render();
    expect(byLabel("Model for Beta: Members' models")).not.toBeNull();
  });

  it("sets a member's own model in the picked project from the header menu, and removes it", async () => {
    mocks.exceptions = { ada: { instanceId: "codex", model: "gpt-5.4" } };
    setup();
    await click("Project:Alpha");
    const submenus = () =>
      [...container.querySelectorAll('[data-testid="header-submenu"]')].map(
        (node) => node.textContent,
      );
    expect(submenus()).toEqual(["Model in Alpha", "Ada · name:gpt-5.4"]);
    await click("header:Beto");
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsProjectModel", {
      members: [{ environmentId: "hub", projectId: "p1" }],
      assistantId: "beto",
    });
    await click("header:Change model");
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsProjectModel", {
      members: [{ environmentId: "hub", projectId: "p1" }],
      assistantId: "ada",
    });
    await click("header:Remove exception");
    expect(mocks.writeSettings).toHaveBeenCalledWith(expect.any(Array), [
      {
        environmentId: "hub",
        patch: {
          projectSettingsOverrides: {
            p1: expect.objectContaining({ assistantModelSelections: { ada: null } }),
          },
        },
      },
    ]);
  });

  it("replies to a request in its project, locked, and lets one without a project pick", async () => {
    setup();
    await click("Reply to request Review");
    expect(text()).toContain("Replying to Review");
    await type("more");
    // A reply to the request itself goes where the request routes, not to a member named "Review".
    expect(recipients()).toBe("Jarvis (lead) will route it");
    expect(byLabel("Project: Beta")?.disabled).toBe(true);
    expect(byLabel("Project:Alpha")).toBeNull();
    await type("@beto more");
    await click("Send");
    expect(mocks.post).toHaveBeenLastCalledWith({
      teamId: "g1",
      text: "@beto more",
      replyToMessageId: "r3",
    });
    await click("Reply to request ship it");
    await click("Project:Beta");
    await type("go");
    await click("Send");
    expect(mocks.post).toHaveBeenLastCalledWith({
      teamId: "g1",
      text: "go",
      replyToMessageId: "r2",
      projectId: "p2",
    });
  });

  it("a reply to a member's answer keeps its request's project", async () => {
    setup({ chat: { ...read, readSeq: 0 } });
    await click("Reply to Ada");
    expect(byLabel("Project: Alpha")?.disabled).toBe(true);
  });

  it("answers the lead's project question from the request's chips", async () => {
    setup();
    await click("Use project Beta");
    expect(mocks.post).toHaveBeenCalledWith({
      teamId: "g1",
      text: "Beta",
      replyToMessageId: "r2",
      projectId: "p2",
    });
    mocks.post.mockResolvedValue({ ok: false, message: "no", reason: null });
    await click("Use project Alpha");
    expect(mocks.alert).toHaveBeenCalledWith("Could not set the project", "no");
    mocks.canPost = false;
    render();
    expect(byLabel("Use project Alpha")?.disabled).toBe(true);
  });

  it("inserts a mention at the caret from the Mention menu", async () => {
    render();
    await type("hi");
    await click("Mention:Ada");
    expect(input().value).toBe("hi @ada ");
    await click("Mention:Everyone");
    expect(input().value).toBe("hi @ada @everyone ");
  });

  it("starts dictation from the composer", async () => {
    render();
    await click("Start dictation");
    expect(mocks.voiceStart).toHaveBeenCalledOnce();
    expect(byLabel("Mention a member")).not.toBeNull();
    const voice = mocks.voiceInput!;
    expect(voice.ownerKey).toBe("assistant-group:hub:g1");
    const changed = vi.fn();
    const unsubscribe = voice.subscribeToDraftChanges(changed);
    await type("typed");
    expect(voice.readDraftMessage()).toBe("typed");
    expect(changed).toHaveBeenCalled();
    unsubscribe();
    await act(async () => {
      mocks.voiceInput!.onChangeDraftMessage("typed spoken");
      mocks.voiceInput!.onChangeSelection({ start: 12, end: 12 });
    });
    expect(input().value).toBe("typed spoken");
    // While it records, the dictation bar takes the toolbar row's place.
    mocks.voicePhase = "recording";
    render();
    expect(container.querySelector('[data-testid="dictation-toolbar"]')).not.toBeNull();
    expect(byLabel("Start dictation")).toBeNull();
    expect(byLabel("Mention a member")).toBeNull();
  });
});

describe("waiting notices", () => {
  const waitingNotice = (waiting: object) =>
    snapshot([
      message("r1", 1, {
        author: "user",
        assistantId: null,
        text: "@ada deploy",
        requestId: "r1",
      }),
      message("w1", 2, {
        kind: "notice",
        assistantId: "ada",
        text: "Ada needs your approval to run the deploy.\n\nIt pushes to prod.\n\nOptions: Approve · Deny",
        requestId: "r1",
        waiting,
      }),
    ]);

  it("names the member, opens the conversation and the decision it waits on", async () => {
    mocks.decisions = [{ environmentId: "hub", decision: { id: "d1", title: "Deploy to prod?" } }];
    mocks.live = waitingNotice({
      threadId: "assistant:ada:g-1",
      decisionId: "d1",
      resolved: false,
    });
    render();
    const notice = container.querySelector('[data-testid="group-waiting"]')!;
    expect(notice.textContent).toContain("Ada is waiting on you");
    // The server's notice text is the question, its context, then "Options: a · b".
    expect(notice.textContent).toContain("Ada needs your approval to run the deploy.");
    expect(notice.textContent).toContain("It pushes to prod.");
    expect(notice.textContent).not.toContain("Options:");
    expect(
      [...container.querySelectorAll('[data-testid="group-waiting-options"] > div')].map(
        (node) => node.textContent,
      ),
    ).toEqual(["Approve", "Deny"]);
    await click("Open conversation");
    expect(mocks.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "assistant:ada:g-1" },
    });
    await click("Open decision");
    expect(container.querySelector('[data-testid="decision-card"]')?.textContent).toBe(
      "Deploy to prod?",
    );
  });

  it("offers no decision it cannot find", () => {
    mocks.live = waitingNotice({
      threadId: "assistant:ada:g-1",
      decisionId: "d9",
      resolved: false,
    });
    render();
    expect(byLabel("Open conversation")).not.toBeNull();
    expect(byLabel("Open decision")).toBeNull();
  });

  it("shows a resolved one muted, with no action", () => {
    mocks.live = waitingNotice({ threadId: "assistant:ada:g-1", resolved: true });
    render();
    expect(container.querySelector('[data-testid="group-waiting-resolved"]')?.textContent).toBe(
      "Resolved",
    );
    expect(byLabel("Open conversation")).toBeNull();
  });
});

describe("conversation actions in the header", () => {
  it("starts a new conversation, compacts, and clears after confirming", async () => {
    render();
    await click("header:New conversation");
    expect(mocks.converse).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }), "new");
    await click("header:Compact context");
    expect(mocks.converse).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "g1" }),
      "compact",
    );
    await click("Reply to Ada");
    await click("header:Clear history");
    expect(mocks.dismissKeyboard).toHaveBeenCalled();
    expect(mocks.clear).toHaveBeenCalledWith(
      expect.objectContaining({ id: "g1" }),
      expect.any(Function),
    );
    await act(async () => mocks.clear.mock.calls[0]![1]());
    expect(container.querySelector('[data-testid="group-reply-chip"]')).toBeNull();
  });

  it("are off while the group is working", () => {
    mocks.teams = [
      team({ chat: { latestSeq: 4, readSeq: 4, unreadCount: 0, working: true, preview: null } }),
    ];
    render();
    for (const title of ["New conversation", "Compact context", "Clear history"]) {
      expect(byLabel(`header:${title}`)?.disabled).toBe(true);
      expect(byLabel(`header:${title}`)?.dataset.subtitle).toBe("Stop its tasks first");
    }
  });

  it("say nothing extra while the group is idle", () => {
    render();
    expect(byLabel("header:New conversation")?.dataset.subtitle).toBeUndefined();
  });
});

describe("the thread's pieces in the feed", () => {
  const ANSWERS = [
    message("r1", 1, {
      author: "user",
      assistantId: null,
      text: "@ada go",
      projectId: "p1",
      requestId: "r1",
    }),
    message("a1", 2, { text: "Done in [app](src/app.ts)", taskId: "t1", requestId: "r1" }),
    message("r2", 3, {
      author: "user",
      assistantId: null,
      text: "@beto go",
      projectId: "p2",
      requestId: "r2",
    }),
    message("a2", 4, { assistantId: "beto", text: "Also done", taskId: "t2", requestId: "r2" }),
  ];
  const tasks = (first: string, second: string) => [
    task("t1", first, "ada", {
      requestMessageId: "r1",
      instruction: "Scheduled request Nightly:\nBuild the app",
    }),
    task("t2", second, "beto", { requestMessageId: "r2" }),
  ];
  const cards = () => container.querySelectorAll('[data-testid="group-task-card"]').length;
  const clickText = (start: string) =>
    act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.startsWith(start))
        ?.click(),
    );

  it("uses onBackToList and no bottom border, so a split view draws no back arrow", async () => {
    render();
    const header = container.querySelector("header")!;
    expect(header.dataset.back).toBe("none");
    expect(header.dataset.border).toBe("hidden");
    await click("header:back to list");
    expect(mocks.goBack).toHaveBeenCalledOnce();
  });

  it("folds a long answer behind Show more and opens it", async () => {
    mocks.live = snapshot([message("m1", 1, { text: "line\n".repeat(20) })]);
    render();
    expect(text()).toContain("Show more");
    await clickText("Show more");
    expect(text()).toContain("Show less");
  });

  it("puts a Worked fold under the author with the task's instruction, without its routing line", async () => {
    mocks.live = snapshot(ANSWERS, tasks("running", "running"));
    render();
    expect(container.querySelector('[data-testid="group-worked-instruction"]')).toBeNull();
    await clickText("Worked");
    expect(container.querySelector('[data-testid="group-worked-instruction"]')?.textContent).toBe(
      "Build the app",
    );
  });

  it("shows a completed or cancelled task as one activity line and keeps the card while it runs", async () => {
    mocks.live = snapshot(ANSWERS, tasks("completed", "cancelled"));
    mocks.shells = new Map([["assistant:ada:g-0123456789abcdef", "Build the app thread"]]);
    render();
    expect(cards()).toBe(0);
    // The member thread's title when the store has it, else the instruction's gist.
    expect(byLabel("Build the app thread, Finished. Open task")).not.toBeNull();
    expect(byLabel("do t2, Cancelled. Open task")).not.toBeNull();
    await click("do t2, Cancelled. Open task");
    expect(mocks.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "assistant:beto:g-0123456789abcdef" },
    });
    act(() => root.unmount());
    root = createRoot(container);
    mocks.live = snapshot(ANSWERS, tasks("running", "completed"));
    render();
    expect(cards()).toBe(1);
    expect(byLabel("do t2, Finished. Open task")).not.toBeNull();
  });

  it("draws no message's markdown again when a preview opens or the list scrolls", async () => {
    const shot = {
      type: "image",
      id: "g-1",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 1,
    };
    mocks.live = snapshot(
      [{ ...ANSWERS[0]!, attachments: [shot] } as never, ...ANSWERS.slice(1)],
      tasks("running", "running"),
    );
    render();
    const drawn = mocks.markdownRender.mock.calls.length;
    expect(drawn).toBeGreaterThan(0);
    await click("Open shot.png");
    expect(container.querySelector('[data-testid="preview"]')!.textContent).toBe("image:shot.png");
    await click("scroll up");
    expect(mocks.markdownRender).toHaveBeenCalledTimes(drawn);
  });

  it("opens each answer's links with its own task thread and its worktree or project root, under one preview host", async () => {
    mocks.live = snapshot(ANSWERS, tasks("running", "running"));
    mocks.worktrees = new Map([["assistant:beto:g-0123456789abcdef", "/worktrees/beto"]]);
    // Ada's thread lives in another project than the request's (Alpha).
    mocks.threadProjects = new Map([["assistant:ada:g-0123456789abcdef", "p2"]]);
    render();
    await click("link in Done in [app](src/app.ts)");
    await click("link in Also done");
    // Mentions are highlights only; everything else reaches the host with the answer's context.
    expect(mocks.openedLink.mock.calls).toEqual([
      ["src/app.ts", { threadId: "assistant:ada:g-0123456789abcdef", workspaceRoot: "/repo/beta" }],
      [
        "src/app.ts",
        { threadId: "assistant:beto:g-0123456789abcdef", workspaceRoot: "/worktrees/beto" },
      ],
    ]);
    await click("link in [@ada](t3-mention:mention/ada) go");
    expect(mocks.openedLink).toHaveBeenLastCalledWith("src/app.ts", {
      threadId: null,
      workspaceRoot: "/repo/alpha",
    });
    expect(container.querySelectorAll('[data-testid="preview"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="video-preview"]')).toHaveLength(1);
  });
});
