import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as AutonomyService from "../autonomy/AutonomyService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionRenewal from "./SessionRenewal.ts";
import * as SessionStore from "./SessionStore.ts";

const day = Duration.toMillis(Duration.days(1));

const linkAt = (name: string, expiresInDays: number, lastError: string | null = null) => ({
  environmentId: EnvironmentId.make(`environment-${name}`),
  label: name,
  urls: [`https://${name}.example`],
  access: "auto" as const,
  linkedAt: DateTime.makeUnsafe(0),
  // The pass runs on day 24.
  expiresAt: DateTime.makeUnsafe((24 + expiresInDays) * day),
  lastReachedAt: null,
  lastError,
});

const renewals: ReadonlyArray<PeerLinks.PeerLinkRenewal> = [
  { link: linkAt("offline", 3), outcome: "unreachable" },
  { link: linkAt("revoked", 3, "revoked there"), outcome: "rejected" },
  { link: linkAt("healthy", 30), outcome: "renewed" },
  { link: linkAt("legacy", -1), outcome: "skipped" },
];

const layerSessions = SessionStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-session-renewal-test-" })),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.effect("warns once per lapse about refused or lapsing links and idle paired clients", () =>
  Effect.gen(function* () {
    const keys = yield* Ref.make<ReadonlyArray<string>>([]);
    const sessions = yield* SessionStore.SessionStore;
    const usedThenLeft = Effect.fn(function* (input: Parameters<typeof sessions.issue>[0]) {
      const issued = yield* sessions.issue(input);
      yield* sessions.markConnected(issued.sessionId);
      yield* sessions.markDisconnected(issued.sessionId);
      return issued;
    });
    const laptop = yield* usedThenLeft({
      subject: "one-time-token",
      method: "bearer-access-token",
      client: { label: "Work laptop", deviceType: "desktop" },
    });
    yield* usedThenLeft({
      subject: "one-time-token",
      client: { deviceType: "desktop", browser: "Safari" },
    });
    yield* usedThenLeft({
      subject: "desktop-bootstrap",
      method: "bearer-access-token",
      client: { label: "T3 Code Desktop", deviceType: "desktop" },
    });
    yield* sessions.issue({
      subject: "one-time-token",
      method: "bearer-access-token",
      client: { label: "Never opened", deviceType: "mobile" },
    });

    const pass = SessionRenewal.renewOnce().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(PeerLinks.PeerLinks)({ renewAll: Effect.succeed(renewals) }),
          Layer.mock(AutonomyService.AutonomyService)({
            tellUser: ({ key }) => Ref.update(keys, (seen) => [...seen, key]),
          }),
        ),
      ),
    );

    yield* TestClock.adjust(Duration.days(24));
    yield* pass;
    yield* pass;

    const expected = [
      `peer-link-expiry:environment-offline:${27 * day}`,
      `peer-link-rejected:environment-revoked:0`,
      `session-expiry:${laptop.sessionId}:${30 * day}`,
    ];
    // Each pass names the same lapse with the same key, and the chat outbox sends a key once.
    expect(yield* Ref.get(keys)).toEqual([...expected, ...expected]);
  }).pipe(Effect.provide(Layer.merge(layerSessions, TestClock.layer()))),
);
