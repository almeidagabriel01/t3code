import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** A root process T3 started on behalf of something the user can name. */
export type ProcessOwner =
  | { readonly kind: "agent"; readonly pid: number; readonly threadId: string }
  | { readonly kind: "device-hub"; readonly pid: number }
  /** Kept on the server: the telemetry wire carries only agent and device-hub owners. */
  | {
      readonly kind: "terminal";
      readonly pid: number;
      readonly threadId: string;
      readonly terminalId: string;
    };

export interface ProcessOwnersShape {
  readonly register: (owner: ProcessOwner) => Effect.Effect<void>;
  readonly list: Effect.Effect<ReadonlyArray<ProcessOwner>>;
  /** Forgets owners whose process is gone. */
  readonly retain: (livePids: ReadonlySet<number>) => Effect.Effect<void>;
}

export const ProcessOwners = Context.Reference<ProcessOwnersShape>(
  "@t3tools/shared/ProcessOwners",
  {
    defaultValue: () => ({
      register: () => Effect.void,
      list: Effect.succeed([]),
      retain: () => Effect.void,
    }),
  },
);

/** Skips a missing or invalid pid, which a failed spawn leaves behind. */
export const registerOwner = Effect.fnUntraced(function* (owner: ProcessOwner) {
  const owners = yield* ProcessOwners;
  if (Number.isInteger(owner.pid) && owner.pid > 0) yield* owners.register(owner);
});
