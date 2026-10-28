import * as Schema from "effect/Schema";

import { PositiveInt, ProjectId } from "./baseSchemas.ts";

export const ListeningPort = Schema.Struct({
  port: PositiveInt,
  /** Bind address as the host reports it: `127.0.0.1`, `::1`, `0.0.0.0`, `*`, ... */
  host: Schema.String,
  pid: Schema.NullOr(PositiveInt),
  processName: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(ProjectId),
});
export type ListeningPort = typeof ListeningPort.Type;

export const ListeningPortList = Schema.Array(ListeningPort);
export type ListeningPortList = typeof ListeningPortList.Type;

export const KillListeningPortInput = Schema.Struct({
  pid: PositiveInt,
  port: PositiveInt,
});
export type KillListeningPortInput = typeof KillListeningPortInput.Type;

export const KillListeningPortResult = Schema.Struct({
  outcome: Schema.Literals(["terminated", "killed", "already-exited"]),
});
export type KillListeningPortResult = typeof KillListeningPortResult.Type;

export class KillListeningPortError extends Schema.TaggedError<KillListeningPortError>()(
  "KillListeningPortError",
  {
    reason: Schema.Literals(["not-found", "protected", "unsupported", "signal-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "not-found":
        return "That process no longer holds this port.";
      case "protected":
        return "This process is T3 Code itself or the app hosting it, so it can't be killed from here.";
      case "unsupported":
        return "Killing processes is not supported on this environment's platform.";
      case "signal-failed":
        return "The process could not be signaled.";
    }
  }
}
