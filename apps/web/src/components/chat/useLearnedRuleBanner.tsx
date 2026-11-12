import { useAtomValue } from "@effect/atom-react";
import {
  LEARNED_RULE_VISIBLE_MS,
  memoryBrowseInput,
  memoryPreview,
  memoryRuleScopeLabel,
  memoryRuleText,
  memoryRulesLearnedIn,
  type MemoryRuleItem,
} from "@t3tools/client-runtime/memory-browsing";
import {
  MEMORY_PAGE_MAX_ITEMS,
  type EnvironmentId,
  type MemoryScope,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { BookmarkCheckIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import { useMemorySpace, useProjectMemoryScope } from "../memory/useProjectMemoryScope";

import { useLocalStorage, writeLocalStorageValue } from "../../hooks/useLocalStorage";
import { useEnvironmentQuery } from "../../state/query";
import { memoryEnvironment } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { memoryForgetIntent } from "../settings/MemorySettings.logic";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const LearnedRuleEditDialog = lazy(() => import("./LearnedRuleEditDialog"));

const ACKNOWLEDGED_STORAGE_KEY = "t3code:memory-rule-acknowledged:v1";
const AcknowledgedSchema = Schema.Struct({ ids: Schema.Array(Schema.String) });
const NO_ACKNOWLEDGED = { ids: [] as readonly string[] };
const NO_ITEMS: readonly never[] = [];

/** Rules the agent learned from this thread's messages, until the user has seen them. */
export function useLearnedRuleBanner(input: {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly memoryAvailable: boolean;
}): ComposerBannerStackItem | null {
  const { environmentId, threadId, projectId, memoryAvailable } = input;
  const active = memoryAvailable && environmentId !== undefined;
  const canWrite = useAtomValue(memoryEnvironment.upsert.permissionAtom(environmentId ?? null));
  const canForget = useAtomValue(memoryEnvironment.forget.permissionAtom(environmentId ?? null));
  const forget = useAtomCommand(memoryEnvironment.forget, { reportFailure: false });
  const [acknowledged, setAcknowledged] = useLocalStorage(
    ACKNOWLEDGED_STORAGE_KEY,
    NO_ACKNOWLEDGED,
    AcknowledgedSchema,
  );
  const memorySpaceId = useMemorySpace(environmentId, active);
  const projectScope = useProjectMemoryScope(environmentId, projectId, memorySpaceId);
  const [editing, setEditing] = useState<MemoryRuleItem | null>(null);

  // Lists follow memory change signals, so a rule learned after a turn appears without polling.
  const list = (scope: MemoryScope) =>
    environmentId === undefined || memorySpaceId === null
      ? null
      : memoryEnvironment.list({
          environmentId,
          input: {
            ...memoryBrowseInput({ memorySpaceId, scope, limit: MEMORY_PAGE_MAX_ITEMS }),
            includeQuarantined: false,
          },
        });
  const scope = projectScope?.status === "ready" ? projectScope.scope : null;
  const userPage = useEnvironmentQuery(active ? list({ kind: "user" }) : null);
  const projectPage = useEnvironmentQuery(active && scope ? list(scope) : null);
  const userItems = (userPage.data ? Option.getOrNull(userPage.data)?.items : null) ?? NO_ITEMS;
  const projectItems =
    (projectPage.data ? Option.getOrNull(projectPage.data)?.items : null) ?? NO_ITEMS;
  const rule =
    environmentId === undefined
      ? undefined
      : memoryRulesLearnedIn([...projectItems, ...userItems], { environmentId, threadId }).find(
          (candidate) => !acknowledged.ids.includes(candidate.memoryId),
        );
  const shownId = active && memorySpaceId !== null ? rule?.memoryId : undefined;
  const editingOpen = editing !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer: the notice leaves by itself unless its edit dialog is open
  useEffect(() => {
    if (shownId === undefined || editingOpen) return;
    const timer = window.setTimeout(
      () =>
        writeLocalStorageValue(
          ACKNOWLEDGED_STORAGE_KEY,
          (previous) => ({ ids: [...previous.ids, shownId].slice(-500) }),
          NO_ACKNOWLEDGED,
          AcknowledgedSchema,
        ),
      LEARNED_RULE_VISIBLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [shownId, editingOpen]);

  if (!active || memorySpaceId === null || rule === undefined) return null;

  const acknowledge = () =>
    setAcknowledged((previous) => ({ ids: [...previous.ids, rule.memoryId].slice(-500) }));
  const intent = memoryForgetIntent(rule);
  return {
    id: `learned-rule:${rule.memoryId}`,
    variant: "info",
    icon: <BookmarkCheckIcon />,
    title: `Rule saved · ${memoryRuleScopeLabel(rule.scope)}`,
    description: memoryPreview(memoryRuleText(rule)),
    dismissLabel: "Dismiss",
    onDismiss: acknowledge,
    actions: (
      <>
        {canForget && intent ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              acknowledge();
              void forget({ environmentId, input: intent });
            }}
          >
            Undo
          </Button>
        ) : null}
        {canWrite ? (
          <Button size="xs" variant="ghost" onClick={() => setEditing(rule)}>
            Edit
          </Button>
        ) : null}
        {editing ? (
          <Suspense fallback={null}>
            <LearnedRuleEditDialog
              environmentId={environmentId}
              memorySpaceId={memorySpaceId}
              rule={editing}
              onClose={() => {
                setEditing(null);
                acknowledge();
              }}
            />
          </Suspense>
        ) : null}
      </>
    ),
  };
}
