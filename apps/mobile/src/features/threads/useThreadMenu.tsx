import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { useNowMinuteMs } from "../../lib/clock";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { uuidv4 } from "../../lib/uuid";
import { useThreadAssistant } from "../../state/assistants";
import { threadListEnvironmentsAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { turnThreadIntoProject, canTurnThreadIntoProject } from "./turnThreadIntoProject";
import { useAssistantFlows } from "../assistants/useAssistantFlows";
import { useOpenAssistantEditor } from "../assistants/openAssistantEditor";
import { useThreadListActions } from "../home/useThreadListActions";
import { threadCanArchive } from "../home/threadArchive";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { openThreadHandoff } from "./openThreadHandoff";
import { canHandoffThread } from "./thread-handoff";
import { copyThreadMenuReference } from "./copyThreadMenuReference";
import {
  buildSnoozePresetActions,
  buildThreadMenuActions,
  menuActionsToAppBarItems,
  resolveThreadMenuKind,
  runThreadMenuEvent,
} from "./thread-menu";
import { getThreadListV2NewBranchMenuTitle } from "./thread-list-v2-row-appearance";
import { resolveThreadListV2SnoozePresets } from "./threadListV2";
import * as Dialog from "../../components/ui/Dialog";

/**
 * The open thread's actions menu: the same actions and rules as the list row's long-press menu.
 * `onRemoved` runs once the thread is archived or deleted, so the screen can leave it.
 */
export function useThreadMenu(
  thread: EnvironmentThreadShell | undefined,
  onRemoved: () => void,
): { readonly items: AppBarMenuItem[] | null; readonly customSnoozeSheet: ReactNode } {
  const environments = useAtomValue(threadListEnvironmentsAtom);
  const canOperate = useEnvironmentScope(
    thread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const selectDetail = useSelectWorkspaceDetail();
  const nowMinuteMs = useNowMinuteMs();
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  const assistantEntry = useThreadAssistant(thread?.environmentId ?? null, thread?.id ?? null);
  const assistantFlows = useAssistantFlows(
    assistantEntry?.environmentId ?? thread?.environmentId ?? ("" as EnvironmentId),
  );
  const openAssistantEditor = useOpenAssistantEditor();
  const actions = useThreadListActions((action) => {
    if (action === "archive" || action === "delete") onRemoved();
  });
  if (!thread || !canOperate) return { items: null, customSnoozeSheet: null };

  const environmentId = thread.environmentId;
  const now = new Date(nowMinuteMs).toISOString();
  const settlementSupported = environments.settlementEnvironmentIds.has(environmentId);
  const snoozeSupported = environments.snoozeEnvironmentIds.has(environmentId);
  const snoozePresetSettings = environments.snoozePresetsByEnvironmentId.get(environmentId);
  const snoozed = snoozeSupported && effectiveSnoozed(thread, { now });
  const snoozable = snoozeSupported && !snoozed && canSnooze(thread, { now });
  const settled = settlementSupported && thread.settledOverride === "settled";
  const snoozePresets = resolveThreadListV2SnoozePresets({
    secondary: snoozable ? "snooze" : null,
    now,
    presets: snoozePresetSettings,
  });
  const canTurnIntoProject = canTurnThreadIntoProject(thread);
  const menuActions = buildThreadMenuActions({
    kind: resolveThreadMenuKind({ snoozed, settlementSupported, settled, snoozable }),
    newThreadOnBranchTitle: thread.branch ? getThreadListV2NewBranchMenuTitle(thread.branch) : null,
    pinned: thread.pinnedAt != null,
    pinningSupported: environments.pinningEnvironmentIds.has(environmentId),
    autoSettle: {
      supported: environments.autoSettleOptOutEnvironmentIds.has(environmentId),
      enabled: thread.autoSettleDisabledAt == null,
    },
    titleRegeneration: {
      supported: environments.titleRegenerationEnvironmentIds.has(environmentId),
      regenerating: thread.titleRegeneration != null,
    },
    canHandoff: canHandoffThread(thread),
    turnIntoProject: canTurnIntoProject ? { archivable: threadCanArchive(thread.runtime) } : null,
    snoozePresetActions: buildSnoozePresetActions(snoozePresets),
    assistant: assistantEntry
      ? {
          name: assistantEntry.assistant.name,
          resetDisabled: !threadCanArchive(thread.runtime) || !assistantFlows.canAct,
        }
      : null,
  });
  const onAction = (event: string) =>
    runThreadMenuEvent(
      event,
      {
        newThreadOnBranch: () =>
          selectDetail({
            name: "Thread",
            params: {
              draft: {
                requestId: uuidv4(),
                environmentId: String(thread.environmentId),
                projectId: String(thread.projectId),
                branch: thread.branch,
                worktreePath: thread.worktreePath,
              },
            },
          }),
        copyThread: () => copyThreadMenuReference(thread),
        copyThreadId: () => copyTextWithHaptic(thread.id, { target: "thread-id" }),
        settle: () => void actions.settleThread(thread),
        unsettle: () => void actions.unsettleThread(thread),
        unsnooze: () => void actions.unsnoozeThread(thread),
        pin: () => void actions.pinThread(thread),
        unpin: () => void actions.unpinThread(thread),
        setAutoSettle: (enabled) => void actions.setThreadAutoSettle(thread, enabled),
        archive: () => void actions.archiveThread(thread),
        rename: () => actions.renameThread(thread),
        regenerateTitle: () => void actions.regenerateThreadTitle(thread),
        handoff: () => openThreadHandoff(thread),
        turnIntoProject: () => void turnThreadIntoProject(thread),
        resetAssistant: () => {
          if (assistantEntry) {
            assistantFlows.reset(assistantEntry.assistant, { openAfter: true });
          }
        },
        assistantSettings: () => {
          if (assistantEntry) openAssistantEditor(environmentId, assistantEntry.assistant);
        },
        delete: () => actions.confirmDeleteThread(thread),
        openCustomSnooze: () => setCustomSnoozeOpen(true),
        snooze: (snoozedUntil) => void actions.snoozeThread(thread, snoozedUntil),
        snoozeExpired: () =>
          Dialog.alert(
            "Could not snooze thread",
            "That snooze time has passed. Choose another time.",
          ),
      },
      {
        displayedPresets: snoozePresets,
        now: new Date(nowMinuteMs),
        presets: snoozePresetSettings,
      },
    );

  return {
    items: menuActionsToAppBarItems(menuActions, onAction),
    customSnoozeSheet: customSnoozeOpen ? (
      <CustomSnoozeSheet
        onClose={() => setCustomSnoozeOpen(false)}
        onSnooze={(snoozedUntil) => void actions.snoozeThread(thread, snoozedUntil)}
      />
    ) : null,
  };
}
