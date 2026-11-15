function dataFromNotificationResponse(response: unknown): Record<string, unknown> | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const notification = (response as { readonly notification?: unknown }).notification;
  if (typeof notification !== "object" || notification === null) {
    return null;
  }
  const request = (notification as { readonly request?: unknown }).request;
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const content = (request as { readonly content?: unknown }).content;
  if (typeof content !== "object" || content === null) {
    return null;
  }
  const data = (content as { readonly data?: unknown }).data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

function identifierFromNotificationResponse(response: unknown): string | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const notification = (response as { readonly notification?: unknown }).notification;
  if (typeof notification !== "object" || notification === null) {
    return null;
  }
  const request = (notification as { readonly request?: unknown }).request;
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const identifier = (request as { readonly identifier?: unknown }).identifier;
  return typeof identifier === "string" ? identifier : null;
}

function encodeThreadDeepLink(input: {
  readonly environmentId: string;
  readonly threadId: string;
}): string | null {
  if (input.environmentId.length === 0 || input.threadId.length === 0) {
    return null;
  }
  try {
    return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
  } catch {
    return null;
  }
}

/** A group chat's link, opened on `tab`; none or All is the bare chat, which shows every tab. */
export function assistantGroupDeepLink(path: string, tab: string | null): string {
  return tab === null || tab === "all" ? path : `${path}?tab=${encodeURIComponent(tab)}`;
}

/**
 * The screen at `onScreen` already shows `target`: the same link, or one of its tabs when the
 * screen names none (a thread, or a group chat on All). The Android module keeps the same rule.
 */
export function deepLinkShows(onScreen: string | null, target: string | null): boolean {
  if (onScreen === null || target === null) return false;
  return target === onScreen || (!onScreen.includes("?") && target.split("?")[0] === onScreen);
}

function normalizeDeepLink(value: string): string | null {
  // A group chat's link may name its tab; nothing else carries a query.
  const [path = "", query, ...rest] = value.split("?");
  const tab = query?.startsWith("tab=") ? query.slice("tab=".length) : undefined;
  if (
    value.trim() !== value ||
    value.startsWith("//") ||
    rest.length > 0 ||
    (query !== undefined && (tab === undefined || tab === "" || tab.includes("&"))) ||
    value.includes("#")
  ) {
    return null;
  }

  const parts = path.split("/");
  if (
    parts.length !== 4 ||
    parts[0] !== "" ||
    (parts[1] !== "threads" && parts[1] !== "assistant-groups")
  ) {
    return null;
  }

  try {
    const environmentId = decodeURIComponent(parts[2] ?? "");
    const id = decodeURIComponent(parts[3] ?? "");
    if (parts[1] === "assistant-groups") {
      return environmentId.length === 0 || id.length === 0
        ? null
        : assistantGroupDeepLink(
            `/assistant-groups/${encodeURIComponent(environmentId)}/${encodeURIComponent(id)}`,
            tab === undefined ? null : decodeURIComponent(tab),
          );
    }
    if (tab !== undefined) return null;
    return encodeThreadDeepLink({ environmentId, threadId: id });
  } catch {
    return null;
  }
}

/** The push link of the screen at `pathname`, escaped as pushes are (the router leaves `:` bare). */
export function threadDeepLinkOnScreen(pathname: string): string | null {
  const match = /^\/(threads|assistant-groups)\/([^/?]+)\/([^/?]+)(?:[/?]|$)/.exec(pathname);
  if (!match?.[2] || !match[3]) {
    return null;
  }
  try {
    const [environmentId, id] = [match[2], match[3]].map(decodeURIComponent);
    return `/${match[1]}/${encodeURIComponent(environmentId!)}/${encodeURIComponent(id!)}`;
  } catch {
    return null;
  }
}

export function extractAgentNotificationDeepLink(response: unknown): string | null {
  const data = dataFromNotificationResponse(response);
  const deepLink = data?.deepLink;
  if (typeof deepLink === "string") {
    const normalizedDeepLink = normalizeDeepLink(deepLink);
    if (normalizedDeepLink) {
      return normalizedDeepLink;
    }
  }

  const environmentId = data?.environmentId;
  const threadId = data?.threadId;
  if (typeof environmentId === "string" && typeof threadId === "string") {
    return encodeThreadDeepLink({ environmentId, threadId });
  }
  return null;
}

export function routeAgentNotificationResponseOnce(input: {
  readonly handledResponseIds: Set<string>;
  readonly response: unknown;
  readonly navigate: (deepLink: string) => void;
}): void {
  const responseId = identifierFromNotificationResponse(input.response);
  if (responseId && input.handledResponseIds.has(responseId)) {
    return;
  }
  const deepLink = extractAgentNotificationDeepLink(input.response);
  if (deepLink) {
    input.navigate(deepLink);
  }
  if (responseId) {
    input.handledResponseIds.add(responseId);
  }
}
