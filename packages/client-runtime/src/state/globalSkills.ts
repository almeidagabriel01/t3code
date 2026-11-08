import {
  GLOBAL_SKILLS_WS_METHODS,
  T3_SKILL_SCOPE,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createGlobalSkillsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:remove",
      tag: GLOBAL_SKILLS_WS_METHODS.globalSkillsRemove,
    }),
    rescan: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:rescan",
      tag: GLOBAL_SKILLS_WS_METHODS.globalSkillsRescan,
    }),
  };
}

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

/** The server publishes T3 skills inside every provider's skill list; one copy each. */
export function t3SkillsOf(
  providers: ReadonlyArray<{ readonly skills: ReadonlyArray<ServerProviderSkill> }> | undefined,
): ReadonlyArray<ServerProviderSkill> {
  const byName = new Map<string, ServerProviderSkill>();
  for (const provider of providers ?? [])
    for (const skill of provider.skills)
      if (skill.scope === T3_SKILL_SCOPE && !byName.has(skill.name)) byName.set(skill.name, skill);
  return byName.size === 0 ? NO_SKILLS : [...byName.values()];
}
