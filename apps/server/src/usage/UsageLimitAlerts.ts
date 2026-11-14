// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned hash for slot and send keys.
import * as NodeCrypto from "node:crypto";

import {
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  defaultUsageLimitAlertWindows,
  usageLimitAlertThreshold,
} from "@t3tools/shared/usageLimitAlerts";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AssistantService from "../assistants/AssistantService.ts";
import * as AutonomyService from "../autonomy/AutonomyService.ts";
import * as ChannelLanguage from "../channels/ChannelLanguage.ts";
import { channelStrings, type ResolvedChannelLanguage } from "../channels/channelStrings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { validZone } from "./providerBudget.ts";

/** Rearm only once the remainder climbs this many points over the threshold, so a wobble is quiet. */
const REARM_MARGIN_POINTS = 5;
/** Resets that move by less than this are the same window: providers report them with jitter. */
const RESET_TOLERANCE_MS = 10 * 60_000;
const CHECK_INTERVAL = Duration.minutes(15);
const CHECK_JITTER_SHARE = 0.2;
const MAX_BACKOFF_MS = 4 * 60 * 60_000;

export interface AlertSlot {
  readonly resetsAtMs: number | null;
  readonly armed: boolean;
  /** Counts sends in this slot; part of the send key so a rearm in the same window sends again. */
  readonly episode: number;
  readonly firedThreshold: number | null;
  readonly firedKey: string | null;
  /** Recorded as sent but not yet confirmed by `notifyUser`. */
  readonly pending: boolean;
}

export interface AlertReading {
  /** Remaining percent as Limits shows it, so a "15%" reading sends the 15% alert. */
  readonly remaining: number;
  readonly resetsAtMs: number | null;
}

/** Pure: whether this reading sends, and the slot state to keep. */
export function decideUsageLimitAlert(
  prev: AlertSlot | undefined,
  reading: AlertReading,
  threshold: number,
): { readonly next: AlertSlot; readonly fire: boolean } {
  // A side without a reset (a probe that omitted it) cannot prove a new window.
  const sameWindow =
    prev !== undefined &&
    (prev.resetsAtMs === null ||
      reading.resetsAtMs === null ||
      Math.abs(prev.resetsAtMs - reading.resetsAtMs) <= RESET_TOLERANCE_MS);
  // Capped so a threshold near 100 still rearms on a full window.
  const rearmAt = Math.min(threshold + REARM_MARGIN_POINTS, 100);
  const armed = !sameWindow || prev.armed || reading.remaining >= rearmAt;
  const resetsAtMs = reading.resetsAtMs ?? prev?.resetsAtMs ?? null;
  if (armed && reading.remaining <= threshold) {
    return {
      fire: true,
      next: {
        resetsAtMs,
        armed: false,
        episode: (prev?.episode ?? 0) + 1,
        firedThreshold: threshold,
        firedKey: null,
        pending: true,
      },
    };
  }
  return {
    fire: false,
    next: {
      resetsAtMs,
      armed,
      episode: prev?.episode ?? 0,
      firedThreshold: prev?.firedThreshold ?? null,
      firedKey: armed ? null : (prev?.firedKey ?? null),
      pending: !armed && (prev?.pending ?? false),
    },
  };
}

const serverZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const sameSlot = (left: AlertSlot, right: AlertSlot) =>
  left.resetsAtMs === right.resetsAtMs &&
  left.armed === right.armed &&
  left.episode === right.episode &&
  left.firedThreshold === right.firedThreshold &&
  left.firedKey === right.firedKey &&
  left.pending === right.pending;

const sha = (...parts: ReadonlyArray<string | number | null>) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** Hashed so no email or credential fingerprint is stored; null when the provider reports none. */
function accountIdentity(provider: ServerProvider): string | null {
  const identity =
    provider.auth.email?.trim().toLowerCase() || provider.usageLimits?.credentialFingerprint;
  if (!identity) return null;
  return sha(provider.driver, identity, provider.auth.workspaceId ?? null).slice(0, 32);
}

function alertWindowIds(provider: ServerProvider, settings: ServerSettings): ReadonlySet<string> {
  return new Set([
    ...(provider.usageLimits?.windows.map((window) => window.id) ?? []),
    ...Object.keys(settings.usageLimitAlerts.instances[provider.instanceId]?.windows ?? {}),
    ...defaultUsageLimitAlertWindows(provider.driver),
  ]);
}

/** Mirrors `AutonomyService.notifyUsageLimitAlert`, so a refused send never consumes a slot. */
const canDeliver = (settings: ServerSettings) =>
  settings.autonomy.enabled || settings.usageLimitAlerts.ignoreAutonomyPause;

