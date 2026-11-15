import { GLOBAL_SKILLS_WS_METHODS } from "./globalSkillsRpc.ts";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { AssetCreateUrlInput } from "./assets.ts";
import type { DeviceListInput } from "./device.ts";
import type { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import type { ProjectMutation } from "./project.ts";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthTerminalReadScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthMemoryReadScope,
  AuthMemoryWriteScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import {
  requiredScopesForProjectMutation,
  requiredScopesForServerSettingsUpdate,
  type ServerSettingsUpdateInput,
} from "./settings.ts";
import {
  WS_METHODS,
  type WsMemoryAdministrationRpcGroup,
  type WsMemoryCoreRpcGroup,
  type WsMemoryImportRpcGroup,
  type WsRpcGroup,
} from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  // Rewrites the instance's `.claude.json`, as the CLI's `/chrome` toggle does.
  [WS_METHODS.providerClaudeChromeSetDefault]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthRemoveMethod]: AuthProvidersManageScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // Taking a device over pauses the agent driving it, as sending it input does.
  [WS_METHODS.deviceSetHold]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceInput]: AuthOrchestrationOperateScope,
  // Decides which devices agents may use.
  [WS_METHODS.deviceSetAccess]: AuthSettingsWriteScope,
  // Pairing or forgetting a phone changes which devices this environment can reach.
  [WS_METHODS.deviceWifiPairStart]: AuthSettingsWriteScope,
  [WS_METHODS.deviceWifiPairCancel]: AuthSettingsWriteScope,
  [WS_METHODS.deviceForget]: AuthSettingsWriteScope,
  // Letting a linked environment use a device, or shutting it out, decides who drives it, as access policies do.
  [WS_METHODS.deviceAnswerLinkRequest]: AuthSettingsWriteScope,
  [WS_METHODS.deviceSetLinkBlocked]: AuthSettingsWriteScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  // Killing a listener signals a host process, as closing a terminal does.
  [WS_METHODS.serverKillListeningPort]: AuthTerminalOperateScope,
  // Reordering or removing queued heavy work changes when other agents' processes run.
  [WS_METHODS.heavyQueuePromote]: AuthTerminalOperateScope,
  [WS_METHODS.heavyQueueStartNow]: AuthTerminalOperateScope,
  [WS_METHODS.heavyQueueCancel]: AuthTerminalOperateScope,
  [WS_METHODS.heavyQueueMove]: AuthTerminalOperateScope,
  [WS_METHODS.heavyQueueSetPaused]: AuthTerminalOperateScope,
  [WS_METHODS.heavyQueueSetEnabled]: AuthTerminalOperateScope,
  [WS_METHODS.heavyQueueSetRule]: AuthTerminalOperateScope,
  [WS_METHODS.heavyQueueRoute]: AuthTerminalOperateScope,
  [WS_METHODS.heavyQueueSetMaxRunning]: AuthTerminalOperateScope,
  [WS_METHODS.heavyQueueSetPriority]: AuthTerminalOperateScope,
  [WS_METHODS.heavyQueueSetClaudeHook]: AuthTerminalOperateScope,
  [WS_METHODS.heavyQueueSetDeviceIdleMinutes]: AuthTerminalOperateScope,
  [WS_METHODS.heavyQueueStopCommand]: AuthTerminalOperateScope,
  [GLOBAL_SKILLS_WS_METHODS.globalSkillsRemove]: AuthSettingsWriteScope,
  [GLOBAL_SKILLS_WS_METHODS.globalSkillsRescan]: AuthSettingsWriteScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.threadsRestoreWorkspace]: AuthOrchestrationOperateScope,
  // Restarts the server, as an update does.
  [WS_METHODS.serverReclaimDatabaseSpace]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  // The minimum; the patch can trade it for or add providers:manage.
  [WS_METHODS.serverUpdateSettings]: AuthSettingsWriteScope,
  // Listing models spends the stored API key, so only those who can choose a model may.
  [WS_METHODS.serverListTextGeneratorModels]: AuthSettingsWriteScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateFromThread]: AuthOrchestrationOperateScope,
  // File explorer edits create, move and delete workspace files, as saving one does.
  [WS_METHODS.projectsChangeEntry]: AuthFilesystemWriteScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlStar]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanBoardEnsure]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanBoardUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanColumnCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanColumnUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanColumnMove]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanColumnDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanLabelUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanLabelDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanTemplateUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanTemplateDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanCardCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanCardUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanCardMove]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanCardArchive]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanCardUnarchive]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanCardDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanCardComment]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanCardLinkThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanCardUnlinkThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.notesWrite]: AuthOrchestrationOperateScope,
  [WS_METHODS.notesUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.notesMove]: AuthOrchestrationOperateScope,
  [WS_METHODS.notesDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.notesStartWork]: AuthOrchestrationOperateScope,
  [WS_METHODS.decisionsAnswer]: AuthOrchestrationOperateScope,
  [WS_METHODS.decisionsDismiss]: AuthOrchestrationOperateScope,
  [WS_METHODS.computerUseOpenSettings]: AuthSettingsWriteScope,
  [WS_METHODS.assistantsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantsUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantsReset]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantsSetAvatarImage]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantsSetTaskDismissed]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantSandboxStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantSandboxStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantSandboxRemove]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantSandboxConfigure]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantSandboxPairing]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantSandboxGithubSignIn]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantSandboxGithubSignOut]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantTeamsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantTeamsUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantTeamsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantGroupsPost]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantGroupsTaskAction]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantGroupsMarkRead]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantGroupsConversation]: AuthOrchestrationOperateScope,
  [WS_METHODS.autonomyWatchUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.autonomyWatchSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.autonomyWatchDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.imessageChannelConfigure]: AuthOrchestrationOperateScope,
  [WS_METHODS.telegramChannelConfigure]: AuthOrchestrationOperateScope,
  // Sends again what the chat app never confirmed, as the outbox would on its own.
  [WS_METHODS.imessageChannelResendUndelivered]: AuthOrchestrationOperateScope,
  [WS_METHODS.telegramChannelResendUndelivered]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.handoffThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.memorySearch]: AuthMemoryReadScope,
  [WS_METHODS.memoryList]: AuthMemoryReadScope,
  [WS_METHODS.memoryRead]: AuthMemoryReadScope,
  [WS_METHODS.memoryHistory]: AuthMemoryReadScope,
  [WS_METHODS.memoryChanges]: AuthMemoryReadScope,
  [WS_METHODS.memoryHubDiagnostics]: AuthMemoryReadScope,
  [WS_METHODS.memorySyncStatus]: AuthMemoryReadScope,
  [WS_METHODS.memoryReadSource]: AuthMemoryReadScope,
  [WS_METHODS.memoryUpsert]: AuthMemoryWriteScope,
  [WS_METHODS.memoryForget]: AuthMemoryWriteScope,
  [WS_METHODS.memoryRevertResolution]: AuthMemoryWriteScope,
  [WS_METHODS.memoryImportProvider]: AuthMemoryWriteScope,
  [WS_METHODS.memoryProjectBindingGet]: AuthMemoryWriteScope,
  [WS_METHODS.memoryProjectBindingUpdate]: AuthMemoryWriteScope,
  [WS_METHODS.memoryHubSettingsGet]: AuthSettingsWriteScope,
  [WS_METHODS.memoryHubSettingsUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.memoryHubReconcile]: AuthSettingsWriteScope,
  [WS_METHODS.memoryOwnerSourceReadPolicyGet]: AuthSettingsWriteScope,
  [WS_METHODS.memoryOwnerSourceReadPolicyUpdate]: AuthSettingsWriteScope,
  // Force stop kills agent processes, as Stop on a terminal does.
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksLink]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksUnlink]: AuthAccessWriteScope,
  // A link lets every agent here reach the other environment: Settings' bar.
  [WS_METHODS.peerLinksAnswerRequest]: AuthAccessWriteScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

