import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthFilesystemReadScope,
  AuthMemoryReadScope,
  AuthMemoryWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  // Killing a listener signals a host process, as closing a terminal does.
  [WS_METHODS.serverKillListeningPort]: AuthTerminalOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
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
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
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
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.restartProviderSession]: AuthOrchestrationOperateScope,
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

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  // Source reads need explicit transcript access; the memory scope alone is not enough.
  if (method === WS_METHODS.memoryReadSource)
    return [AuthMemoryReadScope, AuthOrchestrationReadScope];
  if (method === WS_METHODS.memoryImportProvider)
    return [AuthMemoryWriteScope, AuthFilesystemReadScope];
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
