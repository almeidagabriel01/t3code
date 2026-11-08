import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { ServerProviderSkill } from "./server.ts";

export const GLOBAL_SKILLS_WS_METHODS = {
  globalSkillsRemove: "skills.globalRemove",
  globalSkillsRescan: "skills.globalRescan",
} as const;
export class GlobalSkillsRpcError extends Schema.TaggedError<GlobalSkillsRpcError>()(
  "GlobalSkillsRpcError",
  { message: Schema.String },
) {}
const errors = Schema.Union([GlobalSkillsRpcError, EnvironmentAuthorizationError]);
const success = Schema.Struct({
  globalSkillsDir: Schema.String,
  skills: Schema.Array(ServerProviderSkill),
});
export const WsGlobalSkillsRemoveRpc = Rpc.make(GLOBAL_SKILLS_WS_METHODS.globalSkillsRemove, {
  payload: Schema.Struct({ name: Schema.String }),
  success,
  error: errors,
});
export const WsGlobalSkillsRescanRpc = Rpc.make(GLOBAL_SKILLS_WS_METHODS.globalSkillsRescan, {
  payload: Schema.Struct({}),
  success,
  error: errors,
});
