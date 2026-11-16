import {
  scopeAccessMessage,
  type SessionScopeAccess,
} from "@t3tools/client-runtime/state/sessionScope";

/** What a row without a local model offers, never "download" before settings access is known. */
export const noModelHint = (access: SessionScopeAccess, label: string) =>
  scopeAccessMessage(access, `Add one using T3 Code on ${label}`) ?? "Choose one to download";
