import type {
  EnvironmentId,
  LinkedEnvironmentReading,
  LinkedEnvironmentResources as LinkedEnvironmentResourcesRow,
  PeerLink,
  PeerLinkError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/** A reading younger than this is served as is; an older one is read again in the background. */
export const READING_TTL = Duration.seconds(15);
/** Both tools together; resolving a link alone may probe each address for 10 s. */
const PEER_TIMEOUT = Duration.seconds(20);
const LIVE_WINDOW = Duration.sum(READING_TTL, PEER_TIMEOUT);
/** Reads only, so the narrowest modes: the peer refuses anything past them. */
const READ_LIMITS: PeerMcpClient.PeerCallLimits = {
  runtimeMode: "approval-required",
  interactionMode: "plan",
};

/** The fields of `t3_host status` this reads; the rest are ignored. */
export const HostStatus = Schema.Struct({
  cpu: Schema.Struct({ count: Schema.Number, utilization: Schema.NullOr(Schema.Number) }),
  memory: Schema.Struct({ totalBytes: Schema.Number, availableBytes: Schema.Number }),
  running: Schema.Number,
  waiting: Schema.Number,
  subagentsRunning: Schema.Number,
});
/** The fields of `t3_heavy status` this reads: counts only, never command lines. */
export const HeavyStatus = Schema.Struct({
  mac: Schema.Struct({ running: Schema.Number, maxRunning: Schema.Number }),
  waiting: Schema.Array(Schema.Unknown),
});

const count = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

export const toReading = (
  host: typeof HostStatus.Type,
  heavy: Option.Option<typeof HeavyStatus.Type>,
  readAt: DateTime.Utc,
): LinkedEnvironmentReading => ({
  readAt,
  cpuUtilization:
    host.cpu.utilization === null || !Number.isFinite(host.cpu.utilization)
      ? null
      : Math.min(1, Math.max(0, host.cpu.utilization)),
  cpuCount: count(host.cpu.count),
  availableMemoryBytes: count(host.memory.availableBytes),
  totalMemoryBytes: count(host.memory.totalBytes),
  threadsRunning: count(host.running),
  threadsWaiting: count(host.waiting),
  subagentsRunning: count(host.subagentsRunning),
  heavy: Option.match(heavy, {
    onNone: () => null,
    onSome: (status) => ({
      running: count(status.mac.running),
      slots: count(status.mac.maxRunning),
      waiting: status.waiting.length,
    }),
  }),
});

/** What this environment last learned about one link. */
export interface CacheEntry {
  readonly online: boolean;
  readonly since: DateTime.Utc | null;
  readonly checkedAt: DateTime.Utc;
  /** The last good reading, kept while offline so it can be shown as old. */
  readonly reading: LinkedEnvironmentReading | null;
}

const latest = (a: DateTime.Utc | null, b: DateTime.Utc | null) =>
  a === null ? b : b === null ? a : DateTime.max(a, b);

/** The entry after one attempt: `reading` on success, `null` when the link did not answer. */
export const nextEntry = (
  previous: CacheEntry | undefined,
  reading: LinkedEnvironmentReading | null,
  link: Pick<PeerLink, "lastReachedAt">,
  now: DateTime.Utc,
): CacheEntry =>
  reading !== null
    ? {
        online: true,
        since: previous?.online === true ? previous.since : now,
        checkedAt: now,
        reading,
      }
    : {
        online: false,
        since:
          previous?.online === false
            ? previous.since
            : latest(previous?.reading?.readAt ?? null, link.lastReachedAt),
        checkedAt: now,
        reading: previous?.reading ?? null,
      };

const expired = (link: PeerLink, now: DateTime.Utc) =>
  DateTime.isLessThanOrEqualTo(link.expiresAt, now);

export const toRow = (
  link: PeerLink,
  entry: CacheEntry | undefined,
  now: DateTime.Utc,
): LinkedEnvironmentResourcesRow => {
  const base = { environmentId: link.environmentId, label: link.label };
  if (expired(link, now))
    return { ...base, status: "expired", since: link.expiresAt, reading: entry?.reading ?? null };
  if (entry === undefined) return { ...base, status: "checking", since: null, reading: null };
  // An answer older than one refresh and its timeout says nothing about now: check again first.
  const current = DateTime.isLessThan(now, DateTime.addDuration(entry.checkedAt, LIVE_WINDOW));
  return {
    ...base,
    status: !entry.online ? "offline" : current ? "online" : "checking",
    since: entry.since,
    reading: entry.reading,
  };
};

const isFresh = (entry: CacheEntry | undefined, now: DateTime.Utc) =>
  entry !== undefined &&
  DateTime.isLessThan(now, DateTime.addDuration(entry.checkedAt, READING_TTL));

/**
 * Each linked environment's CPU, memory, running threads and heavy queue, read from that
 * environment's own `t3_host` and `t3_heavy` over the link. Reads answer from a cache at once and
 * refresh what aged out in the background, one attempt per link at a time, so a dead link never
 * holds a reader and nothing polls a peer while no one reads.
 */
export class LinkedEnvironmentResources extends Context.Service<
  LinkedEnvironmentResources,
  {
    /** Every link with its latest reading; starts a refresh of the stale ones without waiting. */
    readonly read: Effect.Effect<ReadonlyArray<LinkedEnvironmentResourcesRow>, PeerLinkError>;
    /** Reads every stale, unexpired link again and waits for the answers. */
    readonly refresh: Effect.Effect<void, PeerLinkError>;
  }
>()("t3/peer/LinkedEnvironmentResources") {}

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const scope = yield* Scope.Scope;
  const cache = yield* Ref.make<ReadonlyMap<EnvironmentId, CacheEntry>>(new Map());
  const inFlight = yield* Ref.make<ReadonlyMap<EnvironmentId, Deferred.Deferred<void>>>(new Map());

  const call = <S extends Schema.Decoder<unknown>>(link: PeerLink, tool: string, success: S) =>
    peers.call({
      environmentId: link.environmentId,
      tool,
      arguments: { action: "status" },
      limits: READ_LIMITS,
      success,
    });

  const attempt = Effect.fn("LinkedEnvironmentResources.attempt")(function* (link: PeerLink) {
    const reading = yield* Effect.all(
      [call(link, "t3_host", HostStatus), Effect.option(call(link, "t3_heavy", HeavyStatus))],
      { concurrency: 2 },
    ).pipe(
      Effect.timeout(PEER_TIMEOUT),
      Effect.flatMap(([host, heavy]) =>
        DateTime.now.pipe(Effect.map((now) => toReading(host, heavy, now))),
      ),
      Effect.orElseSucceed(() => null),
    );
    const now = yield* DateTime.now;
    yield* Ref.update(cache, (current) =>
      new Map(current).set(
        link.environmentId,
        nextEntry(current.get(link.environmentId), reading, link, now),
      ),
    );
  });

  /** Joins the attempt already running for this link instead of starting a second one. */
  const refreshLink = Effect.fn("LinkedEnvironmentResources.refreshLink")(function* (
    link: PeerLink,
  ) {
    const mine = yield* Deferred.make<void>();
    const running = yield* Ref.modify(inFlight, (current) => {
      const existing = current.get(link.environmentId);
      return existing === undefined
        ? [undefined, new Map(current).set(link.environmentId, mine)]
        : [existing, current];
    });
    if (running !== undefined) return yield* Deferred.await(running);
    yield* attempt(link).pipe(
      Effect.ensuring(
        Ref.update(inFlight, (current) => {
          const next = new Map(current);
          next.delete(link.environmentId);
          return next;
        }).pipe(Effect.andThen(Deferred.succeed(mine, undefined))),
      ),
    );
  });

  const refresh: LinkedEnvironmentResources["Service"]["refresh"] = Effect.gen(function* () {
    if (!(yield* links.enabled)) return;
    const stored = yield* links.stored;
    const now = yield* DateTime.now;
    const ids = new Set(stored.map((link) => link.environmentId));
    const entries = yield* Ref.updateAndGet(
      cache,
      (current) => new Map([...current].filter(([id]) => ids.has(id))),
    );
    yield* Effect.forEach(
      stored.filter(
        (link) => !expired(link, now) && !isFresh(entries.get(link.environmentId), now),
      ),
      refreshLink,
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(Effect.withSpan("LinkedEnvironmentResources.refresh"));

  const read: LinkedEnvironmentResources["Service"]["read"] = Effect.gen(function* () {
    if (!(yield* links.enabled)) return [];
    const stored = yield* links.stored;
    yield* refresh.pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));
    const entries = yield* Ref.get(cache);
    const now = yield* DateTime.now;
    return stored.map((link) => toRow(link, entries.get(link.environmentId), now));
  }).pipe(Effect.withSpan("LinkedEnvironmentResources.read"));

  return LinkedEnvironmentResources.of({ read, refresh });
});

export const layer = Layer.effect(LinkedEnvironmentResources, make);
