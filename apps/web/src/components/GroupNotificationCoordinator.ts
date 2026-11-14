import {
  assistantGroupFinished,
  assistantGroupFinishedInView,
  type AssistantGroupFinishedNotice,
} from "@t3tools/client-runtime/assistantGroupChat";
import type { AssistantTeam, AssistantTeamId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import type { AtomRegistry } from "effect/reactivity";

import { writeLocalStorageValue } from "../hooks/useLocalStorage";
import { getClientSettings } from "../hooks/useSettings";
import { assistantTeamEntriesAtom, type AssistantTeamEntry } from "../state/assistants";
import { openGroupTabsAtom, type OpenGroupTab } from "../state/openGroupTabs";
import { environmentProjects } from "../state/projects";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../threadNotifications";
import { groupTabStorageKey, SavedGroupTab } from "./assistants/groupTabStorage";
import { toastManager } from "./ui/toast";

/** Remembers each group between updates and reports the ones whose work just finished. */
export function createGroupFinishedObserver(
  report: (
    environmentId: EnvironmentId,
    teamId: AssistantTeamId,
    notice: AssistantGroupFinishedNotice,
  ) => void,
  projectsOf: (
    environmentId: EnvironmentId,
  ) => ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>,
) {
  const previous = new Map<string, AssistantTeam>();
  return (entries: ReadonlyArray<AssistantTeamEntry>) => {
    const seen = new Set<string>();
    for (const { environmentId, team } of entries) {
      const key = `${environmentId}:${team.id}`;
      seen.add(key);
      const finished = assistantGroupFinished(previous.get(key), team, projectsOf(environmentId));
      previous.set(key, team);
      for (const notice of finished) report(environmentId, team.id, notice);
    }
    for (const key of previous.keys()) if (!seen.has(key)) previous.delete(key);
  };
}

/**
 * Tells the user when a group has finished the work of a request, the way a finished thread
 * does and under the same notification settings, unless they are looking at it in its chat.
 */
export function startGroupNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const observe = createGroupFinishedObserver(
    (environmentId, teamId, notice) =>
      presentGroupFinished(router, environmentId, teamId, notice, [
        ...registry.get(openGroupTabsAtom).values(),
      ]),
    (environmentId) =>
      registry
        .get(environmentProjects.projectsAtom)
        .filter((project) => project.environmentId === environmentId),
  );
  return registry.subscribe(assistantTeamEntriesAtom, observe, { immediate: true });
}

export function presentGroupFinished(
  router: Pick<AnyRouter, "state" | "navigate">,
  environmentId: EnvironmentId,
  teamId: AssistantTeamId,
  notice: AssistantGroupFinishedNotice,
  shown: ReadonlyArray<OpenGroupTab>,
) {
  const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
  const active = (router.state.matches.at(-1)?.params ?? {}) as {
    environmentId?: string;
    teamId?: string;
  };
  const focused = document.visibilityState === "visible" && document.hasFocus();
  const chatOpen = active.environmentId === environmentId && active.teamId === teamId;
  // Every mount of this chat (the route, a side panel) counts: one showing the tab is enough.
  const tabs = shown.flatMap((entry) =>
    entry.environmentId === environmentId && entry.teamId === teamId ? [entry.tab] : [],
  );
  const inView = (tabs.length === 0 ? [null] : tabs).some((tab) =>
    assistantGroupFinishedInView(tab, notice.tab),
  );
  if (chatOpen && focused && inView) return;
  const open = () => {
    writeLocalStorageValue(
      groupTabStorageKey(environmentId, teamId),
      notice.tab,
      null,
      SavedGroupTab,
    );
    void router.navigate({
      to: "/group/$environmentId/$teamId",
      params: { environmentId, teamId },
    });
  };
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
      // Per tab, so two projects finishing together do not replace each other.
      tag: `group:${environmentId}:${teamId}:${notice.tab}`,
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
