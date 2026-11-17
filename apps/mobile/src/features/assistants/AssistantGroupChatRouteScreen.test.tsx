import { applyAssistantGroupsEvent } from "@t3tools/client-runtime/assistantGroupChat";
import { ASSISTANT_GROUP_MESSAGE_MAX_CHARS, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { act, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Item = { message: { id: string } };

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    /** What `useGroupDraftSkills` resolves for the draft. */
    skills: [] as unknown[],
    modelPick: null as unknown,
    pickListeners: new Set<() => void>(),
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
    /** Each post's `clientRequestId`, apart, so the posts' own expectations stay as they are. */
    requestIds: [] as unknown[],
    uuids: 0,
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
    editor: null as null | { onSubmit?: (alternate: boolean) => void; skills?: unknown },
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
    /** null while the device's preferences are still being read. */
    preferences: {} as { assistantGroupTabs?: Record<string, string> } | null,
    preferenceListeners: new Set<() => void>(),
    savePreferences: vi.fn(),
    navigate: vi.fn(),
    setParams: vi.fn(),
    /** The tab on screen, as the push presentation learns it. */
    showTab: vi.fn(() => () => {}),
    /** The tab a push's link put in the route. */
    routeTab: undefined as string | undefined,
    routeRequest: undefined as string | undefined,
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
vi.mock("../../lib/uuid", () => ({ uuidv4: () => `req-${++mocks.uuids}` }));
vi.mock("../../lib/composerImages", () => ({
  pickComposerFiles: (...args: unknown[]) => mocks.pick(...args),
  pickComposerMedia: (...args: unknown[]) => mocks.pickMedia(...args),
  convertPastedImagesToAttachments: async () => [],
  isFileBackedComposerAttachment: (attachment: { fileUri?: string }) =>
    attachment.fileUri !== undefined,
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
    busy?: boolean;
    onPress: () => void;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-busy={props.busy}
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
vi.mock("../threads/ComposerCommandPopover", () => ({
  ComposerPopoverSurface: Children,
  ComposerCommandPopover: (props: {
    items: ReadonlyArray<{ id: string; label: string }>;
    triggerKind: string;
    onSelect: (item: unknown) => void;
  }) => (
    <div data-testid="skill-menu" data-kind={props.triggerKind}>
      {props.items.map((item) => (
        <button
          key={item.id}
          aria-label={`Use ${item.label}`}
          onClick={() => props.onSelect(item)}
        />
      ))}
    </div>
  ),
}));
vi.mock("./useGroupDraftSkills", () => ({ useGroupDraftSkills: () => mocks.skills }));
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
  VideoPreviewModal: (props: { source: { sourceIdentifier: string } | null }) => (
    <div data-testid="video-preview">{props.source?.sourceIdentifier}</div>
  ),
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
vi.mock("../threads/floating-working-control", () => ({
  FloatingScrollToEndButton: (props: { onPress: () => void }) => (
    <button aria-label="Scroll to end" onClick={props.onPress} />
  ),
}));
vi.mock("../threads/ThreadFeed", () => {
  const styles = { user: { nativeTextStyle: {} }, assistant: { nativeTextStyle: {} } };
  type Sent = { id: string; name: string; type: string; mimeType: string };
  // The thread's own pieces: each file opens as the preview of its kind.
  const files =
    (testID: string) =>
    (props: {
      attachments: ReadonlyArray<Sent>;
      onPressPreview: (source: { kind: string; name: string }) => void;
    }) => (
      <div data-testid={testID}>
        {props.attachments.map((attachment) => (
          <button
            key={attachment.id}
            aria-label={`Open ${attachment.name}`}
            onClick={() =>
              props.onPressPreview({
                kind:
                  attachment.type === "image"
                    ? "image"
                    : attachment.mimeType === "application/pdf"
                      ? "pdf"
                      : "document",
                name: attachment.name,
              })
            }
          />
        ))}
      </div>
    );
  return {
    useMarkdownStyles: () => styles,
    isMediaAttachment: (attachment: Sent) =>
      attachment.type === "image" || attachment.mimeType.startsWith("video/"),
    UserMessageMedia: files("message-media"),
    MessageAttachmentList: files("message-files"),
  };
});
// The thread's strip, showing the upload state its owner hands it.
vi.mock("../../components/ComposerAttachmentStrip", () => ({
  ComposerAttachmentStrip: (props: {
    attachments: ReadonlyArray<{ id: string; name: string; type: string; mimeType: string }>;
    ownUploads: {
      stateOf: (id: string) => { status: string; progress?: number; reason?: string } | undefined;
      retry: (id: string) => void;
    };
    onRemove: (id: string) => void;
    onPressPreview: (source: { kind: string; name: string }) => void;
    onPressVideo: (attachment: unknown, sourceIdentifier: string) => void;
    onPressDocument: (attachment: unknown) => void;
  }) =>
    props.attachments.map((attachment) => {
      const upload = props.ownUploads.stateOf(attachment.id);
      return (
        <div key={attachment.id} data-testid="group-attachment-chip">
          {upload?.status === "failed"
            ? upload.reason
            : upload?.status === "uploading"
              ? `Uploading ${upload.progress}`
              : "ready"}
          <button
            aria-label={`Open ${attachment.name}`}
            onClick={() =>
              attachment.type === "video"
                ? props.onPressVideo(attachment, `draft:${attachment.id}`)
                : attachment.mimeType === "text/plain"
                  ? props.onPressDocument(attachment)
                  : props.onPressPreview({ kind: attachment.type, name: attachment.name })
            }
          />
          <button
            aria-label={`Retry ${attachment.name}`}
            onClick={() => props.ownUploads.retry(attachment.id)}
          />
          <button
            aria-label={`Remove ${attachment.name}`}
            onClick={() => props.onRemove(attachment.id)}
          />
        </div>
      );
    }),
}));
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
    setParams: mocks.setParams,
  }),
  // The tablet sidebar opens the chat by id, outside any navigator screen.
  useRoute: () => {
    throw new Error("useRoute outside a navigator screen");
  },
  StackActions: { push: (name: string, params: unknown) => ({ name, params }) },
}));
vi.mock("../agent-awareness/notificationNavigation", () => ({
  showAgentNotificationGroupTab: mocks.showTab,
}));
vi.mock("../../components/ui/AppText", () => ({
  // Laid out one line per newline, like text that never wraps.
  AppText: (props: {
    children?: ReactNode;
    testID?: string;
    onTextLayout?: (event: { nativeEvent: { lines: object[] } }) => void;
  }) => (
    <span
      data-testid={props.testID}
      ref={
        props.onTextLayout &&
        ((node) => {
          const lines = (node?.textContent ?? "").split("\n").map(() => ({}));
          if (node) props.onTextLayout?.({ nativeEvent: { lines } });
        })
      }
    >
      {props.children}
    </span>
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
    titlePress?: { accessibilityLabel: string; leading?: ReactNode; onPress: () => void };
    menus?: Array<{ items: Array<MockMenuItem> }>;
  }) => (
    <header
      data-back={props.onBack === undefined ? "none" : "back"}
      data-border={props.hideBottomBorder ? "hidden" : "shown"}
    >
      <button aria-label="header:back to list" onClick={props.onBackToList} />
      {props.titlePress ? (
        <button aria-label={props.titlePress.accessibilityLabel} onClick={props.titlePress.onPress}>
          {props.titlePress.leading}
        </button>
      ) : null}
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
vi.mock("../../state/assistants", async () => {
  const { assistantGroupSendContext } = await import("@t3tools/client-runtime/assistantGroupChat");
  return {
    useAssistantGroupSendContext: (_environmentId: unknown, chat: { readonly reply: never }) =>
      assistantGroupSendContext(mocks.live as never, chat.reply),
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
      post: ({ clientRequestId, ...input }: { readonly clientRequestId?: string }) => {
        mocks.requestIds.push(clientRequestId);
        return mocks.post(input);
      },
      taskAction: mocks.taskAction,
      olderThan: mocks.olderThan,
    }),
  };
});
vi.mock("./GroupContextMeter", () => ({ GroupContextMeter: () => null }));
vi.mock("../threads/use-visible-second-clock", () => ({
  useVisibleSecondClock: () => Date.parse("2026-11-07T10:01:00Z"),
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
  const subscribePick = (listener: () => void) => {
    mocks.pickListeners.add(listener);
    return () => mocks.pickListeners.delete(listener);
  };
  // Stable, as the real setter is.
  const setPick = (next: unknown) => {
    mocks.modelPick = typeof next === "function" ? next(mocks.modelPick) : next;
    for (const listener of mocks.pickListeners) listener();
  };
  return {
    useAtomValue: () =>
      useSyncExternalStore(subscribe, () => {
        if (held !== mocks.preferences) {
          held = mocks.preferences;
          result =
            mocks.preferences === null
              ? AsyncResult.initial()
              : AsyncResult.success(mocks.preferences);
        }
        return result;
      }),
    useAtomSet: () => mocks.savePreferences,
    // Only the composer's model pick, whose picker is another route, is read with useAtom here.
    useAtom: () => [useSyncExternalStore(subscribePick, () => mocks.modelPick), setPick],
  };
});
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: (props: { assistant: { name: string } }) => (
    <i>{`av:${props.assistant.name}`}</i>
  ),
  AssistantCluster: (props: { faces: Array<{ key: string }> }) => (
    <i data-testid="cluster">{props.faces.map((face) => face.key).join(",")}</i>
  ),
  removedAssistantFace: (id: string) => ({ id, name: "Assistant", avatar: null, icon: null }),
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
import { clearGroupOutgoings } from "./GroupComposer";

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
            params: {
              environmentId: "hub",
              teamId: "g1",
              ...(mocks.routeTab === undefined ? {} : { tab: mocks.routeTab }),
              ...(mocks.routeRequest === undefined ? {} : { request: mocks.routeRequest }),
            },
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
  clearGroupOutgoings();
  mocks.modelPick = null;
  Object.assign(mocks, {
    teams: [team()],
    environmentIds: ["hub"],
    canPost: true,
    canAct: true,
    canMarkRead: true,
    appState: "active",
    requestIds: [],
    decisions: [],
    voicePhase: "idle",
    skills: [],
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
    mocks.setParams,
    mocks.writeSettings,
  ])
    fn.mockReset();
  mocks.showTab.mockReset().mockReturnValue(() => {});
  mocks.routeTab = undefined;
  mocks.routeRequest = undefined;
  mocks.preferences = {};
  mocks.preferenceListeners.clear();
  mocks.savePreferences.mockImplementation(
    (update: { transform: (current: typeof mocks.preferences) => object }) => {
      const current = mocks.preferences ?? {};
      mocks.preferences = { ...current, ...update.transform(current) };
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

  it("shows a task's expected result and resources, and why a queued one waits", async () => {
    mocks.live = snapshot(
      [message("m1", 1, { author: "user", assistantId: null, text: "@ada go" })],
      [
        task("t1", "queued", "ada", {
          reason: "waiting for browser (used by Bo)",
          expectedResult: "the build is green",
          resources: ["folder:/w/app", "browser"],
        }),
        task("t22", "running", "bo", { instruction: "step 1\nstep 2\nstep 3\nstep 4" }),
        task("t333", "usage_limited", "beto", {
          resetAt: "2099-01-01T09:30Z",
          expectedResult: "a\nlong\nreport",
        }),
        task("t4444", "usage_limited", "jarvis"),
      ],
    );
    render();
    // Only a request its clamp cuts, in the instruction or the expected result, gets the toggle.
    const toggles = () =>
      Array.from(container.querySelectorAll('[data-testid="group-task-card"]'), (card) =>
        card.querySelector('button[aria-label^="Show"]')?.getAttribute("aria-label"),
      );
    expect(toggles()).toEqual([undefined, "Show more", "Show more", undefined]);
    await act(async () =>
      container.querySelectorAll<HTMLElement>('button[aria-label="Show more"]')[1]!.click(),
    );
    expect(toggles()).toEqual([undefined, "Show more", "Show less", undefined]);
    await click("Show less");
    expect(toggles()).toEqual([undefined, "Show more", "Show more", undefined]);
    expect(
      Array.from(
        container.querySelectorAll('[data-testid="group-task-expected"]'),
        (node) => node.textContent,
      ),
    ).toEqual(["Expected: the build is green", "Expected: a\nlong\nreport"]);
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

  it("links a waiting task's threads, then its subagents, by title", async () => {
    mocks.shells = new Map([
      ["w1", "Build the site"],
      ["s1", "Lint pass"],
    ]);
    mocks.live = snapshot(
      [message("m1", 1, { author: "user", assistantId: null, text: "@ada go" })],
      [task("t1", "waiting", "ada", { reason: "subagents:s1;threads:w1, w2" })],
    );
    render();
    const waiting = container.querySelector('[data-testid="group-task-waiting-threads"]')!;
    expect(waiting.textContent).toContain("Waiting on 2 threads and 1 subagent");
    expect(
      Array.from(
        waiting.querySelectorAll('[data-testid="group-task-waiting-link"]'),
        (node) => node.textContent,
      ),
    ).toEqual(["Build the site", "Untitled thread", "Lint pass"]);
    await click("Open Lint pass");
    expect(mocks.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "s1" },
    });
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
    expect(new Set(mocks.subscribe.mock.calls.map((call) => call[2]))).toEqual(new Set([null]));
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
    // Two projects and none picked: the server hands even a mention to the lead to pick one.
    expect(recipients()).toBe("Jarvis (lead) will pick the project");
    await click("Send");
    expect(mocks.post).toHaveBeenCalledWith({ teamId: "g1", text: "@ada do it" });
    expect(input().value).toBe("");
    expect(mocks.scrollToEnd).toHaveBeenCalledOnce();
  });

  it("offers the recipient's skills after $ or /, inserts one, and leaves @ to members", async () => {
    const deploy = { name: "deploy", displayName: "Deploy", enabled: true, userInvocable: true };
    render();
    await type("$dep");
    // No skills for the recipient: `$` opens nothing.
    expect(container.querySelector('[data-testid="skill-menu"]')).toBeNull();
    mocks.skills = [deploy];
    await type("ship $dep");
    expect(mocks.editor?.skills).toEqual([deploy]);
    await click("Use Deploy");
    expect(input().value).toBe("ship $deploy ");
    await type("/dep");
    await click("Use skill:deploy");
    expect(input().value).toBe("$deploy ");
    await type("@");
    expect(container.querySelector('[data-testid="skill-menu"]')).toBeNull();
    expect(byLabel("Mention Ada")).not.toBeNull();
  });

  it("previews everyone, the lead's routing and the missing mention", async () => {
    render();
    await type("@everyone ship #alpha");
    expect(recipients()).toBe("To everyone");
    await type("hello");
    expect(recipients()).toBe("Jarvis (lead) will pick the project");
    await type("hello #alpha");
    expect(recipients()).toBe("Jarvis (lead) will route it");
    mocks.teams = [team({ leadId: null })];
    render();
    await type("hello again #alpha");
    expect(recipients()).toBe("Waits for a lead");
    // Without a lead nobody can pick the project, so the server refuses it.
    await type("hello again");
    expect(recipients()).toBe("Pick a project first: the group has no lead to choose one");
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

  it("says the send is on its way and takes no second tap or Return until it settles", async () => {
    render();
    await type("@ada go");
    let settle!: (reply: unknown) => void;
    mocks.post.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
    await click("Send");
    const button = byLabel("Sending");
    expect([button?.disabled, button?.getAttribute("aria-busy")]).toEqual([true, "true"]);
    await act(async () => {
      button?.click();
      mocks.editor!.onSubmit!(false);
    });
    expect(mocks.post).toHaveBeenCalledOnce();
    await act(async () => settle({ ok: true, value: {} }));
    expect(byLabel("Send")?.getAttribute("aria-busy")).not.toBe("true");
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

  it("keeps the draft and says why the lead cannot route, as the server words it", async () => {
    mocks.post.mockResolvedValue({
      ok: false,
      message: "Ada can't route.",
      reason: "mention_required",
    });
    render();
    await type("no mention");
    await click("Send");
    expect(text()).toContain("Ada can't route.");
    expect(input().value).toBe("no mention");
    await type("no mention!");
    expect(text()).not.toContain("Ada can't route.");
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
    // A post the chat then shows landed; one the user edited since keeps their text, not the warning.
    const landed = (clientRequestId: unknown) => {
      mocks.live = snapshot([...FEED, message("m9", 9, { author: "user", clientRequestId })]);
      return render();
    };
    await type("hi again");
    mocks.post.mockResolvedValue({ ok: false, message: "unconfirmed", reason: "unconfirmed" });
    await click("Send");
    await type("hi again, edited");
    await landed(mocks.requestIds.at(-1));
    expect([text().includes("unconfirmed"), input().value]).toEqual([false, "hi again, edited"]);
    await type("hi");
    await click("Send");
    expect(text()).toContain("unconfirmed");
    await landed(mocks.requestIds.at(-1));
    expect([text().includes("unconfirmed"), input().value]).toEqual([false, ""]);
    // A landed reply lets go of its quote too, as one whose post answered does.
    await click("Reply to Ada");
    await type("thanks");
    await click("Send");
    await landed(mocks.requestIds.at(-1));
    expect(container.querySelector('[data-testid="group-reply-chip"]')).toBeNull();
    // Edited before its post showed, it keeps the user's text and still lets go of the quote.
    await click("Reply to Ada");
    await type("thanks again");
    await click("Send");
    await type("thanks again!");
    await landed(mocks.requestIds.at(-1));
    expect([container.querySelector('[data-testid="group-reply-chip"]'), input().value]).toEqual([
      null,
      "thanks again!",
    ]);
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

  it("shows who works on what, a request's owners and its task tree, a removed member too", async () => {
    mocks.live = snapshot(
      [message("m1", 1, { author: "user", assistantId: null, text: "@beto go", requestId: "m1" })],
      [
        task("t1", "running", "beto", { requestId: "m1" }),
        task("t22", "completed", "gone", {
          kind: "child",
          parentId: "t1",
          rootId: "t1",
          requestId: "m1",
        }),
      ],
    );
    render();
    const labels = (testId: string) =>
      [...container.querySelectorAll(`[data-testid="${testId}"] [aria-label]`)].map((node) =>
        node.getAttribute("aria-label"),
      );
    // Only open work is pinned; the running task has run from 10:00:02 to the clock's 10:01:00.
    expect(labels("group-member-work")).toEqual(["Beto, Running, 58s. Open thread"]);
    expect(labels("group-request-owners")).toEqual([
      "Beto, Running. Open thread",
      "Removed member, Completed. Open thread",
    ]);
    expect(labels("group-task-tree")).toEqual([
      "Beto, Running, 58s. Open thread",
      "Removed member, Completed, 6s. Open thread",
    ]);
    await click("Beto, Running, 58s. Open thread");
    expect(mocks.selectDetail).toHaveBeenCalledWith(THREAD);
  });
});

describe("group header and archive", () => {
  it("its title shows every member's face, a removed one too, and opens Group info", async () => {
    mocks.teams = [team({ memberIds: ["ada", "beto", "jarvis", "gone"] })];
    render();
    expect(container.querySelector('[data-testid="cluster"]')?.textContent).toBe(
      "ada,beto,jarvis,gone",
    );
    await click("Crew, Group info");
    expect(mocks.navigate).toHaveBeenCalledWith("AssistantGroupInfo", {
      environmentId: "hub",
      teamId: "g1",
    });
  });

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
  // Only a request's lines count as unread, so every line here belongs to one, as the server's do.
  const inRequests = (messages: ReturnType<typeof message>[]) =>
    snapshot(
      messages.map((row) => ({ ...row, requestId: row.author === "user" ? row.id : "m1" })),
      [task("t1", "paused", "ada", { reason: "stopped" }), task("t22", "running", "beto")],
    );
  const lateUserLines = () =>
    inRequests([
      message("m1", 1),
      ...[2, 3, 4, 5, 6].map((seq) =>
        message(`x${seq}`, seq, { author: "user", assistantId: null }),
      ),
    ]);
  beforeEach(() => {
    mocks.live = inRequests(FEED);
  });
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
    expect(byLabel("Scroll to end")).toBeNull();
    remount();
    mocks.live = lateUserLines();
    render();
    // Index 1: the first unread line, under its request's header.
    expect([list().getAttribute("data-initial-index"), list().getAttribute("data-at-end")]).toEqual(
      ["1", "false"],
    );
    // Opened above the end, the way down is one tap.
    expect(byLabel("Scroll to end")).not.toBeNull();
  });

  it("offers Scroll to end only while the feed is above its end", async () => {
    mocks.teams = [team({ chat: chat(2, 2) })];
    render();
    expect(byLabel("Scroll to end")).toBeNull();
    await click("scroll up");
    await click("Scroll to end");
    expect(mocks.scrollToEnd).toHaveBeenCalledOnce();
    await click("scroll down");
    expect(byLabel("Scroll to end")).toBeNull();
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
    mocks.live = lateUserLines();
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
    // Like the thread composer, the composer says why it will not send.
    expect(text()).toContain("Retry or remove the failed attachment");

    // The failed file holds the send until it is retried or removed; the others stay.
    await type("@ada see these");
    expect(byLabel("Send")!.disabled).toBe(true);
    await click("Remove broken.pdf");
    expect(chips()).toHaveLength(2);
    expect(text()).not.toContain("Retry or remove the failed attachment");
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

    // A send whose reply was lost keeps its files when the chat closes, so its resend carries them
    // under the same id.
    mocks.release.mockClear();
    mocks.pick.mockResolvedValue({ files: [draft("note.pdf")], error: null });
    await click("Add attachment:Choose Files");
    await type("@ada again");
    mocks.post.mockResolvedValue({ ok: false, message: "unconfirmed", reason: "unconfirmed" });
    await click("Send");
    act(() => root.unmount());
    root = createRoot(container);
    render();
    expect([chips().length, mocks.release.mock.calls]).toEqual([1, []]);
    await click("Send");
    const [sent, resent] = mocks.post.mock.calls.slice(-2).map(([input]) => input);
    expect([resent, mocks.requestIds.at(-1)]).toEqual([sent, mocks.requestIds.at(-2)]);
    expect(resent).toEqual(expect.objectContaining({ attachments: [expect.anything()] }));
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

  it("shows a file uploading, and opens picked files in the preview like the thread composer", async () => {
    const video = { ...draft("clip.mov"), type: "video", mimeType: "video/quicktime" };
    const notes = { ...draft("notes.txt"), mimeType: "text/plain", fileUri: "file:///notes.txt" };
    const pasted = { ...draft("pasted.txt"), mimeType: "text/plain" };
    mocks.pick.mockResolvedValue({
      files: [draft("shot.png", "image"), video, notes, pasted],
      error: null,
    });
    // Uploads that never finish: the strip shows their progress.
    mocks.prepare.mockImplementation(() => new Promise(() => {}));
    render();
    await click("Add attachment:Choose Files");
    expect([...chips()].map((chip) => chip.textContent)).toEqual(
      Array.from({ length: 4 }, () => "Uploading 0"),
    );
    expect(byLabel("Send")!.disabled).toBe(true);
    const previews = () =>
      [...container.querySelectorAll('[data-testid="preview"], [data-testid="video-preview"]')]
        .map((preview) => preview.textContent)
        .filter((shown) => shown !== "");
    await click("Open shot.png");
    expect(previews()).toEqual(["image:shot.png"]);
    await click("Open clip.mov");
    expect(previews()).toEqual(["draft:draft-clip.mov"]);
    // Other documents open from the device in the system viewer; one without a file has none.
    await click("Open notes.txt");
    expect(previews()).toEqual(["document:notes.txt"]);
    await click("Open pasted.txt");
    expect(previews()).toEqual(["document:notes.txt"]);
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
    // As the thread shows them: pictures and videos above the bubble, other files inside it.
    const names = (testID: string) =>
      [...container.querySelectorAll(`[data-testid="${testID}"] button`)].map((button) =>
        button.getAttribute("aria-label"),
      );
    expect([names("message-media"), names("message-files")]).toEqual([
      ["Open shot.png"],
      ["Open sheet.pdf", "Open notes.txt"],
    ]);
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

  const PAUSED = [
    // A pause the user did not ask for: one they asked for waits on no one.
    task("t1", "paused", "ada", { requestMessageId: "r1", requestId: "r1" }),
    TASKS[1]!,
  ];
  const waitingRows = () =>
    [...container.querySelectorAll('[data-testid="group-waiting-strip"] [aria-label]')].map(
      (node) => node.getAttribute("aria-label"),
    );
  const requestTint = () =>
    container.querySelector(
      '[data-testid="group-request-line"] ~ [data-testid="group-jump-highlight"]',
    ) ?? container.querySelector('[data-testid="group-jump-highlight"]');

  it("pins what waits on the user, oldest first, and resumes a stopped task from there", async () => {
    mocks.live = snapshot(REQUESTS, PAUSED);
    mocks.teams = [team({ chat: read })];
    render();
    expect(container.querySelector('[data-testid="group-waiting-strip"]')?.textContent).toContain(
      "Waiting on you (2)",
    );
    expect(waitingRows()).toEqual([
      expect.stringMatching(/^Fix build\. Ada: .+\. Open request$/),
      "Resume Fix build",
      "ship it. Jarvis: Needs a project. Open request",
    ]);
    await click("Resume Fix build");
    expect(mocks.taskAction).toHaveBeenCalledWith({ taskId: "t1", action: "resume" });
    // Opening a loaded request opens its block in place and tints its title row.
    await click(waitingRows()[0]!);
    expect(requestTint()).not.toBeNull();
    expect(mocks.olderThan).not.toHaveBeenCalled();
  });

  it("offers no Resume in an archived group, and drops the strip once nothing waits", () => {
    mocks.live = snapshot(REQUESTS, PAUSED);
    mocks.teams = [team({ chat: read, archivedAt: "2026-11-07T09:00:00Z" })];
    render();
    expect(byLabel("Resume Fix build")).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    mocks.live = snapshot(REQUESTS.slice(0, 3), TASKS.slice(0, 1));
    mocks.teams = [team({ chat: read })];
    render();
    expect(container.querySelector('[data-testid="group-waiting-strip"]')).toBeNull();
  });

  it("pages back to a waiting request the page does not hold, or says it is gone", async () => {
    const older = REQUESTS.slice(0, 3);
    const waitingRequest = {
      requestId: "r1",
      title: "Fix build",
      reason: "paused",
      assistantId: "ada",
    };
    mocks.live = snapshot(REQUESTS.slice(3), TASKS.slice(1), true);
    mocks.teams = [
      team({
        chat: {
          ...read,
          scopes: [{ projectId: "p1", unreadCount: 0, waiting: true, readSeq: 6, waitingRequest }],
        },
      }),
    ];
    mocks.olderThan.mockResolvedValueOnce({
      ok: true,
      value: { messages: older, tasks: [], hasMore: false },
    });
    render();
    // The server names it for a tab whose request is out of the page.
    expect(waitingRows()[0]).toMatch(/^Fix build\. Ada: /);
    await click(waitingRows()[0]!);
    await act(async () => {});
    expect(mocks.olderThan).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("fix the build");
    expect(requestTint()).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    mocks.olderThan.mockResolvedValueOnce({
      ok: true,
      value: { messages: [], tasks: [], hasMore: false },
    });
    render();
    await click(waitingRows()[0]!);
    await act(async () => {});
    expect(mocks.alert).toHaveBeenCalledWith("Request not found", "It is no longer in this chat.");
  });

  it("opens a linked request once its chat shows, or says it is in another tab", async () => {
    mocks.routeRequest = "r3";
    mocks.live = snapshot(REQUESTS, TASKS);
    mocks.teams = [team({ chat: read })];
    render();
    await act(async () => {});
    expect(requestTint()).not.toBeNull();
    expect(mocks.setParams).toHaveBeenCalledWith({ request: undefined });

    act(() => root.unmount());
    root = createRoot(container);
    mocks.routeRequest = "r1";
    tabbed("project:p2");
    await act(async () => {});
    expect(mocks.alert).toHaveBeenCalledWith(
      "Request is in another tab",
      "Open its project's tab or All to see it.",
    );
  });

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

  const FOLDED_FIX = "Fix build, Finished, Alpha. Open request";

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
    // Nothing is read before the tab is known: not the whole chat, not a scope.
    expect(new Set(mocks.subscribe.mock.calls.map((call) => call[2]))).toEqual(new Set([null]));
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
    expect(container.querySelector('[data-testid="group-pinned-rows"]') === null).toBe(android);
    // In flow on Android it sits above the list; pinned on iOS it draws over it, after it.
    const row = container.querySelector('[data-testid="group-tabs"]')!;
    expect(Boolean(row.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      android,
    );
  });

  it("opens on the saved tab only once the device's preferences are read, never All first", async () => {
    mocks.preferences = null;
    tabbed();
    expect(container.querySelector('[data-testid="group-tabs"]')).toBeNull();
    expect(container.querySelector('[data-testid="list"]')).toBeNull();
    act(() => {
      mocks.preferences = { assistantGroupTabs: { "hub:g1": "project:p2" } };
      for (const listener of mocks.preferenceListeners) listener();
    });
    expect(selected(TAB.beta)).toBe("true");
    expect(mocks.subscribe.mock.calls.map((call) => call[2])).not.toContainEqual(undefined);
  });

  it("opens the tab a push names, saves it, and tells push presentation which tab is on screen", () => {
    mocks.routeTab = "project:p2";
    tabbed("project:p1");
    expect(selected(TAB.beta)).toBe("true");
    expect(mocks.preferences).toEqual({ assistantGroupTabs: { "hub:g1": "project:p2" } });
    expect(mocks.setParams).toHaveBeenCalledWith({ tab: undefined });
    expect(mocks.showTab).toHaveBeenLastCalledWith(
      expect.any(String),
      "/assistant-groups/hub/g1",
      "project:p2",
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
    // An unconfirmed reply takes its quote back after another tab or leaving the chat, so its
    // resend keeps its id; the chat then showing its post drops the quote with the warning.
    await click(TAB.beta);
    await click("Reply to request Review");
    mocks.post.mockResolvedValue({ ok: false, message: "unconfirmed", reason: "unconfirmed" });
    await click("Send");
    await click(TAB.alpha);
    await click(TAB.beta);
    expect(text()).toContain("Replying to Review");
    remount();
    render();
    expect(text()).toContain("Replying to Review");
    await click("Send");
    const [first, resent] = mocks.requestIds;
    expect([mocks.post.mock.lastCall?.[0], resent]).toEqual([
      expect.objectContaining({ replyToMessageId: "r3" }),
      first,
    ]);
    mocks.live = snapshot(
      [...REQUESTS, message("m9", 9, { ...user, text: "still here", clientRequestId: first })],
      TASKS,
    );
    render();
    expect(container.querySelector('[data-testid="group-reply-chip"]')).toBeNull();
    expect([text().includes("unconfirmed"), input().value]).toEqual([false, ""]);
    // A reply cancelled on a failed send stays cancelled after another tab: it is a new message.
    await click("Reply to request Review");
    await type("again");
    await click("Send");
    await click("Cancel reply");
    await click(TAB.alpha);
    await click(TAB.beta);
    expect(container.querySelector('[data-testid="group-reply-chip"]')).toBeNull();
    await click("Send");
    const [failed, again] = mocks.requestIds.slice(-2);
    expect([mocks.post.mock.lastCall?.[0]?.replyToMessageId, again === failed]).toEqual([
      undefined,
      false,
    ]);
    // So does one cancelled while its send was on its way and failed in another tab.
    let fail = (_: { ok: false; message: string; reason: "unconfirmed" }) => {};
    mocks.post.mockReturnValueOnce(new Promise((resolve) => (fail = resolve)));
    await click("Reply to request Review");
    await click("Send");
    await click("Cancel reply");
    await click(TAB.alpha);
    await act(async () => fail({ ok: false, message: "unconfirmed", reason: "unconfirmed" }));
    await click(TAB.beta);
    expect(container.querySelector('[data-testid="group-reply-chip"]')).toBeNull();
    await click("Send");
    const [onItsWay, after] = mocks.requestIds.slice(-2);
    expect([mocks.post.mock.lastCall?.[0]?.replyToMessageId, after === onItsWay]).toEqual([
      undefined,
      false,
    ]);
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
    // Each line ends with its owners, each opening that member's thread.
    expect(lines()).toEqual([
      "Fix build, Finished, Alpha. Expand request",
      "Ada, Completed. Open thread",
      "ship it, Needs project. Expand request",
      "Review, Working, Beta. Expand request",
      "Beto, Running. Open thread",
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

  it("names a removed project by its last known title in its tab and a reply's project", async () => {
    mocks.preferences = { assistantGroupTabs: { "hub:g1": "project:p9" } };
    mocks.live = snapshot(
      [message("r4", 7, { ...user, text: "old", requestId: "r4", projectId: "p9", title: "Old" })],
      [],
    );
    const gone = { projectId: "p9", unreadCount: 1, waiting: false, readSeq: 6, title: "Site" };
    mocks.teams = [team({ chat: { ...read, unreadCount: 3, scopes: [...SCOPES, gone] } })];
    render();
    expect(selected("Site, 1 unread")).toBe("true");
    await click("Reply to request Old");
    expect(byLabel("Project: Site")).not.toBeNull();
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
    // No project yet: the lead may still move it, and only All is sure to hold it.
    expect(selected(TAB.all)).toBe("true");
    await click(TAB.general);
    await type("anyone else");
    await click("Send");
    expect(selected(TAB.general)).toBe("true");
    await click(TAB.all);
    await click("Project:Alpha");
    await type("@ada go");
    await click("Send");
    expect(selected(TAB.all)).toBe("true");
    // A tab opened, or a reply started, while the post was on its way is where the user stays.
    const sendHeld = async (opened: string, pick = "Project:Beta") => {
      await click(TAB.alpha);
      await click(pick);
      await type("@beto late");
      let settle!: (reply: unknown) => void;
      mocks.post.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
      await click("Send");
      await click(opened);
      return () => act(async () => settle({ ok: true, value: {} }));
    };
    for (const [opened, pick] of [
      [TAB.all, "Project:Beta"],
      [TAB.general, "Project:Beta"],
      [TAB.beta, "Project:Alpha"],
    ] as const) {
      const sent = await sendHeld(opened, pick);
      // On its way, it shows only in the tab it left from and in All, beside the project it goes to.
      expect(input().value).toBe(opened === TAB.all ? "@beto late" : "");
      if (opened === TAB.all) expect(byLabel("Project")).toBeNull();
      await sent();
      expect(selected(opened)).toBe("true");
    }
    const settle = await sendHeld(TAB.beta);
    await click("Reply to request Review");
    await settle();
    expect(selected(TAB.beta)).toBe("true");
    expect(text()).toContain("Replying to Review");
  });

  it("keeps what the user writes in another tab during a send, and a refused one in its own tab", async () => {
    tabbed("project:p1");
    const sendHeld = async (message: string) => {
      await click(TAB.alpha);
      await type(message);
      let settle!: (reply: unknown) => void;
      mocks.post.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
      await click("Send");
      await click(TAB.beta);
      expect(input().value).toBe("");
      await type("meanwhile");
      // This tab's draft is not on its way: its button neither spins nor waits.
      expect([byLabel("Sending"), byLabel("Send")?.disabled]).toEqual([null, false]);
      return (reply: unknown) => act(async () => settle(reply));
    };
    await (
      await sendHeld("@ada first")
    )({ ok: true, value: {} });
    expect(input().value).toBe("meanwhile");
    await type("");
    await (
      await sendHeld("@ada second")
    )({ ok: false, message: "server down", reason: null });
    expect(input().value).toBe("meanwhile");
    expect(text()).not.toContain("server down");
    // Leaving the chat and coming back keeps it, in its own tab.
    remount();
    render();
    expect(input().value).toBe("meanwhile");
    // A send from another tab leaves the refused one, its text and its error, where they are.
    await type("@ada third");
    await click("Send");
    expect(mocks.post).toHaveBeenLastCalledWith(expect.objectContaining({ text: "@ada third" }));
    expect(input().value).toBe("");
    await type("meanwhile");
    await click(TAB.alpha);
    expect(input().value).toBe("@ada second");
    expect(text()).toContain("server down");
    await click("Send");
    expect(mocks.post).toHaveBeenLastCalledWith(expect.objectContaining({ text: "@ada second" }));
    // The refused message goes again under its own id, which a post the server did take would match.
    const [first, second, third, resent] = mocks.requestIds;
    expect([new Set([first, second, third]).size, resent === second]).toEqual([3, true]);
    expect(input().value).toBe("meanwhile");
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

  it("shows the picked project's model beside it and picks the next message's model there", async () => {
    setup();
    // The lead decides the project, so there is no project model to show.
    expect(container.querySelector('[aria-label^="Model for"]')).toBeNull();
    expect(text()).not.toContain("Model in");
    await click("Project:Alpha");
    await click("Model for Alpha: name:gpt-5.5");
    expect(mocks.navigate).toHaveBeenCalledWith("GroupMessageModel", {
      environmentId: "hub",
      projectId: "p1",
      teamId: "g1",
      tab: null,
      selected: expect.objectContaining({ model: "gpt-5.5" }),
    });
    // A message's pick saves nothing, so it needs no right to change settings.
    mocks.canWriteSettings = false;
    render();
    expect(byLabel("Model for Alpha: name:gpt-5.5")?.disabled).toBe(false);
  });

  const OPUS = { instanceId: "claudeAgent", model: "opus" };
  const setPick = (pick: unknown) =>
    act(() => {
      mocks.modelPick = pick;
      for (const listener of mocks.pickListeners) listener();
    });
  const pickOpus = (tab: string | null = null) => setPick({ tab, value: OPUS });

  it("sends the message's own model once and never saves it as the project's", async () => {
    setup();
    await click("Project:Alpha");
    await pickOpus();
    expect(byLabel("Model for this message: name:opus")).not.toBeNull();
    // Always in view, not only in its menu: the pick is for this message.
    expect(
      byLabel("Model for this message: name:opus")?.querySelector(
        '[data-testid="toolbar-chip-mark"]',
      ),
    ).not.toBeNull();
    await click("Model for this message:Back to name:gpt-5.5");
    expect(mocks.modelPick).toBeNull();
    expect(byLabel("Model for Alpha: name:gpt-5.5")).not.toBeNull();
    await pickOpus();
    await type("@ada go");
    await click("Send");
    expect(mocks.post).toHaveBeenLastCalledWith({
      teamId: "g1",
      text: "@ada go",
      projectId: "p1",
      modelSelection: OPUS,
    });
    expect(mocks.modelPick).toBeNull();
    expect(mocks.writeSettings).not.toHaveBeenCalled();
  });

  it("drops the message's model when the user leaves the group", async () => {
    setup();
    await click("Project:Alpha");
    await pickOpus();
    expect(byLabel("Model for this message: name:opus")).not.toBeNull();
    act(() => root.unmount());
    expect(mocks.modelPick).toBeNull();
  });

  it("drops the message's model on another tab", async () => {
    tabbed();
    await click(TAB.alpha);
    await pickOpus("project:p1");
    expect(byLabel("Model for this message: name:opus")).not.toBeNull();
    await click(TAB.beta);
    expect(mocks.modelPick).toBeNull();
    expect(byLabel("Model for Beta: Members' models")).not.toBeNull();
    // Unless a failed send of that tab takes its picks back, so it goes again as sent, under its id.
    await click(TAB.alpha);
    await click("Project:Beta");
    await pickOpus("project:p1");
    await type("@beto go");
    mocks.post.mockResolvedValue({ ok: false, message: "unconfirmed", reason: "unconfirmed" });
    await click("Send");
    await click(TAB.beta);
    await click(TAB.alpha);
    await click("Send");
    const [first, resent] = mocks.requestIds;
    expect([mocks.post.mock.calls.map(([input]) => input), resent]).toEqual([
      Array(2).fill(expect.objectContaining({ projectId: "p2", modelSelection: OPUS })),
      first,
    ]);
    // A model the user clears on it stays cleared after another tab: it is another message.
    await setPick(null);
    await click(TAB.beta);
    await click(TAB.alpha);
    expect(mocks.modelPick).toBeNull();
    await click("Send");
    expect(mocks.post.mock.lastCall?.[0]).not.toHaveProperty("modelSelection");
    expect(mocks.requestIds.at(-1)).not.toBe(first);
  });

  it("drops both composer picks for good on a tab the user did not choose here", async () => {
    tabbed();
    await click(TAB.alpha);
    await pickOpus("project:p1");
    expect(byLabel("Model for this message: name:opus")).not.toBeNull();
    await click("Project:Beta");
    expect(byLabel("Project: Beta")).not.toBeNull();
    // Another device saves this group's tab, then the one the picks were made in.
    const savedElsewhere = (tab: string) =>
      act(() => {
        mocks.preferences = { assistantGroupTabs: { "hub:g1": tab } };
        for (const listener of mocks.preferenceListeners) listener();
      });
    savedElsewhere("all");
    expect(mocks.modelPick).toBeNull();
    savedElsewhere("project:p1");
    expect(selected(TAB.alpha)).toBe("true");
    expect(byLabel("Project: Alpha")).not.toBeNull();
    expect(byLabel("Model for Alpha: name:gpt-5.5")).not.toBeNull();
  });

  it("shows the group's default, else the members' own models, for a project without its own", async () => {
    setup();
    await click("Project:Beta");
    expect(byLabel("Model for Beta: Members' models")).not.toBeNull();
    // With no default at all, a pick still shows as this message's model.
    await pickOpus();
    expect(
      byLabel("Model for this message: name:opus")?.querySelector(
        '[data-testid="toolbar-chip-mark"]',
      ),
    ).not.toBeNull();
    await setPick(null);
    setup({ defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" } });
    expect(byLabel("Model for Beta: name:gpt-5.4")).not.toBeNull();
    // Clearing the project's own model goes back to what then applies.
    const clearLabel = async () => {
      await click("header:Project's model");
      return (mocks.navigate.mock.lastCall![1] as { clearLabel?: string }).clearLabel;
    };
    expect(await clearLabel()).toBe("Group default");
    // A provider the project turned off is skipped, as the server does when the request starts.
    mocks.codexOffInBeta = true;
    render();
    expect(byLabel("Model for Beta: Members' models")).not.toBeNull();
    expect(await clearLabel()).toBe("Members' models");
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
    // The project's own model is set here, not from the composer.
    expect(byLabel("header:Project's model")?.dataset.subtitle).toBe("name:gpt-5.5");
    await click("header:Project's model");
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsProjectModel", {
      members: [{ environmentId: "hub", projectId: "p1" }],
      clearLabel: "Members' models",
    });
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
    // A reply to the request itself goes to the one member working it, not to one named "Review".
    expect(recipients()).toBe("To Beto");
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
    // One host for every row, beside the composer's own for its drafts.
    expect(container.querySelectorAll('[data-testid="preview"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="video-preview"]')).toHaveLength(2);
  });
});
