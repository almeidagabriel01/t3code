/**
 * What waits on the user, shared by the server's notices and every client's Needs you list so the
 * two never disagree.
 */

/** Kinds T3 answers itself; every other pending request waits on the user. */
export const MACHINE_REQUEST_KINDS = ["dynamic_tool_call", "auth_refresh"] as const;

export const requestWaitsOnUser = (kind: string): boolean =>
  !(MACHINE_REQUEST_KINDS as ReadonlyArray<string>).includes(kind);

/** Notices only inform, and a request's mirror is told about through the request itself. */
export const decisionWaitsOnUser = (decision: {
  readonly notice?: true | undefined;
  readonly approvalRequestId?: string | undefined;
}): boolean => decision.notice !== true && decision.approvalRequestId === undefined;
