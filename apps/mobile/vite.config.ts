import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { defineConfig, normalizePath } from "vite-plus";
import "vite-plus/test/config";

const reactTests = [
  "src/state/keepAwake.test.tsx",
  "src/features/settings/components/KeepAwakeSection.test.tsx",
  "src/features/settings/components/WorktreeSnapshotsSection.test.tsx",
  "src/features/threads/ThreadWorkspaceNotice.test.tsx",
  "src/state/heavyQueue.test.tsx",
  "src/features/settings/components/HeavyQueueSection.test.tsx",
  "src/features/threads/useVisibleNewTaskScopes.test.tsx",
  "src/features/archive/ArchivedThreadsRouteScreen.test.tsx",
  "src/features/archive/ArchivedThreadsScreen.test.tsx",
  "src/features/home/archiveProjectMenus.test.tsx",
  "src/features/archive/ArchivedProjectRow.test.tsx",
  "src/features/projects/useProjectOrganize.test.tsx",
  "src/features/threads/ThreadSideChatsRow.test.tsx",
  "src/features/threads/ThreadSideChatBar.test.tsx",
  "src/features/threads/sendToMainChat.test.tsx",
  "src/features/connection/ConnectionEnvironmentRow.test.tsx",
  "src/features/kanban/KanbanBoardRouteScreen.test.tsx",
  "src/features/kanban/KanbanCardMenu.test.tsx",
  "src/features/kanban/ThreadKanbanCardControls.test.tsx",
  "src/features/kanban/KanbanCardAttachments.test.tsx",
  "src/features/threads/useThreadMenu.test.tsx",
  "src/features/kanban/KanbanCardRouteScreen.test.tsx",
  "src/features/notes/NotesRouteScreen.test.tsx",
  "src/features/settings/SettingsMacPermissionsRouteScreen.test.tsx",
  "src/features/kanban/KanbanAddAttachmentButton.test.tsx",
  "src/features/threads/git/GitBranchesSheet.test.tsx",
  "src/features/threads/new-task-flow-provider.test.tsx",
  "src/features/workspace/workspace-tabs-state.test.ts",
  "src/state/use-thread-pr.demand.test.tsx",
  "src/features/threads/git/GitBranchesSheet.occupancy.test.tsx",
  "src/features/files/useFileTreeEntries.test.tsx",
  "src/features/projects/AddProjectScreen.test.ts",
  "src/lib/useMediaVideoPlayback.test.tsx",
  "src/features/pull-requests/usePullRequestEnvironmentFallback.test.tsx",
  "src/lib/filePreview.test.ts",
  "src/features/threads/thread-inspector-navigation.test.tsx",
  "src/features/diffs/nativeReviewDiffSurface.test.tsx",
  "src/features/pull-requests/usePullRequestDiff.test.tsx",
  "src/components/ProjectFavicon.test.tsx",
  "src/components/ui/Dialog.android.test.tsx",
  "src/components/ui/Menu.test.tsx",
  "src/features/threads/useUnavailableThreadDraftRedirect.test.tsx",
  "src/features/threads/useOpenLinkedThread.test.tsx",
  "src/features/pull-requests/usePullRequestList.test.tsx",
  "src/features/files/ZipArchiveView.test.tsx",
  "src/features/pull-requests/guide/useReviewGuide.test.tsx",
  "src/features/settings/SettingsServerControlsRouteScreen.test.tsx",
  "src/features/settings/components/BranchNamingSettings.test.tsx",
  "src/features/settings/components/FolderModelsSection.test.tsx",
  "src/features/settings/FolderModelRouteScreen.test.tsx",
  "src/features/settings/FallbackModelPickerRouteScreen.test.tsx",
  "src/features/settings/FolderModelPickerRouteScreen.test.tsx",
  "src/features/settings/components/SettingsDragHandle.test.tsx",
  "src/features/threads/ThreadMarkdownImage.test.tsx",
  "src/features/threads/UsageLimitRecoveryCard.test.tsx",
  "src/features/threads/NewTaskDraftRouteScreen.test.tsx",
  "src/native/NativeHeaderToolbar.test.tsx",
  "src/native/V5StackHeader.ios.test.tsx",
  "src/native/useRestingTopOffset.test.tsx",
  "src/native/useRetryingImageSource.test.tsx",
  "src/state/queries.debounce.test.tsx",
  "src/state/use-selected-thread-git-actions.test.tsx",
  "src/state/use-selected-thread-git-state.test.tsx",
  "src/features/terminal/useTerminalExitNavigation.test.tsx",
  "src/features/threads/use-thread-list-now.test.tsx",
  "src/features/threads/useThreadListV2.test.tsx",
  "src/features/home/home-list-options.test.tsx",
  "src/features/workspace/useSearchScrollRestoration.test.tsx",
  "src/features/connection/ConnectionsNewRouteScreen.test.tsx",
  "src/features/notes/NoteRouteScreen.test.tsx",
  "src/features/notes/NoteConflictRouteScreen.test.tsx",
  "src/features/notes/NoteStartWorkRouteScreen.test.tsx",
  "src/features/settings/MemorySyncDiagnostics.test.tsx",
  "src/features/settings/SettingsMemoryRouteScreen.test.tsx",
  "src/features/settings/SettingsScheduledTasksRouteScreen.test.tsx",
  "src/features/decisions/HomeDecisionsSection.test.tsx",
  "src/features/home/HomeAgentsSection.test.tsx",
  "src/features/assistants/HomeAssistantsSection.test.tsx",
  "src/features/home/useHomeSectionPreferences.test.tsx",
  "src/features/home/HomeNeedsYouSection.test.tsx",
  "src/features/home/UnreadActionsMenu.test.tsx",
  "src/features/decisions/DecisionCard.test.tsx",
  "src/features/decisions/DecisionAttachments.test.tsx",
  "src/features/assistants/AssistantSchedulesSection.test.tsx",
  "src/features/assistants/AssistantEditRouteScreen.test.tsx",
  "src/features/assistants/AssistantSandboxSection.test.tsx",
  "src/features/assistants/AssistantTeamScreens.test.tsx",
  "src/features/assistants/assistantAvatar.test.tsx",
  "src/features/assistants/AssistantAvatarPicker.test.tsx",
  "src/features/assistants/ProjectAssistantRows.test.tsx",
  "src/features/assistants/DescribeAssistantRouteScreen.test.tsx",
  "src/features/assistants/describeAssistant.test.tsx",
  "src/features/assistants/SettingsAssistantsRouteScreen.test.tsx",
  "src/features/assistants/AssistantGroupChatRouteScreen.test.tsx",
  "src/features/assistants/assistantGroupFlows.test.tsx",
  "src/features/assistants/AutonomySettingsSection.test.tsx",
  "src/features/assistants/AssistantWatchesSection.test.tsx",
  "src/features/assistants/AssistantWatchRouteScreen.test.tsx",
  "src/state/autonomy.test.tsx",
  "src/features/imessage/SettingsImessageRouteScreen.test.tsx",
  "src/state/imessageChannel.test.tsx",
  "src/features/telegram/SettingsTelegramRouteScreen.test.tsx",
  "src/features/settings/components/ChannelLanguageSection.test.tsx",
  "src/state/channelLanguage.test.tsx",
  "src/state/telegramChannel.test.tsx",
  "src/features/threads/SubagentRow.memory.test.tsx",
];

