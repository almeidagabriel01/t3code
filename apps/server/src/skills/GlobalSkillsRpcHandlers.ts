import { GlobalSkillsRpcError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { makeGlobalSkills } from "./GlobalSkills.ts";

export function makeGlobalSkillsHandlers(
  globalSkillsDir: string,
  settings: Pick<ServerSettings.ServerSettingsService["Service"], "getSettings">,
  providers: Pick<ProviderRegistry.ProviderRegistry["Service"], "rescanGlobalSkills">,
) {
  const scan = Effect.fn("GlobalSkills.rescan")(function* () {
    const current = yield* settings.getSettings;
    const skills = makeGlobalSkills({
      globalSkillsDir,
      disabled: Effect.succeed(current.disabledGlobalSkills),
    });
    if (providers.rescanGlobalSkills === undefined) {
      return yield* new GlobalSkillsRpcError({ message: "Global skill refresh is unavailable." });
    }
    yield* providers.rescanGlobalSkills;
    return { globalSkillsDir: skills.globalSkillsDir, skills: yield* skills.list() };
  });
  const remove = Effect.fn("GlobalSkills.removeAndRescan")(function* (name: string) {
    const skills = makeGlobalSkills({ globalSkillsDir, disabled: Effect.succeed([]) });
    yield* skills.remove(name);
    return yield* scan();
  });
  return {
    globalSkillsRemove: ({ name }: { readonly name: string }) =>
      remove(name).pipe(
        Effect.mapError(
          () => new GlobalSkillsRpcError({ message: "Could not remove global skill." }),
        ),
      ),
    globalSkillsRescan: () =>
      scan().pipe(
        Effect.mapError(
          () => new GlobalSkillsRpcError({ message: "Could not rescan global skills." }),
        ),
      ),
  };
}
