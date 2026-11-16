import {
  AuthPreviewOperateScope,
  type PreviewAnnotationPayload,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { usePreviewAvailable } from "~/browser/previewRuntime";
import { useEnvironmentScopeAccess } from "~/state/session";
import { scopeAccessLocked, scopeAccessMessage } from "@t3tools/client-runtime/state/sessionScope";

import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";
import { PreviewView } from "./PreviewView";

interface Props {
  mode: PreviewPanelMode;
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

const PREVIEW_OPERATE_SCOPES = [AuthPreviewOperateScope];

export function PreviewPanel({
  mode,
  threadRef,
  tabId,
  configuredUrls,
  visible,
  onSendAnnotation,
}: Props) {
  const available = usePreviewAvailable(threadRef.environmentId);
  const previewAccess = useEnvironmentScopeAccess(threadRef.environmentId, PREVIEW_OPERATE_SCOPES);
  const canOperatePreview = !scopeAccessLocked(previewAccess);
  if (!canOperatePreview || !available) {
    return (
      <PreviewPanelShell mode={mode}>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            {canOperatePreview
              ? "Preview is only available in the T3 Code desktop app."
              : previewAccess === "unknown"
                ? null
                : scopeAccessMessage(
                    previewAccess,
                    "Pair this client again with preview access to control browser previews.",
                  )}
          </p>
        </div>
      </PreviewPanelShell>
    );
  }

  return (
    <PreviewPanelShell mode={mode}>
      <PreviewView
        threadRef={threadRef}
        {...(tabId !== undefined ? { tabId } : {})}
        configuredUrls={configuredUrls}
        visible={visible}
        {...(onSendAnnotation ? { onSendAnnotation } : {})}
      />
    </PreviewPanelShell>
  );
}
