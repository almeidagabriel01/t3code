import {
  dedupeProviderSkillsByName,
  describeCatalogEntry,
  isProviderSkillUserInvocable,
} from "@t3tools/client-runtime/providerSkills";
import type { ServerProviderSkill } from "@t3tools/contracts";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandPopover";
import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";

export function buildComposerSkillItem(input: {
  readonly skill: ServerProviderSkill;
  readonly label: string;
  readonly catalogScanning: boolean;
  readonly fallback: string;
}): Extract<ComposerCommandItem, { type: "skill" }> {
  const { skill } = input;
  return {
    id: `skill:${skill.name}`,
    type: "skill",
    skill,
    label: input.label,
    description: describeCatalogEntry(
      skill.shortDescription ?? skill.description,
      input.catalogScanning,
      skill.scope ? `${skill.scope} skill` : input.fallback,
    ),
  };
}

/** The skills a `/` menu lists for its query, after the provider's own commands. */
export function composerSlashSkillItems(
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
  query: string,
  catalogScanning: boolean,
) {
  return visibleSkills
    .filter((skill) => matchesSlashSkillQuery(skill, query))
    .map((skill) =>
      buildComposerSkillItem({
        skill,
        label: `skill:${skill.name}`,
        catalogScanning,
        fallback: "",
      }),
    );
}

/** The skills a `$` menu offers, best match first: the first 20 while nothing is typed. */
export function composerSkillItems(
  skills: ReadonlyArray<ServerProviderSkill>,
  query: string,
  catalogScanning: boolean,
): Array<Extract<ComposerCommandItem, { type: "skill" }>> {
  const enabledSkills = dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable));
  const normalizedQuery = normalizeSearchQuery(query, {
    trimLeadingPattern: /^\p{Sc}+/u,
  });

  if (!normalizedQuery) {
    return enabledSkills.slice(0, 20).map((skill) =>
      buildComposerSkillItem({
        skill,
        label: skill.displayName ?? skill.name,
        catalogScanning,
        fallback: "Run provider skill",
      }),
    );
  }

  const ranked: Array<{
    item: (typeof enabledSkills)[number];
    score: number;
    tieBreaker: string;
  }> = [];
  for (const skill of enabledSkills) {
    const displayLabel = (skill.displayName ?? skill.name).toLowerCase();
    const scores = [
      scoreQueryMatch({
        value: skill.name.toLowerCase(),
        query: normalizedQuery,
        exactBase: 0,
        prefixBase: 2,
        boundaryBase: 4,
        includesBase: 6,
        fuzzyBase: 100,
        boundaryMarkers: ["-", "_", "/"],
      }),
      scoreQueryMatch({
        value: displayLabel,
        query: normalizedQuery,
        exactBase: 1,
        prefixBase: 3,
        boundaryBase: 5,
        includesBase: 7,
        fuzzyBase: 110,
      }),
      scoreQueryMatch({
        value: skill.shortDescription?.toLowerCase() ?? "",
        query: normalizedQuery,
        exactBase: 20,
        prefixBase: 22,
        boundaryBase: 24,
        includesBase: 26,
      }),
      scoreQueryMatch({
        value: skill.description?.toLowerCase() ?? "",
        query: normalizedQuery,
        exactBase: 30,
        prefixBase: 32,
        boundaryBase: 34,
        includesBase: 36,
      }),
    ].filter((score): score is number => score !== null);

    if (scores.length > 0) {
      insertRankedSearchResult(
        ranked,
        {
          item: skill,
          score: Math.min(...scores),
          tieBreaker: `${displayLabel}\u0000${skill.name}`,
        },
        20,
      );
    }
  }

  return ranked.map(({ item: skill }) =>
    buildComposerSkillItem({
      skill,
      label: skill.displayName ?? skill.name,
      catalogScanning,
      fallback: "Run provider skill",
    }),
  );
}
