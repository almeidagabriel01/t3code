import { assistantSandboxView } from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentId } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { useAssistantSandbox, useAssistantSandboxActions } from "../../state/assistants";

/** The sandbox container assistants may work in: its state and Start / Stop / Remove. */
export function AssistantSandboxSection(props: {
  readonly environmentId: EnvironmentId;
  readonly suffix: string;
}) {
  const status = useAssistantSandbox(props.environmentId);
  const actions = useAssistantSandboxActions(props.environmentId);
  const view = assistantSandboxView(status);
  const disabled = !actions.canAct;

  const run = async (title: string, action: () => Promise<{ ok: boolean; message?: string }>) => {
    const reply = await action();
    if (!reply.ok) Dialog.alert(title, reply.message ?? "Try again.");
  };

  const remove = () =>
    Dialog.confirm({
      title: "Remove the sandbox container?",
      message: "Assistants set to the sandbox cannot run work until you start it again.",
      confirmText: "Remove",
      destructive: true,
      onConfirm: () =>
        Dialog.confirm({
          title: "Also delete its files?",
          message:
            "This erases the provider sign-ins and everything assistants wrote in the sandbox.",
          confirmText: "Delete files",
          cancelText: "Keep files",
          destructive: true,
          onConfirm: () => void run("Could not remove the sandbox", () => actions.remove(true)),
          onCancel: () => void run("Could not remove the sandbox", () => actions.remove(false)),
        }),
    });

  return (
    <ListSection
      title={`Sandbox${props.suffix}`}
      footer={
        "A Linux container (Docker) on the server's machine where assistants set to Sandbox run commands and edit files. To sign in to providers inside it, open T3 Code on that Mac, Settings, Assistants, Sandbox."
      }
    >
      <ListRowLayout
        icon="cube"
        label={`Sandbox container · ${view.label}`}
        {...(view.detail === null ? {} : { description: view.detail })}
      />
      <ListRowLayout
        icon="link"
        label={`Linked environments · ${status === null ? "Checking" : status.linkedEnvironmentsEnabled ? "On" : "Off"}`}
        description="The sandbox link needs it. Starting the sandbox turns it on."
      />
      <ListActionRow
        icon="play"
        label="Start"
        disabled={disabled || !view.canStart}
        onPress={() => void run("Could not start the sandbox", actions.start)}
      />
      <ListActionRow
        icon="stop.fill"
        label="Stop"
        disabled={disabled || !view.canStop}
        onPress={() => void run("Could not stop the sandbox", actions.stop)}
      />
      <ListActionRow
        icon="trash"
        label="Remove"
        tone="danger"
        disabled={disabled || !view.canRemove}
        onPress={remove}
      />
    </ListSection>
  );
}