type ServedRpcTag = RpcGroup.Rpcs<
  | typeof WsRpcGroup
  | typeof WsMemoryCoreRpcGroup
  | typeof WsMemoryAdministrationRpcGroup
  | typeof WsMemoryImportRpcGroup
>["_tag"];

// Typed against the unguarded tags, so restating a guarded method here fails to compile.
const UNGUARDED_RPC_SCOPES = {
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getNativeChildWork]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThreads]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThread]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadTitles]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadLinkMetadata]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribePromptSuggestion]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverProbe]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetNpmRelease]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateProvider]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthStart]: AuthProvidersManageScope,
  [WS_METHODS.providerConsumeResetCredit]: AuthProvidersManageScope,
  [WS_METHODS.providerClaudeChromeStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.providerAuthComplete]: AuthProvidersManageScope,
  [WS_METHODS.chatGptReconnectProfile]: AuthProvidersManageScope,
  [WS_METHODS.chatGptImportProfile]: AuthProvidersManageScope,
  [WS_METHODS.chatGptHandoffSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthRespond]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthCancel]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthLogout]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallStart]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallCancel]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.providerInstallRemove]: AuthProvidersManageScope,
  [WS_METHODS.serverUpdateServer]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverUpdateServerWithProgress]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCommitDesktopUpdate]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverUpsertKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverRemoveKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverGetStorageCleanupReport]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetDatabaseStorage]: AuthOrchestrationReadScope,
  [WS_METHODS.threadsGetWorkspaceStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.peerLinksList]: AuthAccessReadScope,
  [WS_METHODS.serverSearchAcpRegistry]: AuthOrchestrationReadScope,
  [WS_METHODS.serverPrepareAcpRegistryAgent]: AuthProvidersManageScope,
  [WS_METHODS.serverUninstallAcpRegistryManagedBinary]: AuthProvidersManageScope,
  [WS_METHODS.serverAcceptAcpRegistryUrlAuth]: AuthProvidersManageScope,
  [WS_METHODS.serverListAcpRegistrySessions]: AuthOrchestrationReadScope,
  [WS_METHODS.serverImportAcpRegistrySession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverDeleteAcpRegistrySession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListAcpRegistryProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.serverSetAcpRegistryProvider]: AuthProvidersManageScope,
  [WS_METHODS.serverDisableAcpRegistryProvider]: AuthProvidersManageScope,
  [WS_METHODS.serverLogoutAcpRegistry]: AuthProvidersManageScope,
  [WS_METHODS.serverDiscoverSourceControl]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetTraceDiagnostics]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetProcessDiagnostics]: AuthDiagnosticsReadScope,
  // Thread load balancing reads host load, so it needs thread scope rather than diagnostics scope.
  [WS_METHODS.serverGetHostResources]: AuthOrchestrationReadScope,
  // Lists every host process holding a port, not just this server's.
  [WS_METHODS.serverListListeningPorts]: AuthDiagnosticsReadScope,
  // Runs git (including a fetch) in a folder on the host.
  [WS_METHODS.serverForkUpdateStatus]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetProcessResourceHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetResourceTelemetryHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverRetryResourceTelemetry]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetUsageSummary]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetInstanceSpend]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverRefreshUsageRates]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverSignalProcess]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverReportClientActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.scheduledTasksSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.secretsAnswerRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.kanbanSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.kanbanGetCard]: AuthOrchestrationReadScope,
  [WS_METHODS.kanbanListArchived]: AuthOrchestrationReadScope,
  [WS_METHODS.notesList]: AuthOrchestrationReadScope,
  [WS_METHODS.notesRead]: AuthOrchestrationReadScope,
  [WS_METHODS.notesSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.decisionsList]: AuthOrchestrationReadScope,
  [WS_METHODS.decisionsSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.computerUsePermissions]: AuthOrchestrationReadScope,
  [WS_METHODS.assistantsSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.assistantsSpend]: AuthOrchestrationReadScope,
  [WS_METHODS.assistantsLibrary]: AuthOrchestrationReadScope,
  [WS_METHODS.assistantSandboxSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.assistantGroupsSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.assistantGroupsHistory]: AuthOrchestrationReadScope,
  [WS_METHODS.autonomyWatchesList]: AuthOrchestrationReadScope,
  [WS_METHODS.imessageChannelGetSettings]: AuthOrchestrationReadScope,
  [WS_METHODS.imessageChannelSubscribeStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.imessageChannelCheckAccess]: AuthOrchestrationReadScope,
  [WS_METHODS.keepAwakeSubscribeStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.heavyQueueSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.heavyQueueSubscribeCommands]: AuthOrchestrationReadScope,
  [WS_METHODS.telegramChannelGetSettings]: AuthOrchestrationReadScope,
  [WS_METHODS.telegramChannelSubscribeStatus]: AuthOrchestrationReadScope,
  // Delivery logs hold request bodies, so they need the same scope as the URL.
  [WS_METHODS.scheduledTasksListWebhookDeliveries]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksGetWebhookDelivery]: AuthOrchestrationOperateScope,
  [WS_METHODS.cloudGetRelayClientStatus]: AuthRelayReadScope,
  [WS_METHODS.cloudInstallRelayClient]: AuthRelayWriteScope,
  [WS_METHODS.pullRequestsList]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsListStats]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsFilterOptions]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSummary]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRouting]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRoutingIdentity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsStack]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsLinkedThreads]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsPreview]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsChecks]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsReviewGuide]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsThreadComments]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDiffFileContents]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsFilesViewed]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsChangeBreakdown]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsInvalidate]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsReportState]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSubscribeRefreshes]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsReviewerCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsLabelCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlLookupRepository]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlAppAccess]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlStarred]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeProjectClones]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsListEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsListIgnoredFiles]: AuthFilesystemReadScope,
  [WS_METHODS.projectsReadFile]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchContents]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsWriteFile]: AuthFilesystemWriteScope,
  [WS_METHODS.projectsEnsureScratch]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateNew]: AuthOrchestrationOperateScope,
  [WS_METHODS.shellOpenInEditor]: AuthOrchestrationOperateScope,
  [WS_METHODS.filesystemBrowse]: AuthFilesystemReadScope,
  [WS_METHODS.filesystemGetMetadata]: AuthFilesystemReadScope,
  [WS_METHODS.agentSessionsScan]: AuthOrchestrationReadScope,
  [WS_METHODS.agentSessionsImport]: AuthOrchestrationOperateScope,
  [WS_METHODS.assetsCreateUrl]: AuthOrchestrationReadScope,
  [WS_METHODS.assetsPersistChatAttachments]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsCreateUploadUrl]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerUploadFeedback]: AuthOrchestrationOperateScope,
  [WS_METHODS.mcpAppsCallTool]: AuthOrchestrationOperateScope,
  [WS_METHODS.mcpAppsToolInfo]: AuthOrchestrationReadScope,
  [WS_METHODS.mcpAppsReadResource]: AuthOrchestrationReadScope,
  [WS_METHODS.mcpAppsUpdateModelContext]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeVcsStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeVcsBranch]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsRefreshBranch]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeWorktreeSetup]: AuthOrchestrationReadScope,
  [WS_METHODS.worktreeSetupCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeResourceTelemetry]: AuthDiagnosticsReadScope,
  [WS_METHODS.vcsRefreshStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.gitResolvePullRequest]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsListRefs]: AuthOrchestrationReadScope,
  [WS_METHODS.reviewGetBranchCommits]: AuthFilesystemReadScope,
  [WS_METHODS.reviewGetDiffPreview]: AuthFilesystemReadScope,
  [WS_METHODS.reviewGetDiffFileContents]: AuthFilesystemReadScope,
  [WS_METHODS.terminalOpen]: AuthTerminalOperateScope,
  [WS_METHODS.terminalAttach]: AuthTerminalOperateScope,
  [WS_METHODS.terminalObserve]: AuthTerminalReadScope,
  [WS_METHODS.terminalWrite]: AuthTerminalOperateScope,
  [WS_METHODS.terminalResize]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClear]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClose]: AuthTerminalOperateScope,
  [WS_METHODS.subscribeTerminalMetadata]: AuthTerminalReadScope,
  [WS_METHODS.previewOpen]: AuthPreviewOperateScope,
  [WS_METHODS.previewResize]: AuthPreviewOperateScope,
  [WS_METHODS.previewAdjust]: AuthPreviewOperateScope,
  [WS_METHODS.previewList]: AuthOrchestrationReadScope,
  [WS_METHODS.previewClearProfile]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportProfiles]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportStatus]: AuthPreviewOperateScope,
  [WS_METHODS.subscribePreviewEvents]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeDiscoveredLocalServers]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceConfigure]: AuthSettingsWriteScope,
  [WS_METHODS.deviceTestHost]: AuthSettingsWriteScope,
  [WS_METHODS.deviceEasAccount]: AuthSettingsWriteScope,
  [WS_METHODS.deviceSimlockIdentity]: AuthSettingsWriteScope,
  [WS_METHODS.deviceList]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceClose]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceShutdown]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceAction]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeDeviceState]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerLifecycle]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeAuthAccess]: AuthAccessReadScope,
} as const satisfies Readonly<
  Record<Exclude<ServedRpcTag, ClientGuardedRpcTag>, AuthEnvironmentScope>
