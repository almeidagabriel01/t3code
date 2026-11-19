// @effect-diagnostics nodeBuiltinImport:off - Checks the queue file the way the plain-Node queue reads it.
/**
 * One server-wide watcher of the queue file that turns its transitions into heavy job notices for
 * every client. Grouping and never-repeat state live here, shared by all subscribers.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { type HeavyNoticeBatch, heavyHoldText } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import { SAMPLE_FRESH_MS } from "./admission.ts";
import { linuxState } from "./HeavyQueue.ts";
import {
  groupNotices,
  type HeavyEventRecord,
  type LinuxView,
  type OpenGroup,
  rawNotices,
  shownIn,
  stuckJobs,
} from "./heavyNotices.ts";
import * as QueueFile from "./queueFile.ts";

const INTERVAL = "2 seconds";

export class HeavyQueueNotices extends Context.Service<
  HeavyQueueNotices,
  {
    readonly stream: Stream.Stream<HeavyNoticeBatch>;
    /** Each record the queue file logged after the baseline, whatever the notice mode shows. */
    readonly records: Stream.Stream<HeavyEventRecord>;
  }
>()("t3/heavyQueue/HeavyQueueNotices") {}

/** Why the queue file cannot be read or written; null when it can (a missing file is an empty queue). */
export const queueFileError = (dir: string): string | null => {
  const file = NodePath.join(dir, "queue.json");
  try {
    JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return `Cannot read ${file}: ${(error as Error).message}`;
  }
  try {
    NodeFS.accessSync(dir, NodeFS.constants.W_OK);
    if (NodeFS.existsSync(file)) NodeFS.accessSync(file, NodeFS.constants.W_OK);
  } catch (error) {
    // A missing queue folder is created on the first job.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return `Cannot write ${file}: ${(error as Error).message}`;
  }
  return null;
};

const make = Effect.fn("HeavyQueueNotices.make")(function* (dir: string) {
  const settings = yield* ServerSettingsService;
  const notices = yield* PubSub.sliding<HeavyNoticeBatch>(16);
  const logged = yield* PubSub.sliding<HeavyEventRecord>(64);

  // Null until the first tick, which only takes the baseline: a restart replays nothing.
  let seen: ReadonlySet<string> | null = null;
  let linux: LinuxView | null = null;
  let stuckSeen = new Set<string>();
  let fileBroken = false;
  let open: ReadonlyMap<string, OpenGroup> = new Map();
  let toldMac = new Set<string>();

  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const fileError = queueFileError(dir);
    const { doc, plan } = QueueFile.readPlan(dir, now);
    const ids = new Set(doc.entries.map((entry) => entry.id));
    const records: ReadonlyArray<HeavyEventRecord> =
      seen === null ? [] : doc.events.filter((record) => !seen!.has(record.id));
    const fresh = doc.sample !== null && now - doc.sample.at <= SAMPLE_FRESH_MS;
    const hold = plan.mac?.hold ?? null;
    const stuck = stuckJobs({
      entries: doc.entries,
      routes: plan.routes,
      macHold: hold,
      macHoldText:
        hold === null
          ? null
          : hold === "job-memory" || hold === "job-cpu"
            ? "the job needs more than is free"
            : heavyHoldText(hold, fresh ? doc.sample : null, doc.maxRunning, doc.quickSlots),
      linuxOver: plan.linuxOver,
      usualMs: (entry, runner) => QueueFile.usualMs(doc, entry, runner),
      now,
    });
    const shown = linuxState(doc);
    const after: LinuxView | null = shown === null ? null : { ...shown, okAt: doc.linux.okAt };
    const raw = rawNotices({
      records,
      linuxBefore: seen === null ? null : linux,
      linuxAfter: after,
      stuck: seen === null ? [] : stuck.filter((job) => !stuckSeen.has(job.job.id)),
      queueFileError: fileError !== null && !fileBroken && seen !== null ? fileError : null,
      toldMac,
    });

    seen = new Set(doc.events.map((record) => record.id));
    linux = after;
    stuckSeen = new Set([
      ...stuck.map((job) => job.job.id),
      ...[...stuckSeen].filter((id) => ids.has(id)),
    ]);
    fileBroken = fileError !== null;
    toldMac = new Set([
      ...[...toldMac].filter((id) => ids.has(id)),
      ...records.flatMap((record) =>
        record.kind === "linux-lost" && record.followUp === "mac" ? [record.job.id] : [],
      ),
    ]);

    if (records.length > 0) yield* PubSub.publishAll(logged, records);
    const mode = (yield* settings.getSettings).heavyNotices;
    const grouped = groupNotices(
      raw.filter((notice) => shownIn(mode, notice)),
      open,
      now,
    );
    open = grouped.open;
    if (grouped.batch.length > 0) yield* PubSub.publish(notices, grouped.batch);
  });

  yield* tick.pipe(
    Effect.ignore({ log: true }),
    Effect.andThen(Effect.sleep(INTERVAL)),
    Effect.forever,
    Effect.forkScoped,
  );

  return HeavyQueueNotices.of({
    stream: Stream.fromPubSub(notices),
    records: Stream.fromPubSub(logged),
  });
});

export const layer = (dir: string = QueueFile.defaultQueueDir()) =>
  Layer.effect(HeavyQueueNotices, make(dir));
