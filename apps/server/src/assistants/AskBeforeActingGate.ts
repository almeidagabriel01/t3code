import type { Assistant, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

export interface SendApprovalInput {
  readonly assistant: Assistant;
  readonly senderThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly text: string;
}

export type SendApproval =
  | { readonly allowed: true; readonly release: Effect.Effect<void> }
  | { readonly allowed: false; readonly message: string };

export interface ToolApprovalInput {
  readonly assistant: Assistant;
  readonly threadId: ThreadId;
  /** The T3 MCP server name, e.g. "linear". */
  readonly integration: string;
  /** The service's display name, e.g. "Linear". */
  readonly serviceName: string;
  readonly tool: string;
  /** Hash of the call's arguments; the same call with the same arguments shares one approval. */
  readonly argsHash: string;
  /** The arguments as shown to the user, already clipped. */
  readonly argsPreview: string;
}

export const WAITING_FOR_APPROVAL =
  "Waiting for the user's approval in this conversation. When they approve, send the same message again; if they deny, do not send it.";
export const SEND_DECLINED = "The user declined this send. Do not send it or route around it.";
export const APPROVAL_UNAVAILABLE =
  "This assistant must ask before acting, but asking is unavailable right now. Do not send it.";

export const TOOL_WAITING_FOR_APPROVAL =
  "Waiting for the user's approval in this conversation. When they approve, call the same tool again with the same arguments; if they deny, do not call it.";
export const TOOL_DECLINED =
  "The user declined this action. Do not call it again or route around it.";
export const TOOL_APPROVAL_UNAVAILABLE =
  "This assistant must ask before acting, but asking is unavailable right now. Do not call this tool.";

/**
 * ThreadManagementService cannot depend on DecisionService (decisions deliver through threads),
 * so it reads this late-bound hook, which `installLayer` fills once the decisions exist.
 */
export class AskBeforeActingGate extends Context.Service<
  AskBeforeActingGate,
  {
    readonly check: (input: SendApprovalInput) => Effect.Effect<SendApproval>;
    readonly install: (
      check: (input: SendApprovalInput) => Effect.Effect<SendApproval>,
    ) => Effect.Effect<void>;
    /** A remote write tool call of an integration (the proxy asks; nothing is forwarded meanwhile). */
    readonly requestToolApproval: (input: ToolApprovalInput) => Effect.Effect<SendApproval>;
    readonly installToolApproval: (
      check: (input: ToolApprovalInput) => Effect.Effect<SendApproval>,
    ) => Effect.Effect<void>;
  }
>()("t3/assistants/AskBeforeActingGate") {}

export const gateLayer = Layer.effect(
  AskBeforeActingGate,
  Effect.gen(function* () {
    const installed = yield* Ref.make(
      Option.none<(input: SendApprovalInput) => Effect.Effect<SendApproval>>(),
    );
    const installedTool = yield* Ref.make(
      Option.none<(input: ToolApprovalInput) => Effect.Effect<SendApproval>>(),
    );
    return AskBeforeActingGate.of({
      // Fails closed: a flagged assistant never sends while no approval path exists.
      check: Effect.fn("AskBeforeActingGate.check")(function* (input) {
        const check = Option.getOrUndefined(yield* Ref.get(installed));
        return check === undefined
          ? ({ allowed: false, message: APPROVAL_UNAVAILABLE } satisfies SendApproval)
          : yield* check(input);
      }),
      install: Effect.fn("AskBeforeActingGate.install")(function* (check) {
        yield* Ref.set(installed, Option.some(check));
      }),
      requestToolApproval: Effect.fn("AskBeforeActingGate.requestToolApproval")(function* (input) {
        const check = Option.getOrUndefined(yield* Ref.get(installedTool));
        return check === undefined
          ? ({ allowed: false, message: TOOL_APPROVAL_UNAVAILABLE } satisfies SendApproval)
          : yield* check(input);
      }),
      installToolApproval: Effect.fn("AskBeforeActingGate.installToolApproval")(function* (check) {
        yield* Ref.set(installedTool, Option.some(check));
      }),
    });
  }),
);
