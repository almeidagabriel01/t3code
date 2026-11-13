import type { AssistantId, AssistantTeamId, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export type AssistantInfoTarget =
  | {
      readonly kind: "assistant";
      readonly environmentId: EnvironmentId;
      readonly assistantId: AssistantId;
    }
  | {
      readonly kind: "group";
      readonly environmentId: EnvironmentId;
      readonly teamId: AssistantTeamId;
    };

/**
 * Whose info the side panel shows. The chat headers, the sidebar, the bubble and the palette all
 * open it, in an assistant chat and in a group chat, so the root renders it once.
 */
export const assistantInfoAtom = Atom.make<AssistantInfoTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("assistants:info"),
);

const sameTarget = (a: AssistantInfoTarget | null, b: AssistantInfoTarget) =>
  a !== null &&
  a.kind === b.kind &&
  a.environmentId === b.environmentId &&
  (a.kind === "assistant"
    ? b.kind === "assistant" && a.assistantId === b.assistantId
    : b.kind === "group" && a.teamId === b.teamId);

export function openAssistantInfo(target: AssistantInfoTarget): void {
  appAtomRegistry.set(assistantInfoAtom, target);
}

/** The header trigger: a second click on the same name closes the panel. */
export function toggleAssistantInfo(target: AssistantInfoTarget): void {
  const current = appAtomRegistry.get(assistantInfoAtom);
  appAtomRegistry.set(assistantInfoAtom, sameTarget(current, target) ? null : target);
}

export function closeAssistantInfo(): void {
  appAtomRegistry.set(assistantInfoAtom, null);
}
