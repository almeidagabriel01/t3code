import { assert, describe, it } from "@effect/vitest";
import {
  AutonomyError,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as AutonomyService from "../autonomy/AutonomyService.ts";
import * as ChannelLanguage from "../channels/ChannelLanguage.ts";
import { ensureForkSchema } from "../persistence/ForkSchema.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import {
  type AlertSlot,
  decideUsageLimitAlert,
  usageLimitAlertText,
  UsageLimitAlerts,
  layer as usageLimitAlertsLayer,
} from "./UsageLimitAlerts.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe("decideUsageLimitAlert", () => {
  const run = (
    readings: ReadonlyArray<readonly [remaining: number, resetsAtMs: number | null]>,
    threshold = 15,
  ) => {
    let slot: AlertSlot | undefined;
    const fired: number[] = [];
    readings.forEach(([remaining, resetsAtMs], index) => {
      const decision = decideUsageLimitAlert(slot, { remaining, resetsAtMs }, threshold);
      if (decision.fire) fired.push(index);
      slot = decision.next;
    });
    return fired;
  };

  it.each([
    [
      "crossing the threshold sends once",
      [
        [40, DAY],
        [15, DAY],
        [15, DAY],
      ],
      [1],
    ],
    [
      "a wobble around the threshold sends once",
      [
        [30, DAY],
        [15, DAY],
        [16, DAY],
        [15, DAY],
        [16, DAY],
        [15, DAY],
      ],
      [1],
    ],
    [
      "it rearms only at threshold + 5",
      [
        [15, DAY],
        [19, DAY],
        [15, DAY],
        [20, DAY],
        [15, DAY],
      ],
      [0, 4],
    ],
    [
      "a jump to zero sends once and lower readings stay quiet",
      [
        [40, DAY],
        [0, DAY],
        [14, DAY],
        [10, DAY],
        [5, DAY],
      ],
      [1],
    ],
    [
      "a reset moving by seconds is the same window",
      [
        [10, DAY],
        [10, DAY + 7_000],
        [9, DAY - 3_000],
      ],
      [0],
    ],
    [
      "a reset moving by minutes inside tolerance does not drift into a new window",
      [
        [10, DAY],
        [10, DAY + 9 * 60_000],
        [10, DAY + 18 * 60_000],
      ],
      [0],
    ],
    [
      "a reset past the tolerance starts a new window",
      [
        [10, DAY],
        [10, DAY + 7 * DAY],
      ],
      [0, 1],
    ],
    [
      "a reading without a reset is the same window",
      [
        [10, DAY],
        [10, null],
        [10, DAY],
      ],
      [0],
    ],
    [
      "a first reading without a reset is the same window as a later one with it",
      [
        [10, null],
        [10, DAY],
      ],
      [0],
    ],
    [
      "a window without any reset rearms only by recovering",
      [
        [10, null],
        [12, null],
        [25, null],
        [10, null],
      ],
      [0, 3],
    ],
    [
      "nothing is sent above the threshold",
      [
        [90, DAY],
        [16, DAY],
      ],
      [],
    ],
  ] as const)("%s", (_name, readings, expected) => {
    assert.deepStrictEqual(run(readings), [...expected]);
  });

  it("changing the threshold while below sends at most once", () => {
    const first = decideUsageLimitAlert(undefined, { remaining: 10, resetsAtMs: DAY }, 15);
    assert.isTrue(first.fire);
    for (const threshold of [20, 10, 5, 50]) {
      const next = decideUsageLimitAlert(first.next, { remaining: 10, resetsAtMs: DAY }, threshold);
      assert.isFalse(next.fire, `threshold ${threshold}`);
    }
  });

  it("keeps a pending send pending in the same window and drops it once the window turns", () => {
    const fired = decideUsageLimitAlert(undefined, { remaining: 10, resetsAtMs: DAY }, 15).next;
    const pending = { ...fired, firedKey: "k" };
    const still = decideUsageLimitAlert(pending, { remaining: 9, resetsAtMs: DAY }, 15).next;
    assert.isTrue(still.pending);
    assert.equal(still.firedKey, "k");
    const turned = decideUsageLimitAlert(pending, { remaining: 90, resetsAtMs: 8 * DAY }, 15).next;
    assert.isFalse(turned.pending);
  });
});

const weekly = (
  usedPercent: number,
  resetsAt = "1970-01-05T12:00:00.000Z",
): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  resetsAt,
});

