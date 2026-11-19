import { parsePastedCallback } from "@t3tools/client-runtime/integrations";
import type {
  EnvironmentId,
  IntegrationBeginConnectInput,
  IntegrationBeginConnectResult,
} from "@t3tools/contracts";
import Constants from "expo-constants";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import type { IntegrationReply } from "../../state/integrations";

export type ReturnScheme = NonNullable<IntegrationBeginConnectInput["client"]["returnScheme"]>;

/** The scheme this build registers, so the sign-in sheet returns to this app and not another variant. */
export function appReturnScheme(): ReturnScheme {
  const configured = Constants.expoConfig?.scheme;
  const scheme = Array.isArray(configured) ? configured[0] : configured;
  return scheme === "t3code-dev" || scheme === "t3code-preview" ? scheme : "t3code";
}

export interface PendingFlow {
  readonly environmentId: EnvironmentId;
  readonly catalogId: string;
  readonly flowId: string;
  readonly name: string;
  readonly mode: IntegrationBeginConnectResult["mode"];
  readonly authorizationUrl: string;
  /** Set once a pushed state showed it connecting, so a later status ends it. */
  readonly seenConnecting?: boolean;
}

const flowKey = (environmentId: EnvironmentId, name: string) => `${environmentId}\u0000${name}`;

/** Sign-ins this app started, for the paste step and to close the auth sheet when they end. */
export const pendingFlowsAtom = Atom.make<ReadonlyMap<string, PendingFlow>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-integration-flows"),
);

export const pendingFlowFor = (
  flows: ReadonlyMap<string, PendingFlow>,
  environmentId: EnvironmentId,
  name: string,
): PendingFlow | null => flows.get(flowKey(environmentId, name)) ?? null;

function setPending(flow: PendingFlow, present: boolean) {
  const next = new Map(appAtomRegistry.get(pendingFlowsAtom));
  if (present) next.set(flowKey(flow.environmentId, flow.name), flow);
  else next.delete(flowKey(flow.environmentId, flow.name));
  appAtomRegistry.set(pendingFlowsAtom, next);
}

export interface ConnectDeps {
  readonly environmentId: EnvironmentId;
  readonly scheme: ReturnScheme;
  readonly begin: (
    input: IntegrationBeginConnectInput,
  ) => Promise<IntegrationReply<IntegrationBeginConnectResult>>;
  readonly complete: (input: {
    readonly flowId: string;
    readonly callbackUrl: string;
  }) => Promise<IntegrationReply<unknown>>;
  readonly cancel: (name: string) => Promise<IntegrationReply<unknown>>;
  readonly openAuthSession: (
    url: string,
    returnUrl: string,
  ) => Promise<{ readonly type: string; readonly url?: string }>;
  readonly openBrowser: (url: string) => Promise<unknown>;
  /** Resolves with the HTTP base URL once the socket is up (Android drops it behind the browser). */
  readonly waitForConnection: () => Promise<string | null>;
}

export type ConnectOutcome =
  | { readonly kind: "connected"; readonly name: string }
  /** `reason` null: the server already recorded why on the integration. */
  | { readonly kind: "failed"; readonly reason: string | null }
  | { readonly kind: "paste"; readonly flow: PendingFlow }
  | { readonly kind: "cancelled" }
  /** A pushed state ended it first (connected, failed, expired or cancelled elsewhere). */
  | { readonly kind: "ended" };

const originOf = (baseUrl: string | null) => {
  if (baseUrl === null || !URL.canParse(baseUrl)) return {};
  return { origin: new URL(baseUrl).origin };
};

/** The server picks the callback from the origin; the client only follows the mode it returns. */
export async function startConnect(catalogId: string, deps: ConnectDeps): Promise<ConnectOutcome> {
  const begun = await deps.begin({
    catalogId,
    client: {
      kind: "mobile",
      ...originOf(await deps.waitForConnection()),
      returnScheme: deps.scheme,
    },
  });
  if (!begun.ok) return { kind: "failed", reason: begun.reason };
  const flow: PendingFlow = {
    environmentId: deps.environmentId,
    catalogId,
    flowId: begun.value.flowId,
    name: begun.value.name,
    mode: begun.value.mode,
    authorizationUrl: begun.value.authorizationUrl,
  };
  setPending(flow, true);
  if (flow.mode !== "server") {
    await deps.openBrowser(flow.authorizationUrl);
    return { kind: "paste", flow };
  }
  const session = await deps.openAuthSession(
    flow.authorizationUrl,
    `${deps.scheme}://integrations/done`,
  );
  if (session.type === "success" && session.url !== undefined && URL.canParse(session.url)) {
    setPending(flow, false);
    return new URL(session.url).searchParams.get("result") === "connected"
      ? { kind: "connected", name: flow.name }
      : { kind: "failed", reason: null };
  }
  if (
    pendingFlowFor(appAtomRegistry.get(pendingFlowsAtom), flow.environmentId, flow.name) === null
  ) {
    return { kind: "ended" };
  }
  return cancelConnect(flow.environmentId, flow.name, deps);
}

/** By name, so a sign-in started on any device can be cancelled from here. */
export async function cancelConnect(
  environmentId: EnvironmentId,
  name: string,
  deps: Pick<ConnectDeps, "cancel" | "waitForConnection">,
): Promise<ConnectOutcome> {
  await deps.waitForConnection();
  await deps.cancel(name);
  const flow = pendingFlowFor(appAtomRegistry.get(pendingFlowsAtom), environmentId, name);
  if (flow !== null) setPending(flow, false);
  return { kind: "cancelled" };
}

/**
 * Forgets this device's sign-ins whose pushed status left "connecting" and returns them, so
 * the caller can close the auth sheet or paste step they still show.
 */
export function endPushedFlows(
  environmentId: EnvironmentId,
  statusOf: (name: string) => string | undefined,
): ReadonlyArray<PendingFlow> {
  const flows = appAtomRegistry.get(pendingFlowsAtom);
  const next = new Map(flows);
  const ended: PendingFlow[] = [];
  let changed = false;
  for (const [key, flow] of flows) {
    if (flow.environmentId !== environmentId) continue;
    const connecting = statusOf(flow.name) === "connecting";
    if (connecting && !flow.seenConnecting) {
      next.set(key, { ...flow, seenConnecting: true });
      changed = true;
    } else if (!connecting && flow.seenConnecting) {
      next.delete(key);
      ended.push(flow);
      changed = true;
    }
  }
  if (changed) appAtomRegistry.set(pendingFlowsAtom, next);
  return ended;
}

/** `invalid-callback` when the text is not an address carrying the sign-in answer. */
export async function completePastedConnect(
  flow: PendingFlow,
  text: string,
  deps: Pick<ConnectDeps, "complete" | "waitForConnection">,
): Promise<IntegrationReply> {
  const callbackUrl = parsePastedCallback(text);
  if (callbackUrl === null) return { ok: false, reason: "invalid-callback" };
  await deps.waitForConnection();
  const done = await deps.complete({ flowId: flow.flowId, callbackUrl });
  if (!done.ok) return done;
  setPending(flow, false);
  return { ok: true, value: undefined };
}
