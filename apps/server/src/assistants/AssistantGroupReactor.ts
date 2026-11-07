import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { AssistantGroups } from "./AssistantGroups.ts";

/** Moves a group task along when its member's run on the group thread ends. */
export class AssistantGroupReactor extends Context.Service<
  AssistantGroupReactor,
  {
    /** Also starts the group service's watch on team changes. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/assistants/AssistantGroupReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const groups = yield* AssistantGroups;

  const start: AssistantGroupReactor["Service"]["start"] = () =>
    groups.start.pipe(
      Effect.andThen(
        forkParked(
          Stream.runForEach(engine.streamDomainEvents, groups.handleRunEvent).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("assistant group event stream failed", { cause }),
            ),
          ),
        ),
      ),
    );

  return { start, handle: groups.handleRunEvent } satisfies AssistantGroupReactor["Service"];
});

export const layer = Layer.effect(AssistantGroupReactor, make);
