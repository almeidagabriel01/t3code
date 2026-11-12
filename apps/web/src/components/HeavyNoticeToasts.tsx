import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { unseenHeavyNotices } from "@t3tools/client-runtime/state/heavyQueue";
import type { EnvironmentId, HeavyNotice, HeavyNoticeBatch, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironments } from "../state/environments";
import { heavyQueueEnvironment, resourceManagerOpenAtom } from "../state/heavyQueue";
import { hasDesktopNotifications } from "../threadNotifications";
import { isStatusBarItemShown, STATUS_BAR_RESOURCE_ITEM } from "./statusBar/statusBarItems.logic";
import { toastManager } from "./ui/toast";

const EMPTY: HeavyNoticeBatch = [];
/** Shared by every environment: two servers on one Mac send the same notice under one id. */
const shown = new Map<string, string>();
const toasts = new Map<string, string>();

export function HeavyNoticeToasts() {
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <EnvironmentHeavyNotices
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ));
}

function EnvironmentHeavyNotices({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const batch = AsyncResult.getOrElse(
    useAtomValue(heavyQueueEnvironment.notices({ environmentId, input: {} })),
    () => EMPTY,
  );
  const navigate = useNavigate();
  const openResourceManager = useAtomSet(resourceManagerOpenAtom);
  const hiddenItems = useClientSettings((settings) => settings.statusBarHiddenItems);
  const resourceManagerShown = isStatusBarItemShown(hiddenItems, STATUS_BAR_RESOURCE_ITEM);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shows each server notice once in the imperative toastManager and, when unfocused, as a desktop notification
  useEffect(() => {
    const open = (notice: HeavyNotice) => {
      if (notice.threadId !== null) {
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: notice.threadId as ThreadId },
        });
      } else if (resourceManagerShown) openResourceManager(true);
      else void navigate({ to: "/settings/maintenance" });
    };
    for (const notice of unseenHeavyNotices(batch, shown)) present(notice, () => open(notice));
  }, [batch, environmentId, navigate, openResourceManager, resourceManagerShown]);

  return null;
}

function present(notice: HeavyNotice, open: () => void) {
  const actionLabel = notice.threadId === null ? "Resource Manager" : "Open thread";
  const options = {
    type: notice.tone,
    title: notice.title,
    description: notice.description,
    ...(notice.tone === "info" ? {} : { timeout: 15_000 }),
    actionProps: {
      children: actionLabel,
      onClick: () => {
        const toastId = toasts.get(notice.id);
        if (toastId !== undefined) toastManager.close(toastId);
        open();
      },
    },
    data: { hideCopyButton: notice.tone === "info" },
    onRemove: () => toasts.delete(notice.id),
  };
  const current = toasts.get(notice.id);
  if (current === undefined) toasts.set(notice.id, toastManager.add(options));
  else toastManager.update(current, options);

  const focused = document.visibilityState === "visible" && document.hasFocus();
  if (
    focused ||
    notice.tone === "info" ||
    !hasDesktopNotifications(getClientSettings().notificationMode) ||
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  try {
    const notification = new Notification(notice.title, {
      body: notice.description,
      tag: `heavy:${notice.id}`,
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