const provider = (
  instanceId: string,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  driver: ProviderDriverKind.make("claudeAgent"),
  instanceId: ProviderInstanceId.make(instanceId),
  enabled: true,
  installed: true,
  version: "2.0.0",
  status: "ready",
  checkedAt: "1970-01-01T00:00:00.000Z",
  auth: { status: "authenticated", email: `${instanceId}@example.com` },
  models: [],
  skills: [],
  slashCommands: [],
  usageLimits: { checkedAt: "1970-01-01T00:00:00.000Z", windows },
  ...overrides,
});

describe("usageLimitAlertText", () => {
  const window = weekly(85, "1970-01-02T15:30:00.000Z");
  const text = (overrides: Partial<Parameters<typeof usageLimitAlertText>[0]> = {}) =>
    usageLimitAlertText({
      provider: provider("claudeAgent", [window], { displayName: "Claude Max" }),
      account: null,
      window,
      nowMs: 0,
      timeZone: "UTC",
      language: "en",
      ...overrides,
    });

  it("names the provider, the remainder, the window and the reset in one or two link-free lines", () => {
    const message = text();
    assert.equal(message, "Claude Max: 15% of the weekly limit left. Resets Fri 15:30.");
    assert.notInclude(message, "t3-thread://");
    assert.notInclude(message, "://");
    assert.isAtMost(message.split("\n").length, 2);
  });

  it("formats the reset in the saved time zone and speaks the channel language", () => {
    assert.include(text({ timeZone: "America/Sao_Paulo" }), "Resets Fri 12:30.");
    assert.include(text({ timeZone: "Not/AZone" }), "Resets Fri 15:30.");
    assert.equal(
      text({ language: "pt-BR", timeZone: "America/Sao_Paulo" }),
      "Claude Max: restam 15% do limite semanal. Renova sex., 12:30.",
    );
  });

  it("names the account and the model of a scoped window", () => {
    const scoped = { ...window, id: "seven_day_opus", label: "Weekly · Opus" };
    assert.equal(
      text({ window: scoped, account: "work@example.com" }),
      "Claude Max (work@example.com): 15% of the weekly limit (Opus) left. Resets Fri 15:30.",
    );
  });
});

interface Harness {
  readonly setProviders: (providers: ReadonlyArray<ServerProvider>) => Effect.Effect<void>;
  readonly setSettings: (patch: Partial<ServerSettings>) => Effect.Effect<void>;
  readonly sent: Queue.Queue<{ readonly key: string; readonly text: string }>;
  readonly delivered: Ref.Ref<ReadonlyArray<string>>;
  readonly attempts: Ref.Ref<number>;
  readonly refreshes: Ref.Ref<number>;
  readonly notify: Ref.Ref<"ok" | "fail" | "crashAfterRecord">;
  readonly refreshAuth: Ref.Ref<"authenticated" | "unauthenticated">;
}

const autonomyOn = { ...DEFAULT_SERVER_SETTINGS.autonomy, enabled: true };
// Every instance the tests use, saved from a UTC client, so the reset time reads the same anywhere.
const utcAlerts: ServerSettings["usageLimitAlerts"] = Object.fromEntries(
  ["claudeAgent", "claude_work", "codex"].map((id) => [
    ProviderInstanceId.make(id),
    { windows: {}, timeZone: "UTC" },
  ]),
);

