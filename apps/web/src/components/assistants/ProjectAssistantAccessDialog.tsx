import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { readAssistantEntries } from "../../state/assistants";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { ProjectAssistantAccess } from "./ProjectAssistantAccess";

type Target = { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };

const projectAssistantAccessAtom = Atom.make<Target | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("assistants:project-access"),
);

export function ProjectAssistantAccessHost() {
  const target = useAtomValue(projectAssistantAccessAtom);
  if (target === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && appAtomRegistry.set(projectAssistantAccessAtom, null)}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assistants with access</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <ProjectAssistantAccess
            environmentId={target.environmentId}
            projectId={target.projectId}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** After a project is added: tells the user, and offers access only where assistants could use it. */
export function offerProjectAssistantAccess(environmentId: EnvironmentId, projectId: ProjectId) {
  const { activeTeams, active } = readAssistantEntries();
  const relevant =
    activeTeams.some((entry) => entry.environmentId === environmentId) ||
    active.some(
      (entry) => entry.environmentId === environmentId && entry.assistant.scope === "project",
    );
  if (!relevant) return;
  toastManager.add({
    type: "success",
    title: "Project added",
    actionProps: {
      children: "Give assistants access",
      onClick: () => appAtomRegistry.set(projectAssistantAccessAtom, { environmentId, projectId }),
    },
  });
}