/** True when the instance has at least one window that would alert. */
function hasUsageLimitAlert(provider: ServerProvider, settings: ServerSettings): boolean {
  if (!provider.enabled) return false;
  const config = settings.usageLimitAlerts.instances[provider.instanceId];
  for (const windowId of alertWindowIds(provider, settings)) {
    if (usageLimitAlertThreshold({ driver: provider.driver, windowId, config }) !== null) {
      return true;
    }
  }
  return false;
}

function formatReset(resetsAtMs: number, nowMs: number, timeZone: string, language: string) {
  const far = resetsAtMs - nowMs > 6 * 24 * 60 * 60_000;
  return new Intl.DateTimeFormat(language, {
    timeZone,
    weekday: "short",
    ...(far ? { day: "numeric", month: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(resetsAtMs);
}

export function usageLimitAlertText(input: {
  readonly provider: ServerProvider;
  readonly account: string | null;
  readonly window: ServerProviderUsageWindow;
  readonly nowMs: number;
  readonly timeZone: string;
  readonly language: ResolvedChannelLanguage;
}): string {
  const { provider, window } = input;
  const resetsAtMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  const [, ...scope] = window.label.split(" · ");
  return channelStrings(input.language).usageLimitLow({
    provider: provider.displayName ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver,
    account: input.account,
    remaining: remainingPercent(window),
    kind: window.kind,
    label: window.label,
    scope: scope.length > 0 ? scope.join(" · ") : null,
    resets: Number.isFinite(resetsAtMs)
      ? formatReset(
          resetsAtMs,
          input.nowMs,
          validZone(input.timeZone, serverZone()),
          input.language,
        )
      : null,
  });
}

interface StateRow {
  readonly resets_at: string | null;
  readonly armed: number;
  readonly episode: number;
  readonly fired_threshold: number | null;
  readonly fired_key: string | null;
  readonly pending: number;
}

const toSlot = (row: StateRow): AlertSlot => {
  const resetsAtMs = row.resets_at === null ? Number.NaN : Date.parse(row.resets_at);
  return {
    resetsAtMs: Number.isFinite(resetsAtMs) ? resetsAtMs : null,
    armed: row.armed === 1,
    episode: row.episode,
    firedThreshold: row.fired_threshold,
    firedKey: row.fired_key,
    pending: row.pending === 1,
  };
};

export class UsageLimitAlerts extends Context.Service<
  UsageLimitAlerts,
  {
    /** Evaluates every alerting window of these snapshots; `retryPending` resends unconfirmed sends. */
    readonly evaluate: (
      providers: ReadonlyArray<ServerProvider>,
      options?: { readonly retryPending?: boolean },
    ) => Effect.Effect<void>;
  }
>()("t3/usage/UsageLimitAlerts") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const settingsService = yield* Settings.ServerSettingsService;
  const autonomy = yield* AutonomyService.AutonomyService;
  const assistants = yield* AssistantService.AssistantService;
  const channelLanguage = yield* ChannelLanguage.ChannelLanguage;
  const lock = yield* Semaphore.make(1);
  // Last reading per slot, so a repeated snapshot costs no query; the database stays the authority.
  const seen = new Map<string, string>();
  // Keeps a slot stable while a probe briefly reports no account identity.
  const lastAccount = new Map<string, string>();
  // The stored account of an instance that reports none, read once; "" when there is none.
  const storedAccount = new Map<string, string>();

  const accountKeyFor = Effect.fn("UsageLimitAlerts.accountKey")(function* (
    provider: ServerProvider,
  ) {
    const identity = accountIdentity(provider);
    if (identity !== null) {
      if (lastAccount.get(provider.instanceId) !== identity) {
        // A slot kept before the probe reported any account belongs to the first one it reports.
        yield* sql`
          UPDATE OR IGNORE usage_limit_alert_state SET account_key = ${identity}
          WHERE instance_id = ${provider.instanceId} AND account_key = ''`;
        lastAccount.set(provider.instanceId, identity);
      }
      return identity;
    }
    const known = lastAccount.get(provider.instanceId) ?? storedAccount.get(provider.instanceId);
    if (known !== undefined) return known;
    const rows = yield* sql<{ readonly account_key: string }>`
      SELECT account_key FROM usage_limit_alert_state WHERE instance_id = ${provider.instanceId}
      ORDER BY updated_at DESC LIMIT 1`;
    const stored = rows[0]?.account_key ?? "";
    storedAccount.set(provider.instanceId, stored);
    return stored;
  });

  const defaultAssistant = sql<{ readonly assistant_id: string }>`
    SELECT assistant_id FROM assistants
    WHERE is_default = 1 AND archived_at IS NULL AND thread_id IS NOT NULL LIMIT 1`.pipe(
    Effect.map((rows) => rows[0]?.assistant_id ?? null),
  );

  const evaluateLocked = Effect.fn("UsageLimitAlerts.evaluate")(function* (
    providers: ReadonlyArray<ServerProvider>,
    retryPending: boolean,
  ) {
    const settings = yield* settingsService.getSettings;
    if (!canDeliver(settings)) return;
    const nowMs = yield* Clock.currentTimeMillis;
    let assistantId: string | null | undefined;
    let language: ResolvedChannelLanguage | undefined;

    for (const provider of providers) {
      if (!hasUsageLimitAlert(provider, settings)) continue;
      if (provider.auth.status === "unauthenticated" || provider.usageLimits === undefined)
        continue;
      const config = settings.usageLimitAlerts.instances[provider.instanceId];
      const accountKey = yield* accountKeyFor(provider);
      const siblings = providers.filter(
        (other) => other.enabled && other.driver === provider.driver,
      ).length;
      const account = siblings > 1 ? (provider.auth.label ?? provider.auth.email ?? null) : null;

      for (const window of provider.usageLimits.windows) {
        const threshold = usageLimitAlertThreshold({
          driver: provider.driver,
          windowId: window.id,
          config,
        });
        if (threshold === null) continue;
        const parsedReset =
          window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
        const resetsAtMs = Number.isFinite(parsedReset) ? parsedReset : null;
        // A retained reading of a window that already turned over says nothing about the new one.
        if (resetsAtMs !== null && resetsAtMs <= nowMs) continue;
        const slotKey = `${provider.instanceId}\u0000${accountKey}\u0000${window.id}`;
        const fingerprint = `${window.usedPercent}|${resetsAtMs}|${threshold}`;
        if (!retryPending && seen.get(slotKey) === fingerprint) continue;

        const rows = yield* sql<StateRow>`
          SELECT resets_at, armed, episode, fired_threshold, fired_key, pending
          FROM usage_limit_alert_state
          WHERE instance_id = ${provider.instanceId} AND account_key = ${accountKey}
            AND window_id = ${window.id}`;
        const prev = rows[0] === undefined ? undefined : toSlot(rows[0]);
        const decision = decideUsageLimitAlert(
          prev,
          { remaining: remainingPercent(window), resetsAtMs },
          threshold,
        );
        // A slot this process has not read yet may hold a send a restart cut off: resend it now,
        // with its own key, so restarts in a row never put it off.
        const retry =
          !decision.fire && decision.next.pending && (retryPending || !seen.has(slotKey));
        if (decision.fire || retry) {
          assistantId ??= yield* defaultAssistant;
          // No one to send it: keep the slot armed so the next reading can tell the user.
          if (assistantId === null) continue;
        }
        const next: AlertSlot = decision.fire
          ? {
              ...decision.next,
              firedKey: `usage-limit:${sha(
                provider.instanceId,
                accountKey,
                window.id,
                threshold,
                decision.next.resetsAtMs,
                decision.next.episode,
              ).slice(0, 40)}`,
            }
          : decision.next;
        if (prev === undefined || !sameSlot(prev, next)) {
          // Recorded before the send: a crash after this resends with the same key, never twice.
          yield* sql`
            INSERT INTO usage_limit_alert_state (
              instance_id, account_key, window_id, resets_at, armed, episode, fired_threshold,
              fired_key, pending, updated_at
            ) VALUES (
              ${provider.instanceId}, ${accountKey}, ${window.id},
              ${next.resetsAtMs === null ? null : isoAt(next.resetsAtMs)},
              ${next.armed ? 1 : 0}, ${next.episode}, ${next.firedThreshold}, ${next.firedKey},
              ${next.pending ? 1 : 0}, ${isoAt(nowMs)}
            )
            ON CONFLICT (instance_id, account_key, window_id) DO UPDATE SET
              resets_at = excluded.resets_at, armed = excluded.armed, episode = excluded.episode,
              fired_threshold = excluded.fired_threshold, fired_key = excluded.fired_key,
              pending = excluded.pending, updated_at = excluded.updated_at`;
        }
        seen.set(slotKey, fingerprint);
        if ((!decision.fire && !retry) || next.firedKey === null || assistantId == null) continue;

        language ??= yield* channelLanguage.current;
        const sent = yield* autonomy
          .notifyUsageLimitAlert({
            assistantId,
            key: next.firedKey,
            text: usageLimitAlertText({
              provider,
              account,
              window,
              nowMs,
              timeZone: config?.timeZone ?? serverZone(),
              language,
            }),
          })
          .pipe(Effect.result);
        if (sent._tag === "Failure") {
          yield* Effect.logWarning("usage limit alert not delivered; retrying on the next check", {
            instanceId: provider.instanceId,
            windowId: window.id,
            reason: sent.failure.message,
          });
          continue;
        }
        yield* sql`
          UPDATE usage_limit_alert_state SET pending = 0
          WHERE instance_id = ${provider.instanceId} AND account_key = ${accountKey}
            AND window_id = ${window.id} AND episode = ${next.episode}`;
      }
    }
  });

  const evaluate: UsageLimitAlerts["Service"]["evaluate"] = (providers, options) =>
    lock
      .withPermits(1)(evaluateLocked(providers, options?.retryPending === true))
      .pipe(Effect.ignoreCause({ log: true }));

  // Backoff per instance after a failed or signed-out probe: 30, 60, 120, then 240 minutes.
  const backoff = new Map<string, { readonly failures: number; readonly untilMs: number }>();
  const check = Effect.fn("UsageLimitAlerts.check")(function* () {
    // Rechecked here too: a probe refreshes every client's provider list, and no one could send.
    if ((yield* defaultAssistant) === null) return;
    const settings = yield* settingsService.getSettings;
    const nowMs = yield* Clock.currentTimeMillis;
    for (const provider of yield* registry.getProviders) {
      if (!hasUsageLimitAlert(provider, settings)) continue;
      if ((backoff.get(provider.instanceId)?.untilMs ?? 0) > nowMs) continue;
      // The same probe as refreshing Usage → Limits: it reads limits and never starts a turn.
      const refreshed = yield* registry
        .refreshInstance(provider.instanceId, { fresh: true })
        .pipe(Effect.result);
      const snapshot =
        refreshed._tag === "Success"
          ? refreshed.success.find((entry) => entry.instanceId === provider.instanceId)
          : undefined;
      const readable =
        snapshot !== undefined &&
        snapshot.auth.status !== "unauthenticated" &&
        snapshot.usageLimits !== undefined &&
        snapshot.usageLimits.unavailable === undefined;
      if (readable) {
        backoff.delete(provider.instanceId);
      } else {
        const failures = (backoff.get(provider.instanceId)?.failures ?? 0) + 1;
        const delayMs = Math.min(Duration.toMillis(CHECK_INTERVAL) * 2 ** failures, MAX_BACKOFF_MS);
        backoff.set(provider.instanceId, { failures, untilMs: nowMs + delayMs });
      }
    }
    yield* evaluate(yield* registry.getProviders, { retryPending: true });
  });

  const jitteredInterval = Random.nextBetween(0, CHECK_JITTER_SHARE).pipe(
    Effect.map((share) => Duration.times(CHECK_INTERVAL, 1 + share)),
  );
  const checkLoop = Effect.forever(
    jitteredInterval.pipe(
      Effect.flatMap(Effect.sleep),
      Effect.andThen(check()),
      Effect.ignoreCause({ log: true }),
    ),
  );

  // The periodic check runs only while some instance has an alert on and it can be delivered.
  const loop = yield* FiberHandle.make<void, never>();
  const onChange = Effect.fn("UsageLimitAlerts.onChange")(function* (
    providers: ReadonlyArray<ServerProvider>,
  ) {
    const settings = yield* settingsService.getSettings;
    const active =
      canDeliver(settings) &&
      providers.some((provider) => hasUsageLimitAlert(provider, settings)) &&
      (yield* defaultAssistant) !== null;
    if (active) yield* FiberHandle.run(loop, checkLoop, { onlyIfMissing: true });
    else yield* FiberHandle.clear(loop);
    yield* evaluate(providers);
  });
  const onCurrent = registry.getProviders.pipe(
    Effect.flatMap(onChange),
    Effect.ignoreCause({ log: true }),
  );

  // Subscribe before reading the current snapshot so no reading lands between the two.
  yield* Effect.forkScoped(
    Stream.runForEach(registry.streamChanges, (providers) =>
      onChange(providers).pipe(Effect.ignoreCause({ log: true })),
    ),
    { startImmediately: true },
  );
  // A new threshold may already be crossed by the reading on hand.
  yield* Effect.forkScoped(
    Stream.runForEach(settingsService.streamChanges, () => onCurrent),
    { startImmediately: true },
  );
  // A default assistant created, restored or archived starts or stops the check.
  const assistantChanges = yield* assistants.subscribeChanges;
  yield* Effect.forkScoped(
    Stream.fromSubscription(assistantChanges).pipe(
      Stream.filter((event) => event.type === "upserted" || event.type === "removed"),
      Stream.runForEach(() => onCurrent),
    ),
    { startImmediately: true },
  );
  yield* onCurrent;

  return UsageLimitAlerts.of({ evaluate });
});

export const layer = Layer.effect(UsageLimitAlerts, make);
