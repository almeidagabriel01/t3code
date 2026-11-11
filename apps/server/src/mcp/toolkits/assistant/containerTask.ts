import * as NodeOS from "node:os";

import { type EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import * as AssistantSandboxControl from "../../../assistants/AssistantSandboxControl.ts";
import * as AssistantService from "../../../assistants/AssistantService.ts";
import * as DecisionService from "../../../decisions/DecisionService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as RemoteDelegation from "../../../peer/RemoteDelegation.ts";
import { type McpThreadInvocationScope, requireThreadScope } from "../../McpInvocationContext.ts";
import { PROVIDER_UNAUTHENTICATED } from "../../OrchestratorMcpService.ts";
import { OrchestratorToolkit } from "../orchestrator/tools.ts";
import { type Caller, unavailable } from "../../threadAccess.ts";
import type { AssistantParameters } from "./tools.ts";

type Out = Record<string, Schema.Json>;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const CPU_CHOICES = [2, 4, 8] as const;

/**
 * The first time work goes to the container the user picks its CPU limit; the choice is stored and
 * editable in Settings. Returns the pending answer while the question is open, null once chosen.
 */
const askCpuLimit = Effect.fn("mcp.assistant.askCpuLimit")(function* (caller: Caller) {
  const control = yield* AssistantSandboxControl.AssistantSandboxControl;
  if ((yield* control.config).chosen) return null;
  if (caller.caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "This client has no conversation to ask the user in. The user sets the container's CPU limit in Settings → Assistants → Sandbox.",
    });
  }
  const decisions = yield* DecisionService.DecisionService;
  const cores = NodeOS.availableParallelism();
  const choices = CPU_CHOICES.filter((count) => count <= cores);
  for (let attempt = 0; ; attempt++) {
    const decision = yield* decisions
      .request({
        fromThreadId: caller.caller.id,
        projectId: caller.caller.projectId,
        threadTitle: caller.caller.title,
        clientRequestId: `sandbox-cpus:${attempt}`,
        title: "How much CPU may the container use?",
        context:
          "A task is about to run in the sandbox container for the first time. You can change this later in Settings → Assistants → Sandbox.",
        options: [
          { id: "none", label: "No limit", consequence: "The container may use every core" },
          ...choices.map((count) => ({
            id: `cpus-${count}`,
            label: `${count} cores`,
            consequence: `The container uses at most ${count} cores`,
          })),
        ],
        recommended: "none",
        expiresInMinutes: 60 * 24,
      })
      .pipe(Effect.mapError(() => unavailable()));
    if (decision.status === "open") {
      return {
        status: "pending_decision",
        decisionId: decision.id,
        message:
          "The user was asked how much CPU the container may use. Tell them it is waiting, then repeat this same call (same clientRequestId) after they answer.",
      } satisfies Out;
    }
    if (decision.status === "expired") continue;
    const answer = decision.status === "answered" ? decision.answer?.optionId : undefined;
    const cpus = answer === "none" ? null : Number(answer?.replace("cpus-", ""));
    if (answer === undefined || (cpus !== null && !Number.isInteger(cpus))) {
      return yield* invalid(
        "The user did not choose a CPU limit. Tell them to set it in Settings → Assistants → Sandbox → CPU limit; do not retry until they have.",
      );
    }
    yield* control.configure({ cpus }).pipe(Effect.mapError(() => unavailable()));
    return null;
  }
});

/**
 * The container has its own provider sign-ins, so a task on a provider that cannot run there would
 * only fail later. A container that cannot say, or does not list the provider, is left to the launch.
 */
const requireProviderThere = Effect.fn("mcp.assistant.requireProviderThere")(function* (
  scope: McpThreadInvocationScope,
  environmentId: EnvironmentId,
  instanceId: string,
) {
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const capabilities = yield* forwarding
    .call(scope, OrchestratorToolkit.tools.orchestrator_capabilities, environmentId, {
      environmentId,
    })
    .pipe(Effect.option);
  const provider = Option.isSome(capabilities)
    ? capabilities.value.providers.find((entry) => entry.providerInstanceId === instanceId)
    : undefined;
  if (provider === undefined || provider.canRunChildTask) return;
  const signIn = provider.constraints.includes(PROVIDER_UNAUTHENTICATED)
    ? " The user signs it in at Settings → Assistants → Sandbox → Sign in, on the Mac that runs the container."
    : "";
  return yield* invalid(
    `${provider.displayName ?? instanceId} cannot run in the container: ${provider.constraints.join(" ")}${signIn} Tell the user; do not retry until they fix it.`,
  );
});

