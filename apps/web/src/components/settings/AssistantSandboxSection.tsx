import type { EnvironmentId } from "@t3tools/contracts";
import { assistantSandboxView } from "@t3tools/client-runtime/state/assistants";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";
import { BoxIcon, KeyRoundIcon, LinkIcon, PlayIcon, SquareIcon, Trash2Icon } from "lucide-react";

import { requestConfirmDialog } from "../../confirmDialog";
import { connectPairing } from "../../connection/onboarding";
import { useAssistantSandbox, useAssistantSandboxActions } from "../../state/assistants";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function toast(title: string, description: string) {
  toastManager.add({ type: "error", title, description });
}

/** The sandbox container assistants may work in: its state, Start / Stop / Remove, and the provider sign-in. */
export function AssistantSandboxSection(props: {
  readonly environmentId: EnvironmentId;
  readonly suffix: string;
}) {
  const status = useAssistantSandbox(props.environmentId);
  const actions = useAssistantSandboxActions(props.environmentId);
  const view = assistantSandboxView(status);
  const { environments } = useEnvironments();
  const router = useRouter();
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const disabled = !actions.canAct;

  const run = async (title: string, action: () => Promise<{ ok: boolean; message?: string }>) => {
    const reply = await action();
    if (!reply.ok) toast(title, reply.message ?? "Try again.");
  };

  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      "Remove the sandbox container?\nAssistants set to the sandbox cannot run work until you start it again.",
      { variant: "destructive" },
    );
    if (confirmed === false) return;
    const files = await requestConfirmDialog(
      "Also delete its files?\nThis erases the provider sign-ins and everything assistants wrote in the sandbox. Choose Cancel to keep them.",
      { variant: "destructive" },
    );
    await run("Could not remove the sandbox", () => actions.remove(files === true));
  };

  const openProviders = (environmentId: EnvironmentId) =>
    router.navigate({ to: "/settings/providers", search: { machine: environmentId } as never });

  const signIn = async () => {
    if (status?.environmentId == null) return;
    if (environments.some((environment) => environment.environmentId === status.environmentId)) {
      await openProviders(status.environmentId);
      return;
    }
    const pairing = await actions.pairingUrl();
    if (!pairing.ok) return toast("Could not open the sandbox", pairing.message);
    const connected = await connect({ pairingUrl: pairing.value.pairingUrl });
    if (connected._tag !== "Success") {
      if (isAtomCommandInterrupted(connected)) return;
      const cause = squashAtomCommandFailure(connected);
      return toast(
        "Could not reach the sandbox from here",
        `Open T3 Code on the Mac that runs it. ${cause instanceof Error ? cause.message : ""}`.trim(),
      );
    }
    await openProviders(connected.value);
  };

  return (
    <SettingsSection
      title={`Sandbox${props.suffix}`}
      icon={<BoxIcon className="size-4 text-muted-foreground" />}
    >
      <SettingsRow
        title="Sandbox container"
        status={view.label}
        description={
          view.detail ??
          "A Linux container (Docker) where assistants set to Sandbox run commands and edit files."
        }
        control={
          <span className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !view.canStart}
              onClick={() => void run("Could not start the sandbox", actions.start)}
            >
              <PlayIcon />
              Start
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !view.canStop}
              onClick={() => void run("Could not stop the sandbox", actions.stop)}
            >
              <SquareIcon />
              Stop
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !view.canRemove}
              onClick={() => void remove()}
            >
              <Trash2Icon />
              Remove
            </Button>
          </span>
        }
      />
      <SettingsRow
        title={
          <span className="inline-flex items-center gap-2">
            <LinkIcon className="size-4 text-muted-foreground" />
            Linked environments
          </span>
        }
        status={status === null ? undefined : status.linkedEnvironmentsEnabled ? "On" : "Off"}
        description="The sandbox is linked to this machine, which needs Linked environments (Settings → Labs). Starting the sandbox turns it on."
      />
      {view.canSignIn ? (
        <SettingsRow
          title="Sign in to providers in the sandbox"
          description="Providers need their own sign-in inside the sandbox. This opens its Providers settings; it works from the Mac that runs the sandbox."
          control={
            <Button size="sm" variant="outline" onClick={() => void signIn()}>
              <KeyRoundIcon />
              Sign in
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