const makeHarness = Effect.gen(function* () {
  const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
  const providerChanges = yield* PubSub.unbounded<ReadonlyArray<ServerProvider>>();
  const settings = yield* Ref.make<ServerSettings>({
    ...DEFAULT_SERVER_SETTINGS,
    autonomy: autonomyOn,
    usageLimitAlerts: utcAlerts,
  });
  const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
  const sent = yield* Queue.unbounded<{ readonly key: string; readonly text: string }>();
  const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
  const refreshes = yield* Ref.make(0);
  const attempts = yield* Ref.make(0);
  const notify = yield* Ref.make<"ok" | "fail" | "crashAfterRecord">("ok");
  const refreshAuth = yield* Ref.make<"authenticated" | "unauthenticated">("authenticated");

  const registry = {
    getProviders: Ref.get(providers),
    get streamChanges() {
      return Stream.fromPubSub(providerChanges);
    },
    refreshInstance: (instanceId: ProviderInstanceId) =>
      Effect.gen(function* () {
        yield* Ref.update(refreshes, (count) => count + 1);
        const status = yield* Ref.get(refreshAuth);
        return (yield* Ref.get(providers)).map((entry) =>
          entry.instanceId === instanceId ? { ...entry, auth: { status } } : entry,
        );
      }),
  } as unknown as ProviderRegistry.ProviderRegistry["Service"];

  const settingsService = {
    getSettings: Ref.get(settings),
    get streamChanges() {
      return Stream.fromPubSub(settingsChanges);
    },
  } as unknown as Settings.ServerSettingsService["Service"];

  // Mirrors notifyUser: the key is recorded once, and a repeat reports already_sent.
  const autonomy = {
    notifyUser: (input: { readonly key: string; readonly text: string }) =>
      Effect.gen(function* () {
        yield* Ref.update(attempts, (count) => count + 1);
        const mode = yield* Ref.get(notify);
        if (mode === "fail") return yield* new AutonomyError({ reason: "invalid", message: "cap" });
        const already = (yield* Ref.get(delivered)).includes(input.key);
        if (!already) {
          yield* Ref.update(delivered, (keys) => [...keys, input.key]);
          yield* Queue.offer(sent, input);
        }
        if (mode === "crashAfterRecord") {
          return yield* new AutonomyError({ reason: "storage", message: "crash" });
        }
        return {
          status: already ? ("already_sent" as const) : ("sent" as const),
          channels: [],
          remainingToday: 10,
        };
      }),
  } as unknown as AutonomyService.AutonomyService["Service"];

  const harness: Harness = {
    setProviders: (next) =>
      Ref.set(providers, next).pipe(Effect.andThen(PubSub.publish(providerChanges, next))),
    setSettings: (patch) =>
      Ref.updateAndGet(settings, (current) => ({ ...current, ...patch })).pipe(
        Effect.flatMap((next) => PubSub.publish(settingsChanges, next)),
      ),
    sent,
    delivered,
    attempts,
    refreshes,
    notify,
    refreshAuth,
  };
  const deps = Layer.mergeAll(
    Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
    Layer.succeed(Settings.ServerSettingsService, settingsService),
    Layer.succeed(AutonomyService.AutonomyService, autonomy),
    ChannelLanguage.ChannelLanguage.layerFixed("en"),
  );
  return { harness, deps };
});

const database = NodeSqliteClient.layer({ filename: ":memory:" });

const seedDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureForkSchema();
  yield* sql`
    INSERT INTO assistants
      (assistant_id, handle, name, project_id, tool_access, thread_id, is_default, created_at, updated_at)
    VALUES ('jarvis', 'jarvis', 'Jarvis', 'p1', 'full', 'assistant:jarvis:1', 1, 't', 't')`;
});

const withService = <A, E>(
  body: (input: {
    readonly harness: Harness;
    readonly evaluate: UsageLimitAlerts["Service"]["evaluate"];
    readonly restart: Effect.Effect<UsageLimitAlerts["Service"]["evaluate"]>;
  }) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    yield* seedDatabase;
    const { harness, deps } = yield* makeHarness;
    const sqlLayer = Layer.succeed(SqlClient.SqlClient, yield* SqlClient.SqlClient);
    // No jitter, so the test can step the clock one interval at a time.
    const noJitter = Layer.succeed(Random.Random, {
      nextIntUnsafe: () => 0,
      nextDoubleUnsafe: () => 0,
    });
    const full = Layer.mergeAll(deps, sqlLayer, noJitter);
    let scope = yield* Scope.make();
    const build = Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(
        usageLimitAlertsLayer.pipe(Layer.provide(full)),
        scope,
      );
      return Context.get(context, UsageLimitAlerts);
    });
    const service = yield* build;
    const restart = Effect.gen(function* () {
      yield* Scope.close(scope, Exit.void);
      scope = yield* Scope.make();
      return (yield* build).evaluate;
    });
    const result = yield* body({ harness, evaluate: service.evaluate, restart });
    yield* Scope.close(scope, Exit.void);
    return result;
  }).pipe(Effect.provide(database));

const sentCount = (harness: Harness) => Queue.size(harness.sent);

