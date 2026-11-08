import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as ServerSettings from "../serverSettings.ts";
import type { ProviderWorkspaceSnapshot } from "@t3tools/provider-core/server/driver";
import { makeGlobalSkills } from "./GlobalSkills.ts";
import { isT3SkillName, type ServerProvider, type ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export function mergeGlobalSkills(
  provider: ServerProvider,
  global: ReadonlyArray<ServerProviderSkill>,
): ServerProvider {
  const merge = (skills: ReadonlyArray<ServerProviderSkill>) => [
    ...global,
    ...skills.filter((skill) => !isT3SkillName(skill.name)),
  ];
  return {
    ...provider,
    skills: merge(provider.skills),
    ...(provider.workspaceSnapshots === undefined
      ? {}
      : {
          workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
            ...snapshot,
            skills: merge(snapshot.skills),
          })),
        }),
  };
}

export function makeGlobalSkillInventory(
  root: string,
  settings: Option.Option<ServerSettings.ServerSettingsService["Service"]>,
) {
  const scan = Option.isNone(settings)
    ? Effect.logWarning("Global skills withheld: settings service unavailable.").pipe(
        Effect.as([] as ReadonlyArray<ServerProviderSkill>),
      )
    : settings.value.getSettings.pipe(
        Effect.flatMap((current) =>
          makeGlobalSkills({
            globalSkillsDir: root,
            disabled: Effect.succeed(current.disabledGlobalSkills),
          }).list(),
        ),
        Effect.tapError((cause) =>
          Effect.logWarning("Global skills scan failed; withholding skills", { cause }),
        ),
        Effect.orElseSucceed(() => [] as ReadonlyArray<ServerProviderSkill>),
      );
  const workspace = (provider: ServerProvider) => (snapshot: ProviderWorkspaceSnapshot) =>
    scan.pipe(
      Effect.map((globals) => ({
        ...snapshot,
        skills: mergeGlobalSkills({ ...provider, skills: snapshot.skills }, globals).skills,
      })),
    );
  const rescan = (
    update: (
      f: (providers: ReadonlyArray<ServerProvider>) => ReadonlyArray<ServerProvider>,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>,
  ) =>
    scan.pipe(
      Effect.flatMap((globals) =>
        update((providers) => providers.map((provider) => mergeGlobalSkills(provider, globals))),
      ),
    );
  const watch = (refresh: Effect.Effect<ReadonlyArray<ServerProvider>>) =>
    Option.isSome(settings)
      ? Effect.gen(function* () {
          const changes = yield* settings.value.subscribeChanges;
          yield* Stream.runForEach(changes, () => refresh).pipe(Effect.forkScoped);
        })
      : Effect.void;
  return { scan, workspace, rescan, watch };
}
