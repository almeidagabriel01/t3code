import { assistantGroupMentionHref } from "@t3tools/client-runtime/assistantGroupChat";
import { assistantRobotLook } from "@t3tools/client-runtime/assistantRobot";
import { assistantGroupProjectSlug, type Assistant } from "@t3tools/contracts";

import { contextChipPresentation, type ContextChipIconRef } from "./composerChipPresentation";

/** A group chat's members (`@handle`) and projects (`#slug`), which the editor draws as their own chips. */
export interface ComposerGroupMentions {
  readonly members: ReadonlyArray<{
    readonly handle: string;
    readonly name: string;
    readonly accent: string;
  }>;
  readonly projects: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
}

const EVERYONE = { handle: "everyone", name: "Everyone", accent: "#0096af" } as const;
const PROJECT_ACCENT = contextChipPresentation("file").accent ?? "#0090cd";
const MEMBER_ICON: ContextChipIconRef = { kind: "chip", name: "bot" };
const PROJECT_ICON: ContextChipIconRef = { kind: "chip", name: "folder" };

const hex = (value: number) =>
  Math.round(value * 255)
    .toString(16)
    .padStart(2, "0");

/** The member's face colour, as its avatar draws it (`hsl(hue, 60%, 45%)`), in hex for native chips. */
function memberAccent(member: Pick<Assistant, "id" | "avatar">): string {
  const hue = assistantRobotLook(member).hue;
  const saturation = 0.6;
  const lightness = 0.45;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    return lightness - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return `#${hex(channel(0))}${hex(channel(8))}${hex(channel(4))}`;
}

export function composerGroupMentions(
  members: ReadonlyArray<Pick<Assistant, "id" | "avatar" | "handle" | "name">>,
  projects: ReadonlyArray<{ readonly name: string }>,
): ComposerGroupMentions {
  return {
    members: [
      ...members.map((member) => ({
        handle: member.handle.toLowerCase(),
        name: member.name,
        accent: memberAccent(member),
      })),
      EVERYONE,
    ],
    projects: projects.map((project) => ({
      slug: assistantGroupProjectSlug(project.name),
      name: project.name,
    })),
  };
}

/** What the shared token parser needs to tell members and projects from file mentions. */
export function groupMentionTokenOptions(mentions: ComposerGroupMentions | undefined) {
  return mentions === undefined
    ? {}
    : {
        memberHandles: mentions.members.map((member) => member.handle),
        projectSlugs: mentions.projects.map((project) => project.slug),
      };
}

/** A member or project token's chip: the name as label, a face or folder icon, and its colour. */
export function groupMentionChip(
  token: { readonly type: string; readonly value: string },
  mentions: ComposerGroupMentions | undefined,
): { readonly label: string; readonly icon: ContextChipIconRef; readonly accent: string } | null {
  if (mentions === undefined) return null;
  if (token.type === "member") {
    const member = mentions.members.find((entry) => entry.handle === token.value);
    return member === undefined
      ? null
      : { label: member.name, icon: MEMBER_ICON, accent: member.accent };
  }
  if (token.type === "project") {
    const project = mentions.projects.find((entry) => entry.slug === token.value);
    return project === undefined
      ? null
      : { label: project.name, icon: PROJECT_ICON, accent: PROJECT_ACCENT };
  }
  return null;
}

/** A pressed chip is a member or project: it opens nothing. */
export function isGroupMentionSource(source: string, mentions: ComposerGroupMentions | undefined) {
  const value = source.slice(1).toLowerCase();
  const type = source.startsWith("@") ? "member" : source.startsWith("#") ? "project" : null;
  return type !== null && groupMentionChip({ type, value }, mentions) !== null;
}

/** The chip a message's member or project link draws. */
export function groupMentionLinkChip(href: string, mentions: ComposerGroupMentions) {
  const named = assistantGroupMentionHref(href);
  return named === null
    ? null
    : groupMentionChip({ type: named.kind, value: named.value }, mentions);
}
