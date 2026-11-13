// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native loopback helper uses a bounded Node listener with AbortController cleanup.
import { INTEGRATIONS_LOOPBACK_CALLBACK_PATH } from "@t3tools/contracts";
import type { DesktopIntegrationCallbackResult } from "@t3tools/contracts";
import { AUTH_CALLBACK_PAGE } from "@t3tools/shared/codexAuthCallback";
import * as NodeHttp from "node:http";

const SIGN_IN_CEILING_MS = 600_000;

let active: AbortController | null = null;

export function cancelIntegrationCallback() {
  active?.abort();
}

/**
 * Waits on this computer's loopback redirect for one integration sign-in, opening the browser only
 * once the port is bound. A new sign-in supersedes the previous one; the server checks the code.
 */
export async function receiveIntegrationCallback(
  input: { readonly authorizationUrl: string; readonly redirectUri: string },
  openBrowser: (url: string) => Promise<boolean>,
): Promise<DesktopIntegrationCallbackResult> {
  const redirect = new URL(input.redirectUri);
  const authorization = new URL(input.authorizationUrl);
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    redirect.port === "" ||
    redirect.pathname !== INTEGRATIONS_LOOPBACK_CALLBACK_PATH ||
    (authorization.protocol !== "https:" && authorization.protocol !== "http:")
  ) {
    return { status: "failed" };
  }
  const state = authorization.searchParams.get("state");
  active?.abort();
  const abort = new AbortController();
  active = abort;
  const done = Promise.withResolvers<DesktopIntegrationCallbackResult>();
  const server = NodeHttp.createServer((incoming, response) => {
    const url = new URL(incoming.url ?? "/", redirect);
    const params = url.searchParams;
    if (
      incoming.method !== "GET" ||
      url.pathname !== redirect.pathname ||
      !(params.has("code") || params.has("error")) ||
      (state !== null && params.get("state") !== state)
    ) {
      response.writeHead(400).end("This response does not belong to the active sign-in.");
      return;
    }
    response
      .writeHead(200, {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "content-type": "text/html; charset=utf-8",
      })
      .end(AUTH_CALLBACK_PAGE);
    done.resolve({ status: "received", callbackUrl: url.href });
  });
  const cancelled = () => done.resolve({ status: "cancelled" });
  abort.signal.addEventListener("abort", cancelled, { once: true });
  const timer = setTimeout(() => done.resolve({ status: "expired" }), SIGN_IN_CEILING_MS);
  timer.unref();
  try {
    const bound = await new Promise<"ok" | "busy" | "failed">((resolve) => {
      server.once("error", (error: NodeJS.ErrnoException) =>
        resolve(error.code === "EADDRINUSE" ? "busy" : "failed"),
      );
      server.listen(Number(redirect.port), "127.0.0.1", () => resolve("ok"));
    });
    if (bound === "busy") return { status: "port-busy" };
    if (bound === "failed") return { status: "failed" };
    if (abort.signal.aborted) return { status: "cancelled" };
    if (!(await openBrowser(authorization.href))) return { status: "failed" };
    return await done.promise;
  } finally {
    clearTimeout(timer);
    abort.signal.removeEventListener("abort", cancelled);
    if (active === abort) active = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