/** A clone that failed before the container signed in to GitHub may be a private repository. */
const withGithubSignIn = Effect.fn("mcp.assistant.withGithubSignIn")(function* (
  error: OrchestratorMcpFailure,
) {
  const control = yield* AssistantSandboxControl.AssistantSandboxControl;
  if (
    !error.message.startsWith(RemoteDelegation.CLONE_FAILED) ||
    (yield* control.status).github.state === "signed_in"
  ) {
    return yield* error;
  }
  return yield* new OrchestratorMcpFailure({
    code: error.code,
    message: `${error.message} If it is a private GitHub repository, the user signs the container in at Settings → Assistants → Sandbox → Sign in to GitHub. Tell them; do not retry until they have.`,
  });
});

/**
 * One task in the sandbox container while the caller stays on this Mac. Every step repeats
 * safely: the question and the start are single, the project is found before it is cloned, and
 * the delegation is keyed by `key`, so a repeat lands on the same task.
 */
export const containerTask = Effect.fn("mcp.assistant.containerTask")(function* (
  caller: Caller,
  input: AssistantParameters,
  key: string,
) {
  const control = yield* AssistantSandboxControl.AssistantSandboxControl;
  const assistants = yield* AssistantService.AssistantService;
  const delegation = yield* RemoteDelegation.RemoteDelegation;
  const task = input.text?.trim();
  if (task === undefined || task === "") {
    return yield* invalid("container_task needs `text`: the complete task.");
  }
  if (caller.caller === undefined) {
    return yield* invalid("container_task needs a conversation to report back to.");
  }
  const own = (yield* assistants.list.pipe(Effect.mapError(() => unavailable()))).find(
    (assistant) => assistant.threadId === caller.caller?.id,
  );
  if (own?.workspace === "sandbox") {
    return yield* invalid(
      "Your workspace is already the container: start work there with t3_thread_launch or delegate_task and your sandbox environmentId.",
    );
  }
  const pending = yield* askCpuLimit(caller);
  if (pending !== null) return pending;
  const instanceId = caller.caller.modelSelection.instanceId;
  // Held from the start to the record, so another task ending meanwhile does not discard it.
  return yield* control.holding(
    Effect.gen(function* () {
      const status = yield* control.startForTask;
      if (status.state !== "running" || status.environmentId === null) {
        if (status.state === "starting") {
          return {
            status: "starting",
            message:
              "The container is starting (the first time builds its image, which takes minutes). Repeat this same call (same clientRequestId) in a while.",
          } satisfies Out;
        }
        return yield* invalid(
          status.error ?? "The sandbox container is not available. Tell the user; do not retry.",
        );
      }
      const scope = yield* requireThreadScope(caller.scope, "container_task");
      yield* requireProviderThere(scope, status.environmentId, instanceId);
      const { taskId } = yield* delegation
        .delegate(
          scope,
          {
            task,
            mode: "async",
            ...(input.name === undefined ? {} : { title: input.name }),
            clientRequestId: key,
            target: { environmentId: status.environmentId },
          },
          { cloneMissingProject: true },
        )
        .pipe(Effect.catch(withGithubSignIn));
      return {
        status: "started",
        taskId,
        environmentId: status.environmentId,
        next: "It runs in the container; its result arrives here as a new message. End your turn. You stay on this Mac.",
      } satisfies Out;
    }),
  );
});

/** Removes the container, keeping its files and sign-ins. The assistant keeps working on this Mac. */
export const containerDiscard = Effect.fn("mcp.assistant.containerDiscard")(function* () {
  const control = yield* AssistantSandboxControl.AssistantSandboxControl;
  const status = yield* control.discard.pipe(Effect.mapError((error) => invalid(error.message)));
  return { status: "discarded", container: status.state } satisfies Out;
});
