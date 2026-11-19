import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DEFAULT_HOSTED_APP_URL } from "./connectAuth.ts";

export const SETTINGS_LINK_PROTOCOL = "t3-settings";
const V1_PREFIX = `${SETTINGS_LINK_PROTOCOL}://v1/`;
const PAGE = /^[a-z][a-z0-9-]*$/;

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);

/** `page` is a settings page id both clients know, such as `integrations`; `entry` is a row on it. */
export interface SettingsLink {
  readonly environmentId: EnvironmentId;
  readonly page: string;
  readonly entry?: string | undefined;
}

/** Parsed tolerantly: a missing or unusable part is null, and a client opens Settings root for it. */
export interface ParsedSettingsLink {
  readonly environmentId: EnvironmentId | null;
  readonly page: string | null;
  readonly entry: string | null;
}

// Escapes even URL-safe punctuation, so a `)` or a sentence's period never ends the Markdown link.
const segment = (value: string) =>
  encodeURIComponent(value).replace(
    /[.!~*'()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const decoded = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

// The entry rides in the fragment: CommonMark keeps `#` in a link destination, and a query's `&`
// would need escaping in some renderers.
export function formatSettingsLink(link: SettingsLink): string {
  const fragment = link.entry ? `#${segment(link.entry)}` : "";
  return `${V1_PREFIX}${segment(link.environmentId)}/${link.page}${fragment}`;
}

/** The same page in the hosted app, for clients outside T3 Code. */
export function hostedSettingsLink(link: SettingsLink, origin = DEFAULT_HOSTED_APP_URL): string {
  const search = new URLSearchParams({ machine: link.environmentId });
  if (link.entry) search.set("entry", link.entry);
  return new URL(`/settings/${link.page}?${search}`, origin).toString();
}

export function parseSettingsLinkHref(href: string): ParsedSettingsLink | null {
  if (!href.startsWith(V1_PREFIX)) return null;
  const rest = href.slice(V1_PREFIX.length);
  const hash = rest.indexOf("#");
  const path = hash < 0 ? rest : rest.slice(0, hash);
  const entry = hash < 0 ? null : decoded(rest.slice(hash + 1)) || null;
  const parts = path.split("/");
  const [environment, page] = parts.length > 1 ? parts : [undefined, parts[0]];
  const environmentId =
    environment === undefined
      ? null
      : Option.getOrNull(decodeEnvironmentId(decoded(environment) || undefined));
  return {
    environmentId,
    page: page !== undefined && PAGE.test(page) ? page : null,
    entry,
  };
}