describe("UsageLimitAlerts", () => {
  it.effect("tells the user once when a fresh reading crosses the default weekly threshold", () =>
    withService(({ harness, evaluate }) =>
      Effect.gen(function* () {
        // Arrives through the registry stream, as a turn's rate limit event does.
        yield* harness.setProviders([provider("claudeAgent", [weekly(85)])]);
        const message = yield* Queue.take(harness.sent);
        assert.equal(message.text, "Claude: 15% of the weekly limit left. Resets Mon 12:00.");
        assert.notInclude(message.text, "t3-thread://");
        assert.match(message.key, /^usage-limit:[0-9a-f]{40}$/);

        yield* evaluate([provider("claudeAgent", [weekly(85)])]);
        yield* evaluate([provider("claudeAgent", [weekly(86)])]);
        assert.equal(yield* sentCount(harness), 0);
        // A repeated reading is answered from memory: even a lost row is not read back.
        yield* (yield* SqlClient.SqlClient)`DELETE FROM usage_limit_alert_state`;
        yield* evaluate([provider("claudeAgent", [weekly(86)])]);
        assert.equal(yield* Ref.get(harness.attempts), 1);
      }),
    ),
  );

  it.effect("formats the reset in the server's zone when no client saved one", () =>
    withService(({ harness, evaluate }) =>
      Effect.gen(function* () {
        yield* harness.setSettings({ usageLimitAlerts: {} });
        const claude = provider("claudeAgent", [weekly(85)]);
        yield* evaluate([claude]);
        const message = yield* Queue.take(harness.sent);
        assert.equal(
          message.text,
          usageLimitAlertText({
            provider: claude,
            account: null,
            window: weekly(85),
            nowMs: 0,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            language: "en",
          }),
        );
      }),
    ),
  );

  it.effect("rearms after the window resets and after climbing back over the margin", () =>
    withService(({ harness, evaluate }) =>
      Effect.gen(function* () {
        yield* evaluate([provider("claudeAgent", [weekly(90)])]);
        yield* evaluate([provider("claudeAgent", [weekly(95, "1970-01-09T12:00:00.000Z")])]);
        yield* evaluate([provider("claudeAgent", [weekly(70, "1970-01-09T12:00:00.000Z")])]);
        yield* evaluate([provider("claudeAgent", [weekly(86, "1970-01-09T12:00:00.000Z")])]);
        const keys = yield* Ref.get(harness.delivered);
        assert.equal(keys.length, 3);
        assert.equal(new Set(keys).size, 3);
      }),
    ),
  );

  it.effect("does not send again after a restart with the same database", () =>
    withService(({ harness, evaluate, restart }) =>
      Effect.gen(function* () {
        yield* evaluate([provider("claudeAgent", [weekly(90)])]);
        const again = yield* restart;
        yield* again([provider("claudeAgent", [weekly(90)])]);
        yield* again([provider("claudeAgent", [weekly(91)])]);
        assert.equal((yield* Ref.get(harness.delivered)).length, 1);
      }),
    ),
  );

  it.effect.each(["fail", "crashAfterRecord"] as const)(
    "a send interrupted by %s is retried with the same key and reaches the user once",
    (mode) =>
      withService(({ harness, evaluate, restart }) =>
        Effect.gen(function* () {
          yield* Ref.set(harness.notify, mode);
          yield* evaluate([provider("claudeAgent", [weekly(90)])]);
          yield* Ref.set(harness.notify, "ok");
          const again = yield* restart;
          // A plain reading never resends; only the periodic check retries.
          yield* again([provider("claudeAgent", [weekly(90)])]);
          yield* again([provider("claudeAgent", [weekly(90)])], { retryPending: true });
          yield* again([provider("claudeAgent", [weekly(90)])], { retryPending: true });
          assert.equal((yield* Ref.get(harness.delivered)).length, 1);
        }),
      ),
  );

  it.effect("keeps instances and accounts apart", () =>
    withService(({ harness, evaluate }) =>
      Effect.gen(function* () {
        const work = provider("claude_work", [weekly(90)]);
        const home = provider("claudeAgent", [weekly(90)]);
        const codex = provider("codex", [{ ...weekly(90), id: "secondary" }], {
          driver: ProviderDriverKind.make("codex"),
        });
        yield* harness.setSettings({
          usageLimitAlerts: {
            ...utcAlerts,
            [codex.instanceId]: { windows: { secondary: 15 }, timeZone: "UTC" },
          },
        });
        yield* evaluate([work, home, codex]);
        const texts = (yield* Queue.takeAll(harness.sent)).map((entry) => entry.text);
        assert.deepStrictEqual(texts.toSorted(), [
          "Claude (claudeAgent@example.com): 10% of the weekly limit left. Resets Mon 12:00.",
          "Claude (claude_work@example.com): 10% of the weekly limit left. Resets Mon 12:00.",
          "Codex: 10% of the weekly limit left. Resets Mon 12:00.",
        ]);
        // The same instance signed in to another account is a slot of its own.
        yield* evaluate([
          { ...home, auth: { status: "authenticated", email: "other@example.com" } },
        ]);
        assert.equal(yield* sentCount(harness), 1);
      }),
    ),
  );

  it.effect("keeps a slot read before the probe reported the account with that account", () =>
    withService(({ harness, evaluate }) =>
      Effect.gen(function* () {
        yield* evaluate([
          provider("claudeAgent", [weekly(90)], { auth: { status: "authenticated" } }),
        ]);
        yield* evaluate([provider("claudeAgent", [weekly(91)])]);
        assert.equal((yield* Ref.get(harness.delivered)).length, 1);
      }),
    ),
  );

  it.effect("keeps reading the other windows while no assistant can send", () =>
    withService(({ harness, evaluate }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* harness.setSettings({ usageLimitAlerts: {} });
        yield* evaluate([provider("claude_b", [weekly(90)])]);
        yield* sql`UPDATE assistants SET archived_at = 't'`;
        // claude_a would send first; claude_b's climb back over the margin must still count.
        yield* evaluate([provider("claude_a", [weekly(90)]), provider("claude_b", [weekly(70)])]);
        yield* sql`UPDATE assistants SET archived_at = NULL`;
        yield* evaluate([provider("claude_b", [weekly(90)])]);
        assert.equal((yield* Ref.get(harness.delivered)).length, 2);
      }),
    ),
  );

  it.effect("stays quiet while an alert is off, Autonomy is paused or no assistant can send", () =>
    withService(({ harness, evaluate }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const claude = provider("claudeAgent", [
          weekly(90),
          { ...weekly(95), id: "five_hour", kind: "session", label: "Session" },
        ]);
        yield* harness.setSettings({
          usageLimitAlerts: { [claude.instanceId]: { windows: { seven_day: "off" } } },
        });
        yield* evaluate([claude]);
        yield* harness.setSettings({
          usageLimitAlerts: utcAlerts,
          autonomy: { ...autonomyOn, enabled: false },
        });
        yield* evaluate([claude]);
        yield* harness.setSettings({ autonomy: autonomyOn });
        yield* sql`UPDATE assistants SET archived_at = 't'`;
        yield* evaluate([claude]);
        assert.equal(yield* sentCount(harness), 0);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM usage_limit_alert_state WHERE armed = 0`,
          [],
        );

        // Nothing was consumed: once someone can send, the reading on hand tells the user.
        yield* sql`UPDATE assistants SET archived_at = NULL`;
        yield* evaluate([claude]);
        assert.equal(yield* sentCount(harness), 1);
      }),
    ),
  );

  it.effect(
    "ignores a retained reading of a window that already reset and a signed-out login",
    () =>
      withService(({ harness, evaluate }) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("1970-01-06T00:00:00.000Z"));
          yield* evaluate([provider("claudeAgent", [weekly(99)])]);
          yield* evaluate([
            provider("claudeAgent", [weekly(99, "1970-01-12T00:00:00.000Z")], {
              auth: { status: "unauthenticated" },
            }),
          ]);
          assert.equal(yield* sentCount(harness), 0);
        }),
      ),
  );

  it.effect(
    "checks only while an alert is on, once per interval, and backs off a failing login",
    () =>
      withService(({ harness }) =>
        Effect.gen(function* () {
          const claude = provider("claudeAgent", [weekly(10)]);
          yield* harness.setSettings({
            usageLimitAlerts: { [claude.instanceId]: { windows: { seven_day: "off" } } },
          });
          yield* harness.setProviders([claude]);
          yield* TestClock.adjust("1 day");
          assert.equal(yield* Ref.get(harness.refreshes), 0);

          const tick = TestClock.adjust("15 minutes").pipe(
            Effect.andThen(Ref.get(harness.refreshes)),
          );
          yield* harness.setSettings({ usageLimitAlerts: utcAlerts });
          // Lets the settings change reach the service before the clock moves an interval.
          yield* TestClock.adjust("1 second");
          assert.equal(yield* tick, 1);
          assert.equal(yield* tick, 2);

          // A signed-out probe waits 30, then 60 minutes before the next try.
          yield* Ref.set(harness.refreshAuth, "unauthenticated");
          assert.deepStrictEqual(
            yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7], () => tick),
            [3, 3, 4, 4, 4, 4, 5],
          );

          yield* harness.setSettings({ autonomy: { ...autonomyOn, enabled: false } });
          yield* TestClock.adjust("1 second");
          yield* TestClock.adjust("1 day");
          assert.equal(yield* Ref.get(harness.refreshes), 5);
        }),
      ),
  );
});
