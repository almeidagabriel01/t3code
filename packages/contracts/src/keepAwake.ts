import * as Schema from "effect/Schema";

/** What the host is doing to stay awake, not what the setting asks for. */
export const KeepAwakeStatus = Schema.Struct({
  /** False when this host has no way to hold off sleep. */
  supported: Schema.Boolean,
  /** True only while the OS inhibitor process is running. */
  active: Schema.Boolean,
});
export type KeepAwakeStatus = typeof KeepAwakeStatus.Type;

export const KeepAwakeSubscribeStatusInput = Schema.Struct({});