const sourceRoot = `${normalizePath(NodeURL.fileURLToPath(new URL("./src", import.meta.url)))}/`;
const require = NodeModule.createRequire(import.meta.url);
const babel: {
  transformAsync: (
    code: string,
    options: Record<string, unknown>,
  ) => Promise<{ code?: string | null; map?: object | null } | null>;
} = require("@babel/core");
const babelConfig = require("./babel.config.js")({ cache: () => {} });

export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["**/*.test.{ts,tsx,mjs}"],
          exclude: ["**/node_modules/**", ...reactTests],
          setupFiles: [
            "../../packages/shared/src/testing/longTempDir.ts",
            "../../packages/shared/src/testing/providerEnv.ts",
          ],
        },
      },
      {
        extends: true,
        plugins: [
          {
            name: "mobile-release-react-compiler",
            enforce: "pre",
            async transform(code, id) {
              if (
                !normalizePath(id).startsWith(sourceRoot) ||
                !/\.tsx?$/.test(id) ||
                /\.test\.tsx?$/.test(id)
              ) {
                return;
              }
              const result = await babel.transformAsync(code, {
                ...babelConfig,
                presets: babelConfig.presets.map(([name, options]: [string, object]) => [
                  require.resolve(name),
                  // Vite runs in Node; inline Babel helpers instead of Metro runtime imports.
                  { ...options, enableBabelRuntime: false },
                ]),
                filename: id,
                babelrc: false,
                configFile: false,
                sourceMaps: true,
                caller: {
                  name: "metro",
                  bundler: "metro",
                  platform: "ios",
                  isDev: false,
                  isServer: false,
                  isNodeModule: false,
                  supportsStaticESM: true,
                  supportsReactCompiler: true,
                },
              });
              if (result?.code) return { code: result.code, map: result.map };
            },
          },
        ],
        test: {
          name: "react",
          include: reactTests,
          // Native components mock React Native and render through react-dom in these tests.
          environment: "jsdom",
          setupFiles: ["../../packages/shared/src/testing/providerEnv.ts"],
        },
      },
    ],
  },
});
