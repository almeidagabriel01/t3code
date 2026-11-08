import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const T3_SKILL_SCOPE = "t3";
export const T3_SKILL_NAME_PREFIX = "t3:";
export const isT3SkillName = (name: string): boolean => name.startsWith(T3_SKILL_NAME_PREFIX);

export const T3GlobalSkillSettingsFields = {
  disabledGlobalSkills: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
};
export const T3GlobalSkillSettingsPatchFields = {
  disabledGlobalSkills: Schema.optionalKey(Schema.Array(Schema.String)),
};
