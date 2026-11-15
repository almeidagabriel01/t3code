import { describe, expect, it } from "@effect/vitest";
import { AuthSettingsWriteScope, type AuthSessionState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { scopeAccessLocked, scopeAccessShowsBanner, sessionScopeAccess } from "./sessionScope.ts";

describe("sessionScopeAccess", () => {
  const session = (permissions: AuthSessionState["permissions"]) =>
    ({ authenticated: true, permissions }) as AuthSessionState;
  const withScope = AsyncResult.success(session([AuthSettingsWriteScope]));
  const failed = new Error("session check failed");
  it.each([
    ["Initial", AsyncResult.initial<AuthSessionState>(), "unknown", true, false],
    [
      "waiting without a value",
      AsyncResult.initial<AuthSessionState>(true),
      "unknown",
      true,
      false,
    ],
    ["resolved without the scope", AsyncResult.success(session([])), "missing", true, true],
    ["resolved with the scope", withScope, "granted", false, false],
    ["Failure without a previous session", AsyncResult.fail(failed), "unknown", true, false],
    [
      "Failure with a previous session",
      AsyncResult.failureWithPrevious(Cause.fail(failed), { previous: Option.some(withScope) }),
      "granted",
      false,
      false,
    ],
  ] as const)("%s", (_name, result, access, locked, showBanner) => {
    const actual = sessionScopeAccess(result, [AuthSettingsWriteScope]);
    expect(actual).toBe(access);
    expect(scopeAccessLocked(actual)).toBe(locked);
    expect(scopeAccessShowsBanner(actual)).toBe(showBanner);
  });
});
