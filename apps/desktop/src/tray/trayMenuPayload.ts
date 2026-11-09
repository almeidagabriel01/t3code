import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isMaxLength(1_000));
const Id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200));
const Threads = Schema.Array(
  Schema.Struct({
    environmentId: Id,
    threadId: Id,
    title: Text,
    project: Schema.NullOr(Text),
    environment: Schema.NullOr(Text),
  }),
).check(Schema.isMaxLength(20));

/** The renderer sends null to remove the icon. */
export const TrayMenuPayload = Schema.NullOr(
  Schema.Struct({
    attention: Threads,
    running: Threads,
    pinned: Threads,
    attentionCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  }),
);
