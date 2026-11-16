import { assert, describe, it } from "@effect/vitest";
import {
  AssistantId,
  type AssistantsEvent,
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

import * as AssistantService from "../assistants/AssistantService.ts";
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

/** Indexes of the readings that send. */
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

describe("decideUsageLimitAlert", () => {
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
      "a jump straight to 0% sends once",
      [
        [40, DAY],
        [0, DAY],
      ],
      [1],
    ],
    [
      "climbing back from 0% in the same window stays quiet",
      [
        [40, DAY],
        [0, DAY],
        [3, DAY],
        [14, DAY],
        [10, DAY],
      ],
      [1],
    ],
    [
      "a new window after 0% rearms",
      [
        [40, DAY],
        [0, DAY],
        [10, DAY + 7 * DAY],
      ],
      [1, 2],
    ],
    [
      "falling from the threshold to 0% sends no second threshold alert",
      [
        [15, DAY],
        [5, DAY],
        [0, DAY],
      ],
      [0],
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
    assert.equal(
      text({ language: "pt-BR", timeZone: "America/Sao_Paulo" }),
      "Claude Max: restam 15% do limite semanal. Renova sex., 12:30.",
    );
  });

  it("says the limit ran out at 0% instead of 0% left", () => {
    const spent = weekly(100, "1970-01-02T15:30:00.000Z");
    assert.equal(
      text({ window: spent }),
      "Claude Max: the weekly limit ran out. Resets Fri 15:30.",
    );
    assert.equal(
      text({ window: spent, language: "pt-BR", timeZone: "America/Sao_Paulo" }),
      "Claude Max: o limite semanal acabou. Renova sex., 12:30.",
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
  /** Archives or restores the default assistant; `announce` publishes the change like the service does. */
  readonly setDefaultAssistant: (active: boolean, announce: boolean) => Effect.Effect<void>;
}

const autonomyOn = { ...DEFAULT_SERVER_SETTINGS.autonomy, enabled: true };
// Every instance the tests use, saved from a UTC client, so the reset time reads the same anywhere.
const alerts = (
  instances: Record<string, ServerSettings["usageLimitAlerts"]["instances"][ProviderInstanceId]>,
  ignoreAutonomyPause = true,
): ServerSettings["usageLimitAlerts"] => ({ ignoreAutonomyPause, instances });
// Every instance the tests use, saved from a UTC client, so the reset time reads the same anywhere.
const utcAlerts = alerts(
  Object.fromEntries(
    ["claudeAgent", "claude_work", "codex"].map((id) => [id, { windows: {}, timeZone: "UTC" }]),
  ),
);
const pausedOff = { ...autonomyOn, enabled: false };

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
  const assistantChanges = yield* PubSub.unbounded<AssistantsEvent>();
  const sql = yield* SqlClient.SqlClient;

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

  // Mirrors notifyUsageLimitAlert: the key is recorded once, and a repeat reports already_sent.
  const autonomy = {
    notifyUsageLimitAlert: (input: { readonly key: string; readonly text: string }) =>
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

  const assistants = {
    subscribeChanges: PubSub.subscribe(assistantChanges),
  } as unknown as AssistantService.AssistantService["Service"];

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
    setDefaultAssistant: (active, announce) =>
      sql`UPDATE assistants SET archived_at = ${active ? null : "t"}`.pipe(
        Effect.andThen(
          announce
            ? PubSub.publish(assistantChanges, {
                type: "removed",
                assistantId: AssistantId.make("jarvis"),
              })
            : Effect.void,
        ),
        Effect.asVoid,
        Effect.orDie,
      ),
  };
  const deps = Layer.mergeAll(
    Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
    Layer.succeed(Settings.ServerSettingsService, settingsService),
    Layer.succeed(AutonomyService.AutonomyService, autonomy),
    Layer.succeed(AssistantService.AssistantService, assistants),
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
        yield* harness.setSettings({ usageLimitAlerts: alerts({}) });
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
          // The registry holds the reading the boot probe publishes; no check interval passes.
          yield* harness.setProviders([provider("claudeAgent", [weekly(90)])]);
          assert.equal(yield* Ref.get(harness.attempts), 1);
          yield* restart;
          assert.equal(yield* Ref.get(harness.attempts), 2);
          // Confirmed now, so later boots stay quiet.
          yield* restart;
          yield* restart;
          assert.equal(yield* Ref.get(harness.attempts), 2);
          assert.equal((yield* Ref.get(harness.delivered)).length, 1);
        }),
      ),
  );

  it.effect("keeps instances and accounts apart", () =>
    withService(({ harness, evaluate }) =>
      Effect.gen(function* () {
        const work = provider("claude_work", [weekly(90)], {
          auth: { status: "authenticated", email: "claude_work@example.com", label: "Work" },
        });
        const home = provider("claudeAgent", [weekly(90)]);
        // 15.4% left reads "15%" on Limits, so the 15% alert sends.
        const codex = provider("codex", [{ ...weekly(84.6), id: "secondary" }], {
          driver: ProviderDriverKind.make("codex"),
        });
        yield* harness.setSettings({
          usageLimitAlerts: alerts({
            ...utcAlerts.instances,
            [codex.instanceId]: { windows: { secondary: 15 }, timeZone: "UTC" },
          }),
        });
        yield* evaluate([work, home, codex]);
        const texts = (yield* Queue.takeAll(harness.sent)).map((entry) => entry.text);
        assert.deepStrictEqual(texts.toSorted(), [
          "Claude (Work): 10% of the weekly limit left. Resets Mon 12:00.",
          "Claude (claudeAgent@example.com): 10% of the weekly limit left. Resets Mon 12:00.",
          "Codex: 15% of the weekly limit left. Resets Mon 12:00.",
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
        yield* harness.setSettings({ usageLimitAlerts: alerts({}) });
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

  it.effect("sends while Autonomy is paused only when the alert may ignore the pause", () =>
    withService(({ harness, evaluate }) =>
      Effect.gen(function* () {
        yield* harness.setSettings({
          autonomy: pausedOff,
          usageLimitAlerts: alerts(utcAlerts.instances, false),
        });
        yield* evaluate([provider("claudeAgent", [weekly(90)])]);
        assert.equal(yield* Ref.get(harness.attempts), 0);

        // The reading kept its slot, so turning the setting on tells the user once.
        yield* harness.setSettings({ usageLimitAlerts: utcAlerts });
        yield* evaluate([provider("claudeAgent", [weekly(90)])]);
        yield* evaluate([provider("claudeAgent", [weekly(91)])]);
        yield* evaluate([provider("claudeAgent", [weekly(90)])], { retryPending: true });
        assert.equal((yield* Ref.get(harness.delivered)).length, 1);
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
          usageLimitAlerts: alerts({ [claude.instanceId]: { windows: { seven_day: "off" } } }),
        });
        yield* evaluate([claude]);
        yield* harness.setSettings({
          usageLimitAlerts: alerts(utcAlerts.instances, false),
          autonomy: pausedOff,
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
            usageLimitAlerts: alerts({ [claude.instanceId]: { windows: { seven_day: "off" } } }),
          });
          yield* harness.setProviders([claude]);
          yield* TestClock.adjust("1 day");
          assert.equal(yield* Ref.get(harness.refreshes), 0);

          const tick = TestClock.adjust("15 minutes").pipe(
            Effect.andThen(Ref.get(harness.refreshes)),
          );
          // With no assistant to send it, an alert is no reason to probe.
          yield* harness.setDefaultAssistant(false, true);
          yield* harness.setSettings({ usageLimitAlerts: utcAlerts });
          // Lets the settings change reach the service before the clock moves an interval.
          yield* TestClock.adjust("1 second");
          assert.equal(yield* tick, 0);
          yield* harness.setDefaultAssistant(true, true);
          yield* TestClock.adjust("1 second");
          assert.equal(yield* tick, 1);
          assert.equal(yield* tick, 2);
          // A running check rereads the assistant, even when no change was announced.
          yield* harness.setDefaultAssistant(false, false);
          assert.equal(yield* tick, 2);
          yield* harness.setDefaultAssistant(true, false);
          // Alerts that may ignore the pause keep checking with Autonomy off.
          yield* harness.setSettings({ autonomy: pausedOff });
          yield* TestClock.adjust("1 second");
          assert.equal(yield* tick, 3);

          // A signed-out probe waits 30, then 60 minutes before the next try.
          yield* Ref.set(harness.refreshAuth, "unauthenticated");
          assert.deepStrictEqual(
            yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7], () => tick),
            [4, 4, 5, 5, 5, 5, 6],
          );

          yield* harness.setSettings({ usageLimitAlerts: alerts(utcAlerts.instances, false) });
          yield* TestClock.adjust("1 second");
          yield* TestClock.adjust("1 day");
          assert.equal(yield* Ref.get(harness.refreshes), 6);
        }),
      ),
  );

  it.effect.each<{ readonly name: string; readonly run: Effect.Effect<void> }>([
    {
      name: "a saved zone that no longer exists falls back to the server's zone",
      run: Effect.sync(() => {
        const window = weekly(85, "1970-01-02T15:30:00.000Z");
        const text = (timeZone: string) =>
          usageLimitAlertText({
            provider: provider("claudeAgent", [window]),
            account: null,
            window,
            nowMs: 0,
            timeZone,
            language: "en",
          });
        assert.equal(text("Not/AZone"), text(Intl.DateTimeFormat().resolvedOptions().timeZone));
      }),
    },
    {
      name: "a threshold of 96 to 99 rearms once the window is back to 100%",
      run: Effect.sync(() => {
        for (const threshold of [96, 99]) {
          const readings = [
            [threshold, DAY],
            [100, DAY],
            [threshold, DAY],
          ] as const;
          assert.deepStrictEqual(run(readings, threshold), [0, 2], `threshold ${threshold}`);
        }
      }),
    },
    {
      name: "an instance that reports no account looks its stored account up once",
      run: withService(({ evaluate }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const anonymous = (usedPercent: number) =>
            provider("claudeAgent", [weekly(usedPercent)], { auth: { status: "authenticated" } });
          yield* evaluate([anonymous(50)]);
          // Written behind the service's back: a kept lookup, even "none found", never sees it.
          yield* sql`
            INSERT INTO usage_limit_alert_state
              (instance_id, account_key, window_id, armed, episode, updated_at)
            VALUES ('claudeAgent', 'someone', 'five_hour', 1, 0, '9999')`;
          yield* evaluate([anonymous(90)]);
          assert.deepStrictEqual(
            yield* sql`SELECT account_key FROM usage_limit_alert_state WHERE window_id = 'seven_day'`,
            [{ account_key: "" }],
          );
        }),
      ).pipe(Effect.orDie),
    },
  ])("$name", ({ run }) => run);
});