>;

/** The scope every served RPC needs before its payload is considered. */
export const RPC_REQUIRED_SCOPES = {
  ...CLIENT_GUARDED_RPC_SCOPES,
  ...UNGUARDED_RPC_SCOPES,
} as const satisfies Readonly<Record<ServedRpcTag, AuthEnvironmentScope>>;

/**
 * What the server authorizes for a call, and what commands report to the UI.
 * The payload is the method's decoded input: the RPC server decodes before its
 * middleware runs, and clients hold typed input. Without one this is the minimum.
 */
export function rpcRequiredScopes(
  method: string,
  payload: unknown,
): readonly AuthEnvironmentScope[] {
  if (!Object.hasOwn(RPC_REQUIRED_SCOPES, method))
    throw new Error(`RPC method ${method} has no declared authorization scope.`);
  const scope = RPC_REQUIRED_SCOPES[method as ServedRpcTag];
  if (method === WS_METHODS.serverRetryResourceTelemetry)
    return [AuthEnvironmentMaintainScope, AuthDiagnosticsReadScope];
  // Source reads need explicit transcript access; the memory scope alone is not enough.
  if (method === WS_METHODS.memoryReadSource)
    return [AuthMemoryReadScope, AuthOrchestrationReadScope];
  if (method === WS_METHODS.memoryImportProvider)
    return [AuthMemoryWriteScope, AuthFilesystemReadScope];
  if (payload === undefined) return [scope];
  if (method === WS_METHODS.serverUpdateSettings)
    return requiredScopesForServerSettingsUpdate(payload as ServerSettingsUpdateInput);
  if (method === WS_METHODS.projectsMutate)
    return requiredScopesForProjectMutation(payload as ProjectMutation);
  if (method === WS_METHODS.assetsCreateUrl) {
    const { resource } = payload as AssetCreateUrlInput;
    return [
      resource._tag === "workspace-file" ||
      resource._tag === "media-file" ||
      resource._tag === "draft-workspace-file" ||
      (resource._tag === "native-app-icon" && resource.app._tag === "app-path")
        ? AuthFilesystemReadScope
        : AuthOrchestrationReadScope,
    ];
  }
  if (method === WS_METHODS.deviceList) {
    // Mirrors the handler: updating a tool or retrying a host can install or restart tools.
    const input = payload as DeviceListInput;
    return input.updateTool || (input.retryHostId && !input.inspectOnly)
      ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
      : [AuthOrchestrationReadScope];
  }
  if (method === WS_METHODS.gitPreparePullRequestThread) {
    const input = payload as GitPreparePullRequestThreadInput;
    if (input.mode === "worktree" && input.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction) {
    const input = payload as GitRunStackedActionInput;
    if (
      input.threadId !== undefined &&
      (input.action === "create_pr" || input.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return [scope];
}

/** What the transport refuses to send without a command boundary; other requests go unchecked. */
export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method) ? rpcRequiredScopes(method, input) : [];
}
