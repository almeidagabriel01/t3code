import type { EnvironmentId } from "@t3tools/contracts";
import {
  assistantSandboxGithubView,
  assistantSandboxView,
  SANDBOX_CPU_DESCRIPTION,
  SANDBOX_GITHUB_DESCRIPTION,
  SANDBOX_WHEN_DONE_CHOICES,
  SANDBOX_WHEN_DONE_DESCRIPTION,
  sandboxCpuChoices,
  sandboxCpuLabel,
} from "@t3tools/client-runtime/state/assistants";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";
import {
  BoxIcon,
  CheckIcon,
  CopyIcon,
  CpuIcon,
  ExternalLinkIcon,
  GithubIcon,
  KeyRoundIcon,
  LinkIcon,
  LogOutIcon,
  PlayIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import { requestConfirmDialog } from "../../confirmDialog";
import { connectPairing } from "../../connection/onboarding";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useAssistantSandbox, useAssistantSandboxActions } from "../../state/assistants";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { DeviceCode } from "./SourceControlAppSignInSettings";

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
  const github = assistantSandboxGithubView(status);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: "sign-in code",
  });

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
      {status === null ? null : (
        <>
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                <CpuIcon className="size-4 text-muted-foreground" />
                CPU limit
              </span>
            }
            description={SANDBOX_CPU_DESCRIPTION}
            control={
              <Select
                value={status.cpus === null ? "none" : String(status.cpus)}
                disabled={disabled}
                onValueChange={(value) =>
                  void run("Could not change the CPU limit", () =>
                    actions.configure({ cpus: value === "none" ? null : Number(value) }),
                  )
                }
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="CPU limit">
                  <SelectValue>{sandboxCpuLabel(status.cpus)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {sandboxCpuChoices(status.cpus).map((choice) => (
                    <SelectItem
                      hideIndicator
                      key={choice.label}
                      value={choice.value === null ? "none" : String(choice.value)}
                    >
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title="When a task is done"
            description={SANDBOX_WHEN_DONE_DESCRIPTION}
            control={
              <Select
                value={status.whenDone}
                disabled={disabled}
                onValueChange={(value) => {
                  const choice = SANDBOX_WHEN_DONE_CHOICES.find((item) => item.value === value);
                  if (choice !== undefined) {
                    void run("Could not change this setting", () =>
                      actions.configure({ whenDone: choice.value }),
                    );
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-56"
                  aria-label="When a task is done"
                >
                  <SelectValue>
                    {
                      SANDBOX_WHEN_DONE_CHOICES.find((item) => item.value === status.whenDone)
                        ?.label
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {SANDBOX_WHEN_DONE_CHOICES.map((item) => (
                    <SelectItem hideIndicator key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </>
      )}
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
      <SettingsRow
        title={
          <span className="inline-flex items-center gap-2">
            <GithubIcon className="size-4 text-muted-foreground" />
            GitHub in the sandbox
          </span>
        }
        status={github.label}
        description={github.detail ?? SANDBOX_GITHUB_DESCRIPTION}
        control={
          github.action === "sign_in" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void run("Could not sign in to GitHub", actions.githubSignIn)}
            >
              <KeyRoundIcon />
              Sign in to GitHub
            </Button>
          ) : github.action === "cancel" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void run("Could not cancel the sign-in", actions.githubSignOut)}
            >
              <XIcon />
              Cancel
            </Button>
          ) : github.action === "sign_out" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void run("Could not sign out of GitHub", actions.githubSignOut)}
            >
              <LogOutIcon />
              Sign out
            </Button>
          ) : null
        }
      >
        {github.userCode === null || github.verificationUri === null ? null : (
          <div className="flex flex-wrap items-center gap-3 pb-3">
            <DeviceCode code={github.userCode} />
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Copy code"
              onClick={() => copyToClipboard(github.userCode ?? "", undefined)}
            >
              {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            </Button>
            <Button
              size="sm"
              render={<a href={github.verificationUri} target="_blank" rel="noreferrer noopener" />}
              onClick={() => copyToClipboard(github.userCode ?? "", undefined)}
            >
              Copy code & open GitHub
              <ExternalLinkIcon aria-hidden className="size-3.5" />
            </Button>
          </div>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
