import { AssistantError } from "@t3tools/contracts";
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

/**
 * ScheduledTaskService sits below AssistantGroups in the layer graph, so a task bound to a group
 * posts through this late-bound hook that `AssistantGroups.installLayer` fills.
 */
export class AssistantGroupGate extends Context.Service<
  AssistantGroupGate,
  {
    readonly post: Post;
    readonly install: (post: Post) => Effect.Effect<void>;
  }
>()("t3/assistants/AssistantGroupGate") {}

export const gateLayer = Layer.effect(
  AssistantGroupGate,
  Effect.gen(function* () {
    const installed = yield* Ref.make(Option.none<Post>());
    return AssistantGroupGate.of({
      post: Effect.fn("AssistantGroupGate.post")(function* (input) {
        const post = Option.getOrUndefined(yield* Ref.get(installed));
        return post === undefined
          ? yield* new AssistantError({
              reason: "storage",
              message: "Assistant groups are unavailable right now.",
            })
          : yield* post(input);
      }),
      install: Effect.fn("AssistantGroupGate.install")(function* (post) {
        yield* Ref.set(installed, Option.some(post));
      }),
    });
  }),
);
