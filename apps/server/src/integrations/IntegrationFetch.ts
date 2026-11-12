// @effect-diagnostics nodeBuiltinImport:off - Effect has no DNS lookup or connect-time address pinning.
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Undici from "undici";

import { isLocal } from "../htmlRender/publicProxy.ts";

/** Thrown, never a TypeError: the MCP SDK swallows TypeErrors as CORS failures. */
// @effect-diagnostics-next-line extendsNativeError:off - it must cross the SDK's Promise boundary as a plain Error.
export class UnsafeAddressError extends Error {
  override readonly name = "UnsafeAddressError";
}

export type IntegrationFetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;
type Resolve = (host: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

/** Every request integration sign-in makes to an outside service (discovery, registration, tokens). */
export class IntegrationFetch extends Context.Service<
  IntegrationFetch,
  { readonly fetch: IntegrationFetchFn }
>()("t3/integrations/IntegrationFetch") {}

const resolveHost: Resolve = (host) =>
  NodeDnsPromises.lookup(host, { all: true, verbatim: true }).catch(() => []);

const MAX_REDIRECTS = 5;
const bareHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");

const assertPublicAddresses = async (host: string, resolve: Resolve) => {
  const family = NodeNet.isIP(host);
  const addresses = family === 0 ? await resolve(host) : [{ address: host, family }];
  if (addresses.length === 0 || addresses.some((entry) => isLocal(entry.address, entry.family))) {
    throw new UnsafeAddressError("Integration sign-in address is not public.");
  }
  return addresses;
};

/** A `net.connect` lookup that refuses local answers, so DNS rebinding after the check can't reach them. */
export const checkedLookup =
  (resolve: Resolve) =>
  (
    hostname: string,
    options: { readonly all?: boolean },
    callback: (
      error: Error | null,
      address: string | ReadonlyArray<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ) => {
    assertPublicAddresses(hostname, resolve).then(
      (addresses) =>
        options.all
          ? callback(null, addresses)
          : callback(null, addresses[0]!.address, addresses[0]!.family),
      (error: Error) => callback(error, ""),
    );
  };

/**
 * https only, public addresses only, and every redirect hop checked again. `send` performs one
 * request without following redirects.
 */
export const makeGuardedFetch =
  (send: IntegrationFetchFn, resolve: Resolve = resolveHost): IntegrationFetchFn =>
  async (input, init) => {
    let url = new URL(input);
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new UnsafeAddressError("Integration sign-in address is not https.");
      }
      await assertPublicAddresses(bareHost(url), resolve);
      const response = await send(url, { ...init, redirect: "manual" });
      const location = response.headers.get("location");
      // The SDK follows its own same-origin redirects and asks for "manual"; give it the 3xx.
      // A POST carries codes, tokens or a client secret, so it is never re-sent elsewhere.
      const method = init?.method?.toUpperCase() ?? "GET";
      if (
        init?.redirect === "manual" ||
        (method !== "GET" && method !== "HEAD") ||
        response.status < 300 ||
        response.status >= 400
      ) {
        return response;
      }
      if (location === null || hop >= MAX_REDIRECTS) return response;
      url = new URL(location, url);
    }
  };

// undici is external to the CLI bundle; Node single-executables can load it from disk only with require.
const requireUndici = NodeModule.createRequire(import.meta.url);

const undiciSend = (): IntegrationFetchFn => {
  const undici = requireUndici("undici") as typeof Undici;
  const dispatcher = new undici.Agent({
    // Node's lookup overloads don't narrow to one callback shape; this one answers both.
    connect: { lookup: checkedLookup(resolveHost) as unknown as NodeNet.LookupFunction },
  });
  return async (url, init) => {
    try {
      return (await undici.fetch(url, {
        ...(init as unknown as Undici.RequestInit),
        dispatcher,
      })) as unknown as Response;
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      throw cause instanceof UnsafeAddressError ? cause : error;
    }
  };
};

export const layer = Layer.sync(IntegrationFetch, () =>
  IntegrationFetch.of({ fetch: makeGuardedFetch(undiciSend()) }),
);
