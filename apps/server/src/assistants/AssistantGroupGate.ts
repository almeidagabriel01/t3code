import { AssistantError, type ChatAttachment } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

export interface GroupSchedulePost {
  readonly teamId: string;
  readonly text: string;
  /** The task's title. */
  readonly label: string;
  /** The fire key, so a replayed fire posts once. */
  readonly clientRequestId: string;
}

type Post = (input: GroupSchedulePost) => Effect.Effect<void, AssistantError>;

export interface GroupRoutineNote {
  readonly teamId: string;
  /** The muted chat line, such as "Paused routine 'Monday'". */
  readonly text: string;
  /** A repeat with the same key adds no second line. */
  readonly clientRequestId: string;
  /** The routine's title. */
  readonly label: string;
}

type Note = (input: GroupRoutineNote) => Effect.Effect<void, AssistantError>;

export interface GroupDecisionOutcome {
  readonly decisionId: string;
  /** The conversation that asked it. */
  readonly threadId: string;
  /** What the agent is told: the answer, a dismissal or the expiry. */
  readonly text: string;
  /** Files the user attached to the answer, already claimed to that conversation. */
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

/** True when a group task takes the outcome over, so nothing is sent to the thread directly. */
type ClaimDecision = (input: GroupDecisionOutcome) => Effect.Effect<boolean>;

interface Hooks {
  readonly post: Post;
  readonly note?: Note;
  readonly claimDecision?: ClaimDecision;
}

/**
 * ScheduledTaskService and DecisionService sit below AssistantGroups in the layer graph, so a task
 * bound to a group posts, and a decision's outcome reaches a group task, through these late-bound
 * hooks that `AssistantGroups.installLayer` fills.
 */
export class AssistantGroupGate extends Context.Service<
  AssistantGroupGate,
  {
    readonly post: Post;
    /** Leaves a muted `change` line about a routine in the group's chat. */
    readonly note: Note;
    /** False until installed: the decision is then delivered to its thread as usual. */
    readonly claimDecision: ClaimDecision;
    readonly install: (hooks: Hooks) => Effect.Effect<void>;
  }
>()("t3/assistants/AssistantGroupGate") {}

export const gateLayer = Layer.effect(
  AssistantGroupGate,
  Effect.gen(function* () {
    const installed = yield* Ref.make(Option.none<Hooks>());
    return AssistantGroupGate.of({
      post: Effect.fn("AssistantGroupGate.post")(function* (input) {
        const post = Option.getOrUndefined(yield* Ref.get(installed))?.post;
        return post === undefined
          ? yield* new AssistantError({
              reason: "storage",
              message: "Assistant groups are unavailable right now.",
            })
          : yield* post(input);
      }),
      note: Effect.fn("AssistantGroupGate.note")(function* (input) {
        const note = Option.getOrUndefined(yield* Ref.get(installed))?.note;
        if (note !== undefined) yield* note(input);
      }),
      claimDecision: Effect.fn("AssistantGroupGate.claimDecision")(function* (input) {
        const claim = Option.getOrUndefined(yield* Ref.get(installed))?.claimDecision;
        return claim === undefined ? false : yield* claim(input);
      }),
      install: Effect.fn("AssistantGroupGate.install")(function* (hooks) {
        yield* Ref.set(installed, Option.some(hooks));
      }),
    });
  }),
);
