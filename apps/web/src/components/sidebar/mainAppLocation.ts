import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useRouter, type AnyRouter } from "@tanstack/react-router";
import type { MouseEvent } from "react";

import { GUEST_PAGE_PATH } from "../../guestPage";
import { withoutAssistantCitationHash } from "../../lib/assistantCitationNavigation";
import { buildThreadRouteParams } from "../../threadRoutes";

/** Settings and Usage are not main-app views: closing them returns to the last one. */
export function isAppModalPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/usage";
}

/** Settings is a page in the main area; Usage is still a modal over the last view. */
export function isSettingsPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname.startsWith("/projects/") ||
    pathname === "/pull-requests" ||
    pathname === "/kanban" ||
    pathname === "/activity"
  );
}

// Pages the root route always renders without the app shell, so they are never
// a page to return to. Other paths seen before auth or on a prompt-link landing
// are still recorded; they are real app URLs, so returning to one is harmless.
const SHELL_LESS_PATHS = new Set(["/pair", "/connect", "/connect-agent", GUEST_PAGE_PATH]);

let mainAppHref: string | null = null;
let appModalReturnHref: string | null = null;

/** Remembers where Settings, Usage, and the utility pages lead back to. */
export function startMainAppLocationTracking(router: AnyRouter): () => void {
  const record = () => {
    const { pathname } = router.state.location;
    if (isAppModalPage(pathname) || SHELL_LESS_PATHS.has(pathname)) return;
    const href = withoutAssistantCitationHash(router.state.location.href);
    appModalReturnHref = href;
    if (!isSidebarUtilityPage(pathname)) mainAppHref = href;
  };
  record();
  return router.subscribe("onResolved", record);
}

export function getMainAppHref() {
  return mainAppHref ?? "/";
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: getMainAppHref() });
}

/** A conversation shown inside another page (Activity) is the one Home and Back return to. */
export function useRememberThreadAsMainApp() {
  const router = useRouter();
  return (threadRef: ScopedThreadRef) => {
    mainAppHref = router.buildLocation({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    }).href;
  };
}

/** Home returns to the remembered conversation; with none remembered, or already home, the link's own `/` applies. */
export function useHomeLinkClick(atHome: boolean) {
  const navigateToMainApp = useNavigateToMainApp();
  return (event: MouseEvent) => {
    if (atHome || mainAppHref === null) return;
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void navigateToMainApp();
  };
}

/** Leaves Settings or Usage for the page that opened it. */
export function useCloseAppModal() {
  const navigate = useNavigate();
  return () => navigate({ href: appModalReturnHref ?? mainAppHref ?? "/" });
}
