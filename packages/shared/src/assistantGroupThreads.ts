import { sha256 } from "@noble/hashes/sha2";
import { ThreadId } from "@t3tools/contracts";
import * as Hex from "effect/encoding/Hex";

const memberThreadId = (assistantId: string, seed: string) =>
  ThreadId.make(
    `assistant:${assistantId}:g-${Hex.encode(sha256(new TextEncoder().encode(seed))).slice(0, 16)}`,
  );

/** The member's hidden thread for a group. Look the group up in the table: team ids may hold ':'. */
export const groupThreadId = (assistantId: string, teamId: string) =>
  memberThreadId(assistantId, teamId);

/** A deleted thread keeps its id reserved, so its replacement derives a new one from it. */
export const nextGroupThreadId = (assistantId: string, teamId: string, dead: string) =>
  memberThreadId(assistantId, `${teamId}\n${dead}`);

/** The member's hidden thread for one request; the same shape, so it reads as a group thread. */
export const requestThreadId = (assistantId: string, teamId: string, requestId: string) =>
  memberThreadId(assistantId, `${teamId}\nrequest:${requestId}`);
