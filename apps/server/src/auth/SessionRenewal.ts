import type { AuthClientSession } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as AutonomyService from "../autonomy/AutonomyService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as SessionStore from "./SessionStore.ts";

const RENEWAL_INTERVAL = Duration.hours(6);
const WARN_WITHIN = Duration.days(7);
// The desktop app re-mints its own local session at every launch, so its expiry never matters.
const SELF_MINTED_SUBJECT = "desktop-bootstrap";
const WARNED_DEVICE_TYPES: ReadonlySet<AuthClientSession["client"]["deviceType"]> = new Set([
  "desktop",
  "mobile",
  "tablet",
]);

const day = DateTime.formatIsoDateUtc;

const expiresSoon = (expiresAt: DateTime.DateTime, now: DateTime.Utc) =>
  expiresAt.epochMilliseconds - now.epochMilliseconds < Duration.toMillis(WARN_WITHIN);

/**
 * A paired app (desktop, phone, tablet) that stopped connecting, so its session is about to lapse.
 * Browsers hold cookies instead of bearer tokens and are left out: an abandoned tab is not news.
 */
const isIdlePairedClient = (session: AuthClientSession, now: DateTime.Utc) =>
  session.method === "bearer-access-token" &&
  !session.connected &&
  session.lastConnectedAt !== null &&
  session.subject !== SELF_MINTED_SUBJECT &&
  WARNED_DEVICE_TYPES.has(session.client.deviceType) &&
  expiresSoon(session.expiresAt, now);

/**
 * One pass: slides sessions held open by a socket, renews every link at its peer, then tells
 * the user once about each link the peer refused and each link or paired client about to lapse.
 * Keys carry the expiry, so a renewal that later fails again warns again, once.
 */
export const renewOnce = Effect.fn("SessionRenewal.renewOnce")(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const peerLinks = yield* PeerLinks.PeerLinks;
  const autonomy = yield* AutonomyService.AutonomyService;

  yield* sessions.renewConnected();
  const now = yield* DateTime.now;

  const renewals = yield* peerLinks.renewAll.pipe(
    Effect.catchTags({
      PeerLinkError: (error) =>
        Effect.logWarning("Could not renew linked environments.", { cause: error }).pipe(
          Effect.as([]),
        ),
    }),
  );
  yield* Effect.forEach(
    renewals,
    ({ link, outcome }) => {
      if (outcome === "skipped") return Effect.void;
      if (outcome === "rejected" || outcome === "lost") {
        return autonomy.tellUser({
          key: `peer-link-${outcome}:${link.environmentId}:${link.linkedAt.epochMilliseconds}`,
          text:
            outcome === "rejected"
              ? `${link.label} no longer accepts this environment's link. Link it again with a new pairing code from ${link.label}.`
              : `This environment lost the credential for its link to ${link.label}. Link it again with a new pairing code from ${link.label}.`,
          threadId: null,
        });
      }
      if (!expiresSoon(link.expiresAt, now)) return Effect.void;
      return autonomy.tellUser({
        key: `peer-link-expiry:${link.environmentId}:${link.expiresAt.epochMilliseconds}`,
        text: `The link to ${link.label} expires on ${day(link.expiresAt)} and is not renewing${link.lastError ? `: ${link.lastError}` : `, because ${link.label} is not answering`}. Bring it back online, or link it again with a new pairing code.`,
        threadId: null,
      });
    },
    { discard: true },
  );

  const clients = yield* sessions
    .listActive()
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not list sessions to warn about expiry.", { cause }).pipe(
          Effect.as([]),
        ),
      ),
    );
  yield* Effect.forEach(
    clients.filter((session) => isIdlePairedClient(session, now)),
    (session) =>
      autonomy.tellUser({
        key: `session-expiry:${session.sessionId}:${session.expiresAt.epochMilliseconds}`,
        text: `${session.client.label ?? `A paired ${session.client.deviceType}`} has not connected since ${day(session.lastConnectedAt ?? session.expiresAt)}, so its access here expires on ${day(session.expiresAt)}. Open it once to keep it, or revoke it in Settings → Sharing & access.`,
        threadId: null,
      }),
    { discard: true },
  );
});

/** Runs `renewOnce` at startup and every few hours for the server's life; never in the CLI. */
export const layer = Layer.effectDiscard(
  renewOnce().pipe(
    Effect.catchCause((cause) => Effect.logWarning("Session renewal pass failed.", { cause })),
    Effect.repeat(Schedule.spaced(RENEWAL_INTERVAL)),
    Effect.forkScoped,
  ),
);
