import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isMaxLength(1_000));
/** Native subagent thread ids embed the provider's own ids and run well past 200 characters. */
const Id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096));

export const TrayMenuThread = Schema.Struct({
  environmentId: Id,
  threadId: Id,
  title: Text,
  project: Schema.NullOr(Text),
  environment: Schema.NullOr(Text),
});

/** Rows are read one by one in the handler, so one unreadable row never blanks the menu. */
const Rows = Schema.Array(Schema.Unknown).check(Schema.isMaxLength(20));

/** The renderer sends null to remove the icon. */
export const TrayMenuPayload = Schema.NullOr(
  Schema.Struct({
    attention: Rows,
    running: Rows,
    pinned: Rows,
    attentionCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  }),
);
