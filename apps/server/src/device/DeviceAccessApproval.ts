import { DeviceOperationError, type Decision, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as DecisionService from "../decisions/DecisionService.ts";
import type { DeviceAgentCaller } from "./DeviceService.ts";

/** A tool call waits this long for the answer, then reports it as pending. */
const ANSWER_WAIT = "2 minutes";
/** How many withdrawn or expired questions one thread may leave behind for a device. */
const MAX_QUESTIONS = 8;

const failed = (cause: unknown) =>
  new DeviceOperationError({ operation: "ask device access", reason: "request_failed", cause });

/**
 * Asks the user, as a decision, whether a thread may use a device. The request id comes from the
 * device, so a repeat lands on the same decision, and an answer stays with the thread's lineage.
 */
export const askDeviceAccess =
  (
    decisions: Pick<DecisionService.DecisionService["Service"], "request" | "subscribe">,
    thread: { readonly projectId: ProjectId; readonly threadTitle: string },
  ): NonNullable<DeviceAgentCaller["ask"]> =>
  (question) =>
    Effect.gen(function* () {
      let decision: Decision | undefined;
      // A withdrawn or expired question is not an answer, so it asks again under the next id.
      for (let attempt = 0; attempt < MAX_QUESTIONS; attempt++) {
        decision = yield* decisions.request({
          fromThreadId: question.threadId,
          projectId: thread.projectId,
          threadTitle: thread.threadTitle,
          clientRequestId: `device-access:${question.hostId}:${question.deviceId}${attempt === 0 ? "" : `:${attempt}`}`,
          title: `Let the agent use ${question.deviceName}?`.slice(0, 120),
          context: `The agent in this thread wants to open and drive ${question.deviceName} on ${question.hostLabel}. Your answer applies to this thread and the tasks it delegates. Change the default in Settings > Integrations > Devices > Device access.`,
          options: [
            {
              id: "allow",
              label: "Allow",
              consequence: "This thread and its delegated tasks can drive the device",
            },
            { id: "deny", label: "Don't allow", consequence: "This thread cannot use the device" },
          ],
          recommended: "deny",
        });
        if (decision.status === "open" || decision.status === "answered") break;
      }
      if (decision?.status === "open") {
        const decisionId = decision.id;
        decision = yield* decisions.subscribe.pipe(
          Stream.map((event) =>
            event.type === "snapshot"
              ? event.decisions.find((candidate) => candidate.id === decisionId)
              : event.decision.id === decisionId
                ? event.decision
                : undefined,
          ),
          Stream.filter((found) => found !== undefined && found.status !== "open"),
          Stream.runHead,
          Effect.timeoutOption(ANSWER_WAIT),
          Effect.map((settled) => Option.getOrUndefined(Option.flatten(settled))),
        );
      }
      if (decision?.status !== "answered") return "pending" as const;
      return decision.answer?.optionId === "allow" ? ("allowed" as const) : ("declined" as const);
    }).pipe(Effect.mapError(failed));
