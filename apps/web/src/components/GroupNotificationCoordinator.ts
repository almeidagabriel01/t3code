import { assistantGroupFinished } from "@t3tools/client-runtime/assistantGroupChat";
import type { AssistantTeam, AssistantTeamId, EnvironmentId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import type { AtomRegistry } from "effect/reactivity";

import { getClientSettings } from "../hooks/useSettings";
import { assistantTeamEntriesAtom, type AssistantTeamEntry } from "../state/assistants";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../threadNotifications";
import { toastManager } from "./ui/toast";

type Notice = { readonly title: string; readonly body: string };

/** Remembers each group between updates and reports the ones whose work just finished. */
export function createGroupFinishedObserver(
  report: (environmentId: EnvironmentId, teamId: AssistantTeamId, notice: Notice) => void,
) {
  const previous = new Map<string, AssistantTeam>();
  return (entries: ReadonlyArray<AssistantTeamEntry>) => {
    const seen = new Set<string>();
    for (const { environmentId, team } of entries) {
      const key = `${environmentId}:${team.id}`;
      seen.add(key);
      const finished = assistantGroupFinished(previous.get(key), team);
      previous.set(key, team);
      if (finished !== null) report(environmentId, team.id, finished);
    }
    for (const key of previous.keys()) if (!seen.has(key)) previous.delete(key);
  };
}

/**
 * Tells the user when a group has finished the work of a request, the way a finished thread
 * does and under the same notification settings, unless they are looking at that chat.
 */
export function startGroupNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const observe = createGroupFinishedObserver((environmentId, teamId, notice) =>
    presentGroupFinished(router, environmentId, teamId, notice),
  );
  return registry.subscribe(assistantTeamEntriesAtom, observe, { immediate: true });
}

export function presentGroupFinished(
  router: Pick<AnyRouter, "state" | "navigate">,
  environmentId: EnvironmentId,
  teamId: AssistantTeamId,
  notice: Notice,
) {
  const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
  const active = (router.state.matches.at(-1)?.params ?? {}) as {
    environmentId?: string;
    teamId?: string;
  };
  const focused = document.visibilityState === "visible" && document.hasFocus();
  const chatOpen = active.environmentId === environmentId && active.teamId === teamId;
  if (chatOpen && focused) return;
  const open = () =>
    void router.navigate({
      to: "/group/$environmentId/$teamId",
      params: { environmentId, teamId },
    });
  if (hasNotificationSound(mode)) {
    void playNotificationSound("completion", () =>
      hasNotificationSound(getClientSettings().notificationMode),
    );
  }
  if (inAppNotificationsEnabled && focused) {
    const toastId = toastManager.add({
      type: "success",
      title: notice.title,
      description: notice.body,
      data: { hideCopyButton: true },
      actionProps: {
        children: "Open chat",
        onClick: () => {
          toastManager.close(toastId);
          open();
        },
      },
    });
    return;
  }
  if (
    !hasDesktopNotifications(mode) ||
    focused ||
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  try {
    const notification = new Notification(notice.title, {
      body: notice.body,
      tag: `group:${environmentId}:${teamId}`,
      silent: true,
    });
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
      void window.desktopBridge?.revealWindow().catch(() => undefined);
      open();
    });
  } catch {
    // Some browsers expose Notification but reject desktop presentation.
  }
}
