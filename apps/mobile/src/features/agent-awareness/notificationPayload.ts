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

function normalizeDeepLink(value: string): string | null {
  if (
    value.trim() !== value ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }

  const parts = value.split("/");
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
        : `/assistant-groups/${encodeURIComponent(environmentId)}/${encodeURIComponent(id)}`;
    }
    return encodeThreadDeepLink({ environmentId, threadId: id });
  } catch {
    return null;
  }
}

export function threadDeepLinkOnScreen(pathname: string): string | null {
  const match = /^\/(threads|assistant-groups)\/([^/]+)\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match?.[2] || !match[3]) {
    return null;
  }
  return `/${match[1]}/${match[2]}/${match[3]}`;
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
