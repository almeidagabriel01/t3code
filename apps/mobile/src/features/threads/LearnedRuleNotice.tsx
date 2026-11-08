import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  LEARNED_RULE_VISIBLE_MS,
  memoryBrowseInput,
  memoryPreview,
  memoryProjectScope,
  memoryRuleScopeLabel,
  memoryRuleText,
  memoryRulesLearnedIn,
} from "@t3tools/client-runtime/memory-browsing";
import { memoryLocalSpace } from "@t3tools/client-runtime/memory-presentation";
import {
  MEMORY_PAGE_MAX_ITEMS,
  MemoryOperationId,
  supportsMemoryProtocol,
  type MemoryScope,
  type MemorySpaceId,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Crypto from "expo-crypto";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { memoryEnvironment as memory } from "../../state/memory";
import { useProjects } from "../../state/entities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { memoryExpectedHeads } from "../settings/SettingsMemoryRouteScreen.logic";

const NO_ACKNOWLEDGED: readonly string[] = [];
// A space id is stable per environment; one status call per environment is enough.
const spaceByEnvironment = new Map<string, MemorySpaceId>();

/** Resolves the memory space and project scope, then lists rules once both are known. */
export function LearnedRuleNotice(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly projectId: ProjectId | null;
}) {
  const environmentId = props.threadRef?.environmentId ?? null;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const available = config !== null && supportsMemoryProtocol(config.environment.capabilities);
  const canSync = useAtomValue(memory.syncStatus.permissionAtom(environmentId));
  const canBind = useAtomValue(memory.projectBindingGet.permissionAtom(environmentId));
  const getSync = useAtomCommand(memory.syncStatus, { reportFailure: false });
  const getBinding = useAtomCommand(memory.projectBindingGet, { reportFailure: false });
  const project = useProjects().find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === props.projectId,
  );
  const [resolvedSpace, setResolvedSpace] = useState<MemorySpaceId | null>(null);
  const memorySpaceId =
    (environmentId === null ? null : spaceByEnvironment.get(environmentId)) ?? resolvedSpace;
  const [projectScope, setProjectScope] = useState<{
    readonly projectId: ProjectId;
    readonly scope: MemoryScope | null;
  } | null>(null);
  const projectId = props.projectId;
  const repositoryIdentity = project?.repositoryIdentity;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the environment's memory space from the server
  useEffect(() => {
    if (!available || !canSync || environmentId === null || memorySpaceId !== null) return;
    let current = true;
    void getSync({ environmentId, input: {} }).then((result) => {
      if (!current || !AsyncResult.isSuccess(result)) return;
      const space = memoryLocalSpace(result.value);
      if (!space) return;
      spaceByEnvironment.set(environmentId, space);
      setResolvedSpace(space);
    });
    return () => {
      current = false;
    };
  }, [available, canSync, environmentId, getSync, memorySpaceId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the project's shared memory key from the server
  useEffect(() => {
    if (!available || !canBind || environmentId === null || memorySpaceId === null) return;
    if (projectId === null) return;
    let current = true;
    void getBinding({
      environmentId,
      input: { memorySpaceId, project: { environmentId, projectId } },
    }).then((result) => {
      if (!current || !AsyncResult.isSuccess(result)) return;
      setProjectScope({ projectId, scope: memoryProjectScope(result.value, repositoryIdentity) });
    });
    return () => {
      current = false;
    };
  }, [available, canBind, environmentId, getBinding, memorySpaceId, projectId, repositoryIdentity]);

  if (!props.threadRef || memorySpaceId === null || !available) return null;
  const scope = projectScope?.projectId === projectId ? projectScope.scope : null;
  return (
    <LearnedRuleList threadRef={props.threadRef} memorySpaceId={memorySpaceId} scope={scope} />
  );
}

function LearnedRuleList(props: {
  readonly threadRef: ScopedThreadRef;
  readonly memorySpaceId: MemorySpaceId;
  readonly scope: MemoryScope | null;
}) {
  const { environmentId } = props.threadRef;
  const navigation = useNavigation();
  const forget = useAtomCommand(memory.forget);
  const canWrite = useAtomValue(memory.upsert.permissionAtom(environmentId));
  const canForget = useAtomValue(memory.forget.permissionAtom(environmentId));
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const acknowledged = AsyncResult.isSuccess(preferences)
    ? (preferences.value.acknowledgedMemoryRules ?? NO_ACKNOWLEDGED)
    : null;
  // Lists follow memory change signals, so a rule learned after a turn appears without polling.
  const list = (scope: MemoryScope) =>
    memory.list({
      environmentId,
      input: {
        ...memoryBrowseInput({
          memorySpaceId: props.memorySpaceId,
          scope,
          limit: MEMORY_PAGE_MAX_ITEMS,
        }),
        includeQuarantined: false,
      },
    });
  const userAtom = list({ kind: "user" });
  const userPage = useAtomValue(userAtom);
  const projectPage = useAtomValue(props.scope ? list(props.scope) : userAtom);
  const items = (page: typeof userPage) =>
    AsyncResult.isSuccess(page) ? (Option.getOrNull(page.value)?.items ?? []) : [];
  const rule =
    acknowledged === null
      ? undefined
      : memoryRulesLearnedIn(
          [...(props.scope ? items(projectPage) : []), ...items(userPage)],
          props.threadRef,
        ).find((candidate) => !acknowledged.includes(candidate.memoryId));
  const shownId = rule?.memoryId;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer: the notice leaves by itself after a few seconds
  useEffect(() => {
    if (shownId === undefined) return;
    const timer = setTimeout(
      () => updatePreferences({ transform: (current) => withAcknowledged(current, shownId) }),
      LEARNED_RULE_VISIBLE_MS,
    );
    return () => clearTimeout(timer);
  }, [shownId, updatePreferences]);

  if (!rule) return null;
  const acknowledge = () =>
    updatePreferences({ transform: (current) => withAcknowledged(current, rule.memoryId) });
  return (
    <View
      accessibilityRole="alert"
      className="mx-3 mb-2 gap-2 rounded-xl border border-border-subtle bg-screen p-3"
    >
      <View className="gap-0.5">
        <Text className="text-sm font-t3-medium text-foreground">
          Rule saved · {memoryRuleScopeLabel(rule.scope)}
        </Text>
        <Text className="text-sm text-foreground-muted">{memoryPreview(memoryRuleText(rule))}</Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        {canForget ? (
          <Button
            label="Undo"
            size="compact"
            onPress={() => {
              acknowledge();
              void forget({
                environmentId,
                input: {
                  memorySpaceId: props.memorySpaceId,
                  memoryId: rule.memoryId,
                  operationId: MemoryOperationId.make(Crypto.randomUUID()),
                  expectedHeads: memoryExpectedHeads(rule),
                },
              });
            }}
          />
        ) : null}
        {canWrite ? (
          <Button
            label="Edit"
            size="compact"
            onPress={() => {
              acknowledge();
              navigation.navigate("SettingsMemory", {
                environmentId,
                memorySpaceId: props.memorySpaceId,
                memoryId: rule.memoryId,
              });
            }}
          />
        ) : null}
        <Button label="Dismiss" tone="text" size="compact" onPress={acknowledge} />
      </View>
    </View>
  );
}

const withAcknowledged = (
  current: { readonly acknowledgedMemoryRules?: readonly string[] },
  memoryId: string,
) => ({
  acknowledgedMemoryRules: [...(current.acknowledgedMemoryRules ?? []), memoryId].slice(-500),
});
