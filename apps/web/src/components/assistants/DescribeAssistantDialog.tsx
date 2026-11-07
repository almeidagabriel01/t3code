import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

export function describeAssistantPrompt(description: string): string {
  return `Create this with the t3_assistant tool. If I did not say the access level, ask me whether I want the default (up to your level) or a custom setup before creating it.\n\n${description.trim()}`;
}

/** The user describes an assistant or group; a Scratch thread opens with that request ready to send. */
export function DescribeAssistantDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const newThread = useNewThreadHandler();
  const canSubmit = description.trim() !== "" && !busy;

  // No try/finally: the React Compiler skips components that use one.
  const openThread = async (): Promise<string | null> => {
    const environmentId = scratchEnvironmentId(null);
    const project = environmentId === null ? null : await openScratchProject(environmentId);
    if (project === null) return "No Scratch project is available here.";
    const opened = await newThread(scopeProjectRef(project.environmentId, project.id), {
      prompt: describeAssistantPrompt(description),
    });
    return opened === null ? "Could not open a thread" : null;
  };

  const submit = async () => {
    setBusy(true);
    const problem = await openThread().catch(() => "Could not open a thread");
    setBusy(false);
    if (problem !== null) {
      toastManager.add({ type: "error", title: problem });
      return;
    }
    setDescription("");
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Describe an assistant</DialogTitle>
          <DialogDescription>
            Say what you want in your own words. T3 opens a thread that builds it with you.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="flex flex-col gap-1.5"
            id="describe-assistant-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) void submit();
            }}
          >
            <Label htmlFor="describe-assistant">What should it do?</Label>
            <Textarea
              id="describe-assistant"
              autoFocus
              placeholder="A reviewer for my web project that checks every pull request, or a Finance group with a CFO and an analyst"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="describe-assistant-form" disabled={!canSubmit}>
            Start
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
