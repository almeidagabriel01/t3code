import {
  assistantSandboxGithubView,
  assistantSandboxView,
  SANDBOX_CPU_DESCRIPTION,
  SANDBOX_GITHUB_DESCRIPTION,
  SANDBOX_WHEN_DONE_CHOICES,
  SANDBOX_WHEN_DONE_DESCRIPTION,
  sandboxCpuChoices,
} from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { Linking } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { useAssistantSandbox, useAssistantSandboxActions } from "../../state/assistants";
import { ChoiceRow } from "./AssistantFormFields";

/** The sandbox container assistants may work in: its state and Start / Stop / Remove. */
export function AssistantSandboxSection(props: {
  readonly environmentId: EnvironmentId;
  readonly suffix: string;
}) {
  const status = useAssistantSandbox(props.environmentId);
  const actions = useAssistantSandboxActions(props.environmentId);
  const view = assistantSandboxView(status);
  const github = assistantSandboxGithubView(status);
  const { userCode, verificationUri } = github;
  const disabled = !actions.canAct;
  // An environment that never answers (offline, older server) has no sandbox to show.
  if (status === null) return null;

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

  const openGithub = (userCode: string, verificationUri: string) => {
    void Clipboard.setStringAsync(userCode).catch(() => undefined);
    void Linking.openURL(verificationUri).catch(() => undefined);
  };

  return (
    <>
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
          label={`Linked environments · ${status.linkedEnvironmentsEnabled ? "On" : "Off"}`}
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
      <ListSection title="GitHub in the sandbox" footer={SANDBOX_GITHUB_DESCRIPTION}>
        <ListRowLayout
          icon="person.crop.circle"
          label={`GitHub · ${github.label}`}
          {...(userCode !== null
            ? { description: userCode }
            : github.detail === null
              ? {}
              : { description: github.detail })}
        />
        {github.action === "sign_in" ? (
          <ListActionRow
            icon="key"
            label="Sign in to GitHub"
            disabled={disabled}
            onPress={() => void run("Could not sign in to GitHub", actions.githubSignIn)}
          />
        ) : null}
        {userCode !== null && verificationUri !== null ? (
          <ListActionRow
            icon="arrow.up.right.square"
            label="Copy code & open GitHub"
            onPress={() => openGithub(userCode, verificationUri)}
          />
        ) : null}
        {github.action === "cancel" ? (
          <ListActionRow
            icon="xmark"
            label="Cancel sign-in"
            disabled={disabled}
            onPress={() => void run("Could not cancel the sign-in", actions.githubSignOut)}
          />
        ) : null}
        {github.action === "sign_out" ? (
          <ListActionRow
            icon="rectangle.portrait.and.arrow.right"
            label="Sign out of GitHub"
            tone="danger"
            disabled={disabled}
            onPress={() => void run("Could not sign out of GitHub", actions.githubSignOut)}
          />
        ) : null}
      </ListSection>
      <ListSection title="CPU limit" footer={SANDBOX_CPU_DESCRIPTION}>
        {sandboxCpuChoices(status.cpus).map((choice) => (
          <ChoiceRow
            key={choice.label}
            role="radio"
            icon="timer"
            label={choice.label}
            selected={choice.value === status.cpus}
            onPress={() =>
              disabled || choice.value === status.cpus
                ? undefined
                : void run("Could not change the CPU limit", () =>
                    actions.configure({ cpus: choice.value }),
                  )
            }
          />
        ))}
      </ListSection>
      <ListSection title="When a task is done" footer={SANDBOX_WHEN_DONE_DESCRIPTION}>
        {SANDBOX_WHEN_DONE_CHOICES.map((choice) => (
          <ChoiceRow
            key={choice.value}
            role="radio"
            icon={choice.value === "discard" ? "trash" : "archivebox"}
            label={choice.label}
            selected={choice.value === status.whenDone}
            onPress={() =>
              disabled || choice.value === status.whenDone
                ? undefined
                : void run("Could not change this setting", () =>
                    actions.configure({ whenDone: choice.value }),
                  )
            }
          />
        ))}
      </ListSection>
    </>
  );
}
