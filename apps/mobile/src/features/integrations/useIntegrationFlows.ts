import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  integrationAssistantsUsing,
  integrationErrorMessage,
  type IntegrationMenuAction,
  type IntegrationPrimaryAction,
} from "@t3tools/client-runtime/integrations";
import type { EnvironmentId, IntegrationsState } from "@t3tools/contracts";
import * as WebBrowser from "expo-web-browser";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";
import { Keyboard } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { waitForEnvironmentConnection } from "../../lib/attachmentUpload";
import { useAssistantEntries } from "../../state/assistants";
import { appAtomRegistry } from "../../state/atom-registry";
import { useIntegrationActions } from "../../state/integrations";
import {
  appReturnScheme,
  cancelConnect,
  endPushedFlows,
  pendingFlowFor,
  pendingFlowsAtom,
  startConnect,
  type ConnectDeps,
  type ConnectOutcome,
} from "./connectFlow";

export type IntegrationForm = "detail" | "own-app" | "token" | "paste";

export type IntegrationRouteParams = {
  readonly environmentId: string;
  readonly form: IntegrationForm;
  /** The catalog entry: own-app, token and paste forms. */
  readonly catalogId?: string;
  /** The T3 integration: detail and paste forms. */
  readonly name?: string;
};

/** The last sign-in that finished here; the directory offers to choose its assistants. */
export const connectedNoticeAtom = Atom.make<{
  readonly environmentId: EnvironmentId;
  readonly name: string;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("mobile-integration-connected-notice"));

const showError = (reason: string, name: string) =>
  Dialog.alert(integrationErrorMessage(reason, name));

/** Every action an integration row, menu or form starts; prompts close the keyboard first. */
export function useIntegrationFlows(environmentId: EnvironmentId, state: IntegrationsState | null) {
  const actions = useIntegrationActions(environmentId);
  const navigation = useNavigation();
  const flows = useAtomValue(pendingFlowsAtom);
  const assistants = useAssistantEntries()
    .active.filter((entry) => entry.environmentId === environmentId)
    .map((entry) => entry.assistant);
  const deps: ConnectDeps = {
    environmentId,
    scheme: appReturnScheme(),
    begin: actions.beginConnect,
    complete: actions.completeConnect,
    cancel: actions.cancelConnect,
    openAuthSession: (url, returnUrl) => WebBrowser.openAuthSessionAsync(url, returnUrl),
    openBrowser: (url) => WebBrowser.openBrowserAsync(url),
    waitForConnection: () => waitForEnvironmentConnection(environmentId),
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a sign-in ends on the server; its pushed status must close the native auth sheet this device still shows
  useEffect(() => {
    if (state === null) return;
    const statusOf = (name: string) =>
      state.integrations.find((item) => item.name === name)?.status;
    for (const flow of endPushedFlows(environmentId, statusOf)) {
      if (flow.mode === "server") WebBrowser.dismissAuthSession();
      if (statusOf(flow.name) === "connected") {
        appAtomRegistry.set(connectedNoticeAtom, { environmentId, name: flow.name });
      }
    }
  }, [environmentId, state]);
  const entryOf = (catalogId: string) =>
    state?.catalog.find((entry) => entry.id === catalogId) ?? null;
  const titleOf = (catalogId: string) => entryOf(catalogId)?.name ?? catalogId;
  const open = (params: Omit<IntegrationRouteParams, "environmentId">) =>
    navigation.navigate("SettingsIntegration", { environmentId, ...params });

  const settle = (catalogId: string, outcome: ConnectOutcome) => {
    if (outcome.kind === "connected") {
      appAtomRegistry.set(connectedNoticeAtom, { environmentId, name: outcome.name });
    } else if (outcome.kind === "paste") {
      open({ form: "paste", catalogId, name: outcome.flow.name });
    } else if (outcome.kind === "failed" && outcome.reason === "own-app-required") {
      open({ form: "own-app", catalogId });
    } else if (outcome.kind === "failed" && outcome.reason !== null) {
      showError(outcome.reason, titleOf(catalogId));
    }
  };

  /** Skips the own-app check, for the form that just saved the app. */
  const signIn = async (catalogId: string) =>
    settle(catalogId, await startConnect(catalogId, deps));

  const connect = async (catalogId: string) => {
    const entry = entryOf(catalogId);
    const auth = entry?.auth;
    if (auth?.kind === "token") return open({ form: "token", catalogId });
    if (
      auth?.kind === "oauth" &&
      auth.registration === "own-app" &&
      !state?.ownApps.some((app) => app.clientGroup === auth.clientGroup)
    ) {
      return open({ form: "own-app", catalogId });
    }
    await signIn(catalogId);
  };

  const cancel = async (name: string) => {
    await cancelConnect(environmentId, name, deps);
  };

  const disconnect = (name: string, title: string, onDone?: () => void) => {
    Keyboard.dismiss();
    Dialog.alert(
      `Disconnect ${title}?`,
      `Assistants using it: ${integrationAssistantsUsing(name, assistants).length}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () =>
            void actions.disconnect(name).then((reply) => {
              if (!reply.ok) showError(reply.reason, title);
              else onDone?.();
            }),
        },
      ],
    );
  };

  const makeAvailable = (detectedId: string) => {
    const server = state?.detected.find((item) => item.id === detectedId);
    if (!server) return;
    Keyboard.dismiss();
    const lines = [
      `Copies: ${server.url ?? server.command ?? server.name}`,
      ...(server.secretKeys.length === 0
        ? []
        : [`Values saved as T3 secrets: ${server.secretKeys.join(", ")}`]),
      ...(server.needsValue.length === 0
        ? []
        : [`Left out (with \${...}): ${server.needsValue.join(", ")}`]),
    ];
    Dialog.alert("Make available to all providers", lines.join("\n"), [
      { text: "Cancel", style: "cancel" },
      {
        text: "Make available to all providers",
        onPress: () =>
          void actions.makeAvailable(detectedId).then((reply) => {
            if (!reply.ok) return showError(reply.reason, server.name);
            if (reply.value.outcome === "connect") return void connect(reply.value.catalogId);
            if (reply.value.leftOut.length > 0) {
              Dialog.alert("Needs a value", reply.value.leftOut.join(", "));
            }
          }),
      },
    ]);
  };

  const runPrimary = (action: IntegrationPrimaryAction) => {
    if (action.kind === "connect" || action.kind === "reconnect") void connect(action.catalogId);
    else if (action.kind === "cancel") void cancel(action.name);
    else open({ form: "detail", name: action.name });
  };

  const runMenu = (action: IntegrationMenuAction, title: string) => {
    if (action.kind === "make-available") makeAvailable(action.detectedId);
    else if (action.kind === "disconnect") disconnect(action.name, title);
    else open({ form: "token", catalogId: action.catalogId });
  };

  return {
    canAct: actions.canAct,
    actions,
    deps,
    pendingFlow: (name: string) => pendingFlowFor(flows, environmentId, name),
    open,
    connect,
    signIn,
    cancel,
    disconnect,
    runPrimary,
    runMenu,
    showError,
  };
}
