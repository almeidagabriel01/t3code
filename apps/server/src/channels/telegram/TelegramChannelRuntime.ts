/**
 * Long-polls the Telegram Bot API and hands the admitted messages to the gateway. The next
 * update offset is stored per bot, so a restart neither replays history nor loses a message that
 * arrived while the server was off. A failing token or network backs off instead of looping.
 */
import {
  assistantCommandNames,
  ChatAttachmentId,
  type ChatImageAttachment,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  type TelegramChannelDeliveryError,
  type TelegramChannelErrorCode,
  type TelegramChannelStatusEvent,
  type TelegramPendingSender,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";

import { storeAttachmentUpload } from "../../assets/AttachmentUpload.ts";
import { createPendingAttachmentId } from "../../attachmentStore.ts";
import * as AssistantService from "../../assistants/AssistantService.ts";
import { hostedAppUrlConfig } from "../../cloud/publicConfig.ts";
import type * as ServerConfig from "../../config.ts";
import { matchesImageSignature } from "../../guest/guestAttachments.ts";
import type * as DocumentText from "../../provider/DocumentText.ts";
import * as ChannelGateway from "../ChannelGateway.ts";
import { ChannelLanguage } from "../ChannelLanguage.ts";
import { channelStrings } from "../channelStrings.ts";
import * as ChannelTransport from "../ChannelTransport.ts";
import {
  admitTelegramUpdate,
  type TelegramAdmission,
  type TelegramMedia,
} from "./telegramAdmission.ts";
import {
  LONG_POLL_SECONDS,
  makeTelegramApi,
  type TelegramApi,
  type TelegramApiError,
  type TelegramUpdate,
} from "./telegramApi.ts";
import { formatTelegramMessages } from "./telegramText.ts";
import { makeTelegramTransport, type TelegramSendReport } from "./telegramTransport.ts";

export const TELEGRAM_CONNECTION_ID = "telegram";
const SENT_RETENTION_MS = 24 * 60 * 60_000;
const BACKOFF_BASE_SECONDS = 2;
const BACKOFF_CAP_SECONDS = 60;
/** A wrong token stays wrong until a person fixes it, so it is retried rarely. */
const INVALID_TOKEN_CAP_SECONDS = 300;
const STORAGE_RETRY_SECONDS = 5;
const MAX_PENDING_SENDERS = 5;
/** Bounds the memory of who was already answered; a forgotten sender is answered once more. */
const MAX_REPLIED = 500;
/**
 * Telegram sends an album as one update per photo, often split across polls. A batch that ends
 * inside an album is left unacknowledged and polled again after this pause; the album goes on as
 * one message once a poll brings nothing new for it, or after `ALBUM_MAX_WAITS` pauses.
 */
export const ALBUM_WAIT = Duration.seconds(2);
const ALBUM_MAX_WAITS = 5;

interface Admitted {
  readonly update: TelegramUpdate;
  readonly admission: TelegramAdmission;
}

/** Updates that go on together: an album's photos, or one update alone. */
interface Unit {
  readonly albumKey: string | undefined;
  readonly items: Array<Admitted>;
}

function unitsOf(admitted: ReadonlyArray<Admitted>): ReadonlyArray<Unit> {
  const units: Array<Unit> = [];
  const albums = new Map<string, Unit>();
  for (const item of admitted) {
    const { admission } = item;
    const albumKey =
      admission.type === "message" && admission.mediaGroupId !== undefined
        ? `${admission.inbound.conversationKey}:${admission.mediaGroupId}`
        : undefined;
    const album = albumKey === undefined ? undefined : albums.get(albumKey);
    if (album !== undefined) {
      album.items.push(item);
      continue;
    }
    const unit = { albumKey, items: [item] };
    units.push(unit);
    if (albumKey !== undefined) albums.set(albumKey, unit);
  }
  return units;
}

export interface TelegramConfig {
  readonly token: Redacted.Redacted<string>;
  readonly allowedUserIds: ReadonlyArray<string>;
}

export type TelegramRuntimeStatus = TelegramChannelStatusEvent;

const DISABLED: TelegramRuntimeStatus = { status: "disabled" };

export class TelegramChannelRuntime extends Context.Service<
  TelegramChannelRuntime,
  {
    /** Starts polling with this configuration, replacing the previous one; `null` stops it. */
    readonly apply: (config: TelegramConfig | null) => Effect.Effect<void>;
    /** Forgets waiting senders, e.g. after the owner dismissed them. */
    readonly dismiss: (userIds: ReadonlyArray<string>) => Effect.Effect<void>;
    readonly status: Effect.Effect<TelegramRuntimeStatus>;
    /** The current status first, then each change. */
    readonly streamStatus: Stream.Stream<TelegramRuntimeStatus>;
    /** One poll now; resolves to how long the loop waits before the next one. */
    readonly pollOnce: Effect.Effect<Duration.Duration>;
  }
>()("t3/channels/telegram/TelegramChannelRuntime") {}

export interface TelegramRuntimeOptions {
  /** Tests turn the loop off and call `pollOnce` themselves. */
  readonly autoPoll?: boolean;
}

const errorCodeOf = (error: TelegramApiError): TelegramChannelErrorCode =>
  error.code === "invalid_token" || error.code === "conflict" || error.code === "rate_limited"
    ? error.code
    : "unreachable";

export const make = Effect.fn("TelegramChannelRuntime.make")(function* (
  options: TelegramRuntimeOptions = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const http = yield* HttpClient.HttpClient;
  const gateway = yield* ChannelGateway.ChannelGateway;
  const registry = yield* ChannelTransport.ChannelTransportRegistry;
  const assistants = yield* AssistantService.AssistantService;
  const channelLanguage = yield* ChannelLanguage;
  const hostedAppUrl = yield* hostedAppUrlConfig.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Telegram thread links open app.t3.codes", { cause }).pipe(
        Effect.as(DEFAULT_HOSTED_APP_URL),
      ),
    ),
  );
  const layerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const config = yield* Ref.make<TelegramConfig | null>(null);
  const api = yield* Ref.make<TelegramApi | undefined>(undefined);
  const loop = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
  const failures = yield* Ref.make(0);
  const botUsername = yield* Ref.make<string | undefined>(undefined);
  const pollError = yield* Ref.make<TelegramChannelErrorCode | undefined>(undefined);
  const sendError = yield* Ref.make<TelegramChannelErrorCode | undefined>(undefined);
  const deliveryError = yield* Ref.make<TelegramChannelDeliveryError | undefined>(undefined);
  const pending = yield* Ref.make<ReadonlyArray<TelegramPendingSender>>([]);
  const replied = yield* Ref.make<ReadonlySet<string>>(new Set());
  const watcher = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
  const syncedCommands = yield* Ref.make<string | undefined>(undefined);
  const syncLock = yield* Semaphore.make(1);
  const statusRef = yield* SubscriptionRef.make<TelegramRuntimeStatus>(DISABLED);
  const waitingAlbum = yield* Ref.make<
    { readonly key: string; readonly size: number; readonly waits: number } | undefined
  >(undefined);
  // Images are stored as pending uploads, as the app's own upload does, for the thread to claim.
  const storeContext = yield* Effect.context<
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | SecureRandom.SecureRandom
    | DocumentText.DocumentText
  >();

  const publish = Effect.gen(function* () {
    if ((yield* Ref.get(config)) === null) return yield* SubscriptionRef.set(statusRef, DISABLED);
    const lastError = (yield* Ref.get(pollError)) ?? (yield* Ref.get(sendError));
    const lastDeliveryError = yield* Ref.get(deliveryError);
    const username = yield* Ref.get(botUsername);
    const waiting = yield* Ref.get(pending);
    yield* SubscriptionRef.set(statusRef, {
      ...(waiting.length === 0 ? {} : { pendingSenders: waiting }),
      status: lastError === undefined ? "running" : "error",
      ...(lastError === undefined ? {} : { lastError }),
      ...(lastDeliveryError === undefined ? {} : { lastDeliveryError }),
      ...(username ? { botUsername: username } : {}),
    });
  });

  /** Puts the bot's "/" menu in step with the active assistants; a failure is logged, never fatal. */
  const syncCommands = Effect.gen(function* () {
    const client = yield* Ref.get(api);
    if (client === undefined || (yield* Ref.get(botUsername)) === undefined) return;
    const active = (yield* assistants.list).filter((assistant) => assistant.archivedAt === null);
    const commands = assistantCommandNames(active).map(({ command, assistant }) => ({
      command,
      description: assistant.name.slice(0, 256),
    }));
    const key = commands.map((entry) => `${entry.command}\n${entry.description}`).join("\n\n");
    if ((yield* Ref.get(syncedCommands)) === key) return;
    yield* client.setMyCommands(commands);
    yield* Ref.set(syncedCommands, key);
  }).pipe(
    syncLock.withPermits(1),
    Effect.catchCause((cause) => Effect.logWarning("Telegram command menu not updated", { cause })),
  );

  const dismiss: TelegramChannelRuntime["Service"]["dismiss"] = (userIds) =>
    Ref.update(pending, (list) => list.filter((entry) => !userIds.includes(entry.userId))).pipe(
      Effect.andThen(publish),
    );

  /** Remembers the sender and, once per sender, tells them their message waits for approval. */
  const meetStranger = Effect.fn("TelegramChannelRuntime.meetStranger")(function* (
    client: TelegramApi,
    admission: Extract<ReturnType<typeof admitTelegramUpdate>, { type: "unknown_sender" }>,
  ) {
    const { sender } = admission;
    const seenAt = DateTime.formatIso(yield* DateTime.now);
    yield* Ref.update(pending, (list) =>
      [
        { ...sender, lastSeenAt: seenAt },
        ...list.filter((entry) => entry.userId !== sender.userId),
      ].slice(0, MAX_PENDING_SENDERS),
    );
    yield* publish;
    const known = yield* Ref.get(replied);
    if (known.has(sender.userId)) return;
    yield* Ref.set(replied, new Set([...known, sender.userId].slice(-MAX_REPLIED)));
    const language = yield* channelLanguage.current;
    for (const text of formatTelegramMessages({
      text: channelStrings(language).approvalNotice,
      language,
    })) {
      yield* client.sendMessage({ chatId: admission.chatId, text }).pipe(Effect.ignore);
    }
  });

  const setPollError = (code: TelegramChannelErrorCode | undefined) =>
    Ref.set(pollError, code).pipe(Effect.andThen(publish));

  const report = Effect.fn("TelegramChannelRuntime.report")(function* (result: TelegramSendReport) {
    if (result.ok) {
      yield* Ref.set(sendError, undefined);
      yield* Ref.set(deliveryError, undefined);
    } else {
      yield* Ref.set(deliveryError, {
        code: result.code,
        at: DateTime.formatIso(yield* DateTime.now),
      });
      yield* Ref.set(sendError, result.invalidToken ? "invalid_token" : undefined);
    }
    yield* publish;
  });

  yield* registry.register(
    makeTelegramTransport({
      connectionId: TELEGRAM_CONNECTION_ID,
      api: Ref.get(api),
      sql,
      hostedAppUrl,
      report,
    }),
  );

  const loadOffset = (botId: string) =>
    sql<{ readonly update_offset: number }>`
      SELECT update_offset FROM telegram_cursor WHERE id = ${botId}`.pipe(
      Effect.map((rows) => rows[0]?.update_offset),
      Effect.orDie,
    );
  const saveOffset = (botId: string, offset: number) =>
    sql`
      INSERT OR REPLACE INTO telegram_cursor (id, update_offset) VALUES (${botId}, ${offset})`.pipe(
      Effect.orDie,
    );

  const backoff = (code: TelegramChannelErrorCode, failed: number, retryAfter?: number) => {
    const cap = code === "invalid_token" ? INVALID_TOKEN_CAP_SECONDS : BACKOFF_CAP_SECONDS;
    const seconds = Math.min(cap, BACKOFF_BASE_SECONDS * 2 ** Math.min(failed - 1, 10));
    return Duration.seconds(Math.max(seconds, retryAfter ?? 0));
  };

  /** Downloads one image and stores it as a pending upload; what went wrong, otherwise. */
  const storeMedia = Effect.fn("TelegramChannelRuntime.storeMedia")(function* (
    client: TelegramApi,
    media: TelegramMedia,
  ) {
    const download = yield* Effect.result(
      client.downloadFile({ fileId: media.fileId, maxBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES }),
    );
    if (download._tag === "Failure") {
      if (download.failure.code === "too_large") return "unsupported" as const;
      yield* Effect.logWarning("Telegram attachment was not downloaded", {
        code: download.failure.code,
      });
      return "download_failed" as const;
    }
    const bytes = download.success;
    // The bytes decide, never the name or type the sender's app gave.
    const mimeType = PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find((type) =>
      matchesImageSignature(type, bytes),
    );
    if (mimeType === undefined) return "unsupported" as const;
    const attachment = {
      type: "image",
      id: ChatAttachmentId.make(createPendingAttachmentId()),
      name: media.name,
      mimeType,
      sizeBytes: bytes.byteLength,
    } satisfies ChatImageAttachment;
    const stored = yield* storeAttachmentUpload(
      { ...attachment, attachmentId: attachment.id },
      bytes,
    ).pipe(Effect.provide(storeContext));
    return stored.ok ? attachment : ("download_failed" as const);
  });

  /** Passes one message, or one album as a single message, to the gateway. */
  const deliver = Effect.fn("TelegramChannelRuntime.deliver")(function* (
    client: TelegramApi,
    unit: Unit,
  ) {
    const first = unit.items[0]!.admission;
    if (first.type === "unknown_sender") return yield* meetStranger(client, first);
    if (first.type !== "message") return;
    const parts = unit.items.flatMap(({ admission }) =>
      admission.type === "message" ? [admission] : [],
    );
    let problem = parts.find((part) => part.inbound.attachmentProblem)?.inbound.attachmentProblem;
    const attachments: Array<ChatImageAttachment> = [];
    for (const media of parts.flatMap((part) => part.media)) {
      const stored = yield* storeMedia(client, media);
      if (typeof stored === "string") problem ??= stored;
      else attachments.push(stored);
    }
    const { attachmentProblem: _, ...inbound } = first.inbound;
    yield* gateway.ingest({
      ...inbound,
      // An album's caption rides on one of its photos.
      text: parts.find((part) => part.inbound.text !== "")?.inbound.text ?? "",
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(problem === undefined ? {} : { attachmentProblem: problem }),
    });
  });

  /** Reads one batch of updates and passes the admitted messages on, in order. */
  const processBatch = Effect.fn("TelegramChannelRuntime.processBatch")(function* (
    current: TelegramConfig,
    client: TelegramApi,
  ) {
    const botId = Redacted.value(current.token).split(":")[0] ?? "";
    const allowed = new Set(current.allowedUserIds);
    const offset = yield* loadOffset(botId);
    if (offset === undefined) {
      // First enable for this bot: start from now, never from the backlog Telegram still holds.
      const latest = yield* client.getUpdates({ offset: -1, timeoutSeconds: 0 });
      const newest = Math.max(-1, ...latest.map((update) => update.updateId));
      yield* saveOffset(botId, newest + 1);
      return Duration.zero;
    }
    const waiting = yield* Ref.get(waitingAlbum);
    const updates = (yield* client.getUpdates({
      offset,
      // The album it waits for is already there, so this returns at once with any new parts.
      timeoutSeconds: waiting === undefined ? LONG_POLL_SECONDS : 0,
    })).toSorted((a, b) => a.updateId - b.updateId);
    const units = unitsOf(
      updates.map((update) => ({
        update,
        admission: admitTelegramUpdate(update, allowed, TELEGRAM_CONNECTION_ID),
      })),
    );
    const last = units.at(-1);
    const grew =
      last?.albumKey !== undefined &&
      (waiting?.key !== last.albumKey || waiting.size !== last.items.length) &&
      (waiting?.key === last.albumKey ? waiting.waits : 0) < ALBUM_MAX_WAITS;
    yield* Ref.set(
      waitingAlbum,
      grew
        ? {
            key: last.albumKey!,
            size: last.items.length,
            waits: (waiting?.key === last.albumKey ? waiting.waits : 0) + 1,
          }
        : undefined,
    );
    let acknowledged = offset;
    for (const unit of units) {
      if (grew && unit === last) break;
      yield* deliver(client, unit);
      // Stored only once the gateway has the message, so a storage failure retries this update.
      acknowledged = Math.max(acknowledged, ...unit.items.map(({ update }) => update.updateId + 1));
      yield* saveOffset(botId, acknowledged);
    }
    const now = (yield* DateTime.now).epochMilliseconds;
    yield* sql`DELETE FROM telegram_sent WHERE sent_at_ms < ${now - SENT_RETENTION_MS}`.pipe(
      Effect.orDie,
    );
    return grew ? ALBUM_WAIT : Duration.zero;
  });

  const pollOnce: TelegramChannelRuntime["Service"]["pollOnce"] = Effect.gen(function* () {
    const current = yield* Ref.get(config);
    const client = yield* Ref.get(api);
    if (current === null || client === undefined) return Duration.zero;
    const outcome = yield* Effect.result(
      Effect.gen(function* () {
        if ((yield* Ref.get(botUsername)) === undefined) {
          const me = yield* client.getMe;
          yield* Ref.set(botUsername, me.username ?? "");
          yield* syncCommands;
        }
        return yield* processBatch(current, client);
      }),
    );
    if (outcome._tag === "Success") {
      yield* Ref.set(failures, 0);
      yield* setPollError(undefined);
      return outcome.success;
    }
    const failed = yield* Ref.updateAndGet(failures, (count) => count + 1);
    if (outcome.failure._tag === "TelegramApiError") {
      const code = errorCodeOf(outcome.failure);
      yield* setPollError(code);
      return backoff(code, failed, outcome.failure.retryAfterSeconds);
    }
    // The gateway could not store the message; the same update is tried again after a pause.
    yield* Effect.logWarning("Telegram message was not stored; retrying", {
      failure: outcome.failure,
    });
    return Duration.seconds(STORAGE_RETRY_SECONDS);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Telegram poll failed", { cause }).pipe(
        Effect.as(Duration.seconds(STORAGE_RETRY_SECONDS)),
      ),
    ),
    Effect.withSpan("TelegramChannelRuntime.pollOnce"),
  );

  const apply: TelegramChannelRuntime["Service"]["apply"] = (next) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const previous = yield* Ref.get(loop);
        if (previous !== undefined) yield* Fiber.interrupt(previous);
        yield* Ref.set(loop, undefined);
        const previousWatcher = yield* Ref.get(watcher);
        if (previousWatcher !== undefined) yield* Fiber.interrupt(previousWatcher);
        yield* Ref.set(watcher, undefined);
        yield* Ref.set(syncedCommands, undefined);
        yield* Ref.set(waitingAlbum, undefined);
        yield* Ref.set(config, next);
        if (next === null) {
          yield* Ref.set(pending, []);
          yield* Ref.set(replied, new Set());
        } else {
          const allowed = new Set(next.allowedUserIds);
          yield* Ref.update(pending, (list) => list.filter((entry) => !allowed.has(entry.userId)));
        }
        yield* Ref.set(api, next === null ? undefined : makeTelegramApi(http, next.token));
        yield* Ref.set(failures, 0);
        yield* Ref.set(botUsername, undefined);
        yield* Ref.set(pollError, undefined);
        yield* Ref.set(sendError, undefined);
        yield* Ref.set(deliveryError, undefined);
        yield* publish;
        if (next === null) return;
        // A renamed, added or archived assistant changes the "/" menu; identical menus are not resent.
        yield* Ref.set(
          watcher,
          yield* Effect.forkIn(
            assistants.subscribe.pipe(
              Stream.runForEach(() => syncCommands),
              Effect.ignore,
            ),
            layerScope,
          ),
        );
        if (options.autoPoll === false) return;
        const fiber = yield* Effect.forkIn(
          pollOnce.pipe(
            // A finished long poll goes straight to the next one; only a failure waits.
            Effect.flatMap((delay) =>
              Duration.isZero(delay) ? Effect.yieldNow : Effect.sleep(delay),
            ),
            Effect.forever,
          ),
          layerScope,
        );
        yield* Ref.set(loop, fiber);
      }),
    );

  return TelegramChannelRuntime.of({
    apply,
    dismiss,
    status: SubscriptionRef.get(statusRef),
    streamStatus: SubscriptionRef.changes(statusRef),
    pollOnce,
  });
});

export const layer = Layer.effect(TelegramChannelRuntime, make()).pipe(
  Layer.provide(FetchHttpClient.layer),
);
