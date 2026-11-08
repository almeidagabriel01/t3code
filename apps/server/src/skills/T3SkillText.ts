import { isT3SkillName } from "@t3tools/contracts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSettings from "../serverSettings.ts";
import { makeGlobalSkills } from "./GlobalSkills.ts";

/**
 * The provider text with the T3-global skills the message names in front, read from disk at send
 * time. A skill switched off, a missing skills folder, or unreadable settings add nothing, so a
 * disabled skill never arrives by accident.
 */
export const providerTextWithSkills = Effect.fn("T3SkillText.providerText")(function* (
  settings: Option.Option<Pick<ServerSettings.ServerSettingsService["Service"], "getSettings">>,
  input: { readonly text: string; readonly globalSkillsDir: string | undefined },
) {
  const names = [...input.text.matchAll(SKILL_MENTION_PATTERN)]
    .map((match) => match[2] ?? "")
    .filter(isT3SkillName);
  // A slash command must stay first in the text for the provider to parse it.
  if (
    input.text.trimStart().startsWith("/") ||
    names.length === 0 ||
    input.globalSkillsDir === undefined ||
    Option.isNone(settings)
  )
    return input.text;
  const disabled = yield* settings.value.getSettings.pipe(
    Effect.map((current) => Option.some(current.disabledGlobalSkills)),
    Effect.catch((cause) =>
      Effect.logWarning("T3 skill not delivered: settings unreadable.", { cause }).pipe(
        Effect.as(Option.none()),
      ),
    ),
  );
  if (Option.isNone(disabled)) return input.text;
  const skills = yield* makeGlobalSkills({
    globalSkillsDir: input.globalSkillsDir,
    disabled: Effect.succeed(disabled.value),
  }).readForTurn(names);
  return skills ? `${skills}\n\n${input.text}` : input.text;
});
