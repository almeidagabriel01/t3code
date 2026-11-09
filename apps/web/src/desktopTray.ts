import {
  DESKTOP_TRAY_OPEN_THREAD_ACTION_PREFIX,
  EnvironmentId,
  isAssistantThreadId,
  ThreadId,
  type DesktopTrayMenu,
  type DesktopTrayThread,
} from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { resolveSidebarThreadStatus } from "@t3tools/client-runtime/state/thread-attention";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import type { AnyRouter } from "@tanstack/react-router";
import type { AtomRegistry } from "effect/reactivity";

import {
  getClientSettings,
  isClientSettingsHydrated,
  subscribeClientSettings,
  subscribeClientSettingsHydration,
} from "./hooks/useSettings";
import { environmentSummaries } from "./state/presentation";
import { environmentProjects } from "./state/projects";
import { liveShellEnvironmentIdsAtom } from "./state/shell";
import { environmentThreadShells } from "./state/threads";

// Main shows a handful per section; the cap keeps the IPC payload small however many threads exist.
const SECTION_LIMIT = 20;
const TEXT_LIMIT = 200;

const bounded = (text: string) => Array.from(text).slice(0, TEXT_LIMIT).join("");

type TrayShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "runtime"
  | "blockedOnThreadWait"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "archivedAt"
  | "sideChatOf"
  | "pinnedAt"
  | "pinOrderKey"
  | "createdAt"
  | "updatedAt"
>;

const newestFirst = (left: TrayShell, right: TrayShell) =>
  right.updatedAt.localeCompare(left.updatedAt);

/**
 * Needs-you and running follow the sidebar status, and only for environments whose shells are
 * live (a cached shell may describe a run that already ended). A thread lands in one section.
 * `environmentLabels` is null when only one environment exists, so labels stay out of the rows.
 */
export function deriveTrayMenu(
  threads: ReadonlyArray<TrayShell>,
  projects: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id" | "title">>,
  liveEnvironmentIds: ReadonlySet<EnvironmentId>,
  environmentLabels: ReadonlyMap<EnvironmentId, string> | null,
): DesktopTrayMenu {
  const projectTitles = new Map(
    projects.map((project) => [`${project.environmentId}\u0000${project.id}`, project.title]),
  );
  const row = (thread: TrayShell): DesktopTrayThread => ({
    environmentId: thread.environmentId,
    threadId: thread.id,
    title: bounded(thread.title),
    project:
      bounded(projectTitles.get(`${thread.environmentId}\u0000${thread.projectId}`) ?? "") || null,
    environment: environmentLabels?.get(thread.environmentId) ?? null,
  });
  const attention: TrayShell[] = [];
  const running: TrayShell[] = [];
  const pinned: TrayShell[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.sideChatOf != null || isAssistantThreadId(thread.id)) {
      continue;
    }
    const status = liveEnvironmentIds.has(thread.environmentId)
      ? resolveSidebarThreadStatus(thread)
      : null;
    if (status === "approval" || status === "input" || status === "request") {
      attention.push(thread);
    } else if (status === "working") {
      running.push(thread);
    } else if (thread.pinnedAt !== null) {
      pinned.push(thread);
    }
  }
  return {
    attention: attention.toSorted(newestFirst).slice(0, SECTION_LIMIT).map(row),
    running: running.toSorted(newestFirst).slice(0, SECTION_LIMIT).map(row),
    pinned: sortPinnedThreadsByOrderKey(pinned).slice(0, SECTION_LIMIT).map(row),
    attentionCount: attention.length,
  };
}

/** The thread a tray row asked to open, or null for any other action or a malformed one. */
export function parseTrayOpenThreadAction(
  action: string,
): { environmentId: string; threadId: string } | null {
  if (!action.startsWith(DESKTOP_TRAY_OPEN_THREAD_ACTION_PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(action.slice(DESKTOP_TRAY_OPEN_THREAD_ACTION_PREFIX.length));
    if (typeof value !== "object" || value === null) return null;
    const { environmentId, threadId } = value as Record<string, unknown>;
    return typeof environmentId === "string" && typeof threadId === "string"
      ? { environmentId, threadId }
      : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the menu-bar icon in step with this window's threads while "Show in menu bar" is on, and
 * opens the threads its rows pick. The new-thread action is answered where new threads start.
 */
export function startDesktopTray(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const bridge = window.desktopBridge;
  if (bridge === undefined || bridge.getClientPlatform() !== "darwin") return () => {};

  let sent: string | null = null;
  let scheduled = false;
  // Several atoms settle in one burst when an environment connects; send once for all of them.
  const publish = () => {
    scheduled = false;
    // Until the saved choice is read, a user who turned the icon off would see it flash.
    if (!isClientSettingsHydrated()) return;
    const menu = getClientSettings().showInMenuBar ? currentMenu() : null;
    const key = JSON.stringify(menu);
    if (key === sent) return;
    sent = key;
    void bridge.setTrayMenu(menu).catch(() => {
      sent = null;
    });
  };
  const currentMenu = () => {
    const identities = registry.get(environmentSummaries.identitiesAtom);
    return deriveTrayMenu(
      registry.get(environmentThreadShells.quietThreadShellsAtom),
      registry.get(environmentProjects.projectsAtom),
      registry.get(liveShellEnvironmentIdsAtom),
      identities.length > 1
        ? new Map(identities.map(({ environmentId, label }) => [environmentId, label]))
        : null,
    );
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(publish);
  };

  const unsubscribes = [
    registry.subscribe(environmentThreadShells.quietThreadShellsAtom, schedule),
    registry.subscribe(environmentProjects.projectsAtom, schedule),
    registry.subscribe(liveShellEnvironmentIdsAtom, schedule),
    registry.subscribe(environmentSummaries.identitiesAtom, schedule),
    subscribeClientSettings(schedule),
    subscribeClientSettingsHydration(schedule),
    // Subscribed before the first publish: main delivers a pick only to a renderer that has published.
    bridge.onMenuAction((action) => {
      const target = parseTrayOpenThreadAction(action);
      if (target === null) return;
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: EnvironmentId.make(target.environmentId),
          threadId: ThreadId.make(target.threadId),
        },
      });
    }),
  ];
  schedule();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
