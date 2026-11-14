import type { AssistantGroupTabKey } from "@t3tools/client-runtime/assistantGroupChat";
import type { AssistantTeamId, EnvironmentId } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

export interface OpenGroupTab {
  readonly environmentId: EnvironmentId;
  readonly teamId: AssistantTeamId;
  /** null while the chat has no tab row or is still choosing one. */
  readonly tab: AssistantGroupTabKey | null;
}

/**
 * The group chat tabs on screen, one per mounted chat, so a notice skips the work the user
 * already sees. Keyed by mount: one chat unmounting never clears another's.
 */
export const openGroupTabsAtom = Atom.make<ReadonlyMap<string, OpenGroupTab>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-open-group-tabs"),
);

/** Lists `shown` under `mount` until the returned function removes that one entry. */
export function showGroupTab(
  registry: Pick<AtomRegistry.AtomRegistry, "get" | "set">,
  mount: string,
  shown: OpenGroupTab,
): () => void {
  registry.set(openGroupTabsAtom, new Map(registry.get(openGroupTabsAtom)).set(mount, shown));
  return () => {
    const next = new Map(registry.get(openGroupTabsAtom));
    next.delete(mount);
    registry.set(openGroupTabsAtom, next);
  };
}
