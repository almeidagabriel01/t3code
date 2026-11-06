import { useAtomValue } from "@effect/atom-react";
import {
  memoryBrowseInput,
  memoryPreview,
  memoryProjectScope,
  memoryRuleText,
  memoryRulesLearnedIn,
  type MemoryRuleItem,
} from "@t3tools/client-runtime/memory-browsing";
import { memoryLocalSpace } from "@t3tools/client-runtime/memory-presentation";
import {
  MEMORY_PAGE_MAX_ITEMS,
  type EnvironmentId,
  type MemoryScope,
  type MemorySpaceId,
  type ProjectId,
  type RepositoryIdentity,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { BookmarkCheckIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
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
// A space id is stable per environment; one status call per environment is enough.
const spaceByEnvironment = new Map<EnvironmentId, MemorySpaceId>();

/** Rules the agent learned from this thread's messages, until the user has seen them. */
export function useLearnedRuleBanner(input: {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId;
  readonly project: {
    readonly id: ProjectId;
    readonly repositoryIdentity: RepositoryIdentity | null | undefined;
  } | null;
  readonly memoryAvailable: boolean;
}): ComposerBannerStackItem | null {
  const { environmentId, threadId, project, memoryAvailable } = input;
  const active = memoryAvailable && environmentId !== undefined;
  const canSync = useAtomValue(memoryEnvironment.syncStatus.permissionAtom(environmentId ?? null));
  const canBind = useAtomValue(
    memoryEnvironment.projectBindingGet.permissionAtom(environmentId ?? null),
  );
  const canWrite = useAtomValue(memoryEnvironment.upsert.permissionAtom(environmentId ?? null));
  const canForget = useAtomValue(memoryEnvironment.forget.permissionAtom(environmentId ?? null));
  const getSync = useAtomCommand(memoryEnvironment.syncStatus, { reportFailure: false });
  const getBinding = useAtomCommand(memoryEnvironment.projectBindingGet, { reportFailure: false });
  const forget = useAtomCommand(memoryEnvironment.forget, { reportFailure: false });
  const [acknowledged, setAcknowledged] = useLocalStorage(
    ACKNOWLEDGED_STORAGE_KEY,
    NO_ACKNOWLEDGED,
    AcknowledgedSchema,
  );
  const [resolvedSpace, setResolvedSpace] = useState<MemorySpaceId | null>(null);
  const memorySpaceId =
    (environmentId === undefined ? null : spaceByEnvironment.get(environmentId)) ?? resolvedSpace;
  const [projectScope, setProjectScope] = useState<{
    readonly projectId: ProjectId;
    readonly scope: MemoryScope | null;
  } | null>(null);
  const [editing, setEditing] = useState<MemoryRuleItem | null>(null);
  const projectId = project?.id ?? null;
  const repositoryIdentity = project?.repositoryIdentity;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the environment's memory space from the server
  useEffect(() => {
    if (!active || !canSync || memorySpaceId !== null) return;
    let current = true;
    void getSync({ environmentId, input: {} }).then((result) => {
      if (!current || result._tag !== "Success") return;
      const space = memoryLocalSpace(result.value);
      if (!space) return;
      spaceByEnvironment.set(environmentId, space);
      setResolvedSpace(space);
    });
    return () => {
      current = false;
    };
  }, [active, canSync, environmentId, getSync, memorySpaceId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the project's shared memory key from the server
  useEffect(() => {
    if (!active || !canBind || memorySpaceId === null || projectId === null) return;
    let current = true;
    void getBinding({
      environmentId,
      input: { memorySpaceId, project: { environmentId, projectId } },
    }).then((result) => {
      if (!current || result._tag !== "Success") return;
      setProjectScope({
        projectId,
        scope: memoryProjectScope(result.value, repositoryIdentity),
      });
    });
    return () => {
      current = false;
    };
  }, [active, canBind, environmentId, getBinding, memorySpaceId, projectId, repositoryIdentity]);

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
  const scope = projectScope?.projectId === projectId ? projectScope?.scope : null;
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
  if (!active || memorySpaceId === null || rule === undefined) return null;

  const acknowledge = () =>
    setAcknowledged((previous) => ({ ids: [...previous.ids, rule.memoryId].slice(-500) }));
  const intent = memoryForgetIntent(rule);
  return {
    id: `learned-rule:${rule.memoryId}`,
    variant: "info",
    icon: <BookmarkCheckIcon />,
    title: "Learned a rule",
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
