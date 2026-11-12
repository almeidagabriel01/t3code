import {
  memoryBrowseInput,
  memoryPreview,
  memoryRuleText,
  memorySearchInput,
} from "@t3tools/client-runtime/memory-browsing";
import {
  AuthMemoryReadScope,
  isMemoryRule,
  MEMORY_PAGE_MAX_ITEMS,
  ProjectId,
  type EnvironmentId,
  type MemoryItem,
  type MemoryScope,
  type MemorySpaceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useRef, useState } from "react";
import { View, type TextInputInstance } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { SearchField } from "../../components/ui/SearchField";
import { memoryEnvironment as memory } from "../../state/memory";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import {
  useForgetMemory,
  useMemorySpace,
  useProjectMemoryScope,
  type ProjectMemoryScope,
} from "../memory/useProjectMemory";
import { ProjectViewMessage } from "./ProjectViewMessage";
import { useLeaveSheet } from "./useLeaveSheet";

type ActiveMemory = Extract<MemoryItem, { status: "active" }>;

const SCOPE_MESSAGE: Record<
  Exclude<ProjectMemoryScope["status"], "ready" | "loading">,
  { readonly title: string; readonly detail: string }
> = {
  "no-permission": {
    title: "Memory write access needed",
    detail: "Finding this project's memories needs memory write permission on this server.",
  },
  "no-key": {
    title: "This project has no shared memory",
    detail: "Give it a repository or a shared memory key in Settings, Memory.",
  },
  failed: {
    title: "Could not load this project's memory",
    detail: "Close and reopen this sheet to try again.",
  },
};

/** The project's memories: search them, open one in Memory to edit, or forget it. */
export function ProjectMemoryView(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
}) {
  const { environmentId } = props;
  const canRead = useEnvironmentScope(environmentId, AuthMemoryReadScope);
  const space = useMemorySpace(environmentId, canRead);
  const scope = useProjectMemoryScope(environmentId, props.projectId, space);
  const inputRef = useRef<TextInputInstance | null>(null);
  const [queryInput, setQueryInput] = useState("");
  const query = useDebouncedValue(queryInput.trim(), 250);
  const body = !canRead ? (
    <ProjectViewMessage
      title="Memory read access needed"
      detail="This connection cannot read memory on this server."
    />
  ) : space === null ? (
    <ProjectViewMessage
      title="Memory is not ready"
      detail="Memory is off or still getting ready on this server."
    />
  ) : scope === null || scope.status === "loading" ? (
    <ProjectViewMessage title="Loading project memory…" />
  ) : scope.status !== "ready" ? (
    <ProjectViewMessage {...SCOPE_MESSAGE[scope.status]} />
  ) : (
    <MemoryPages
      key={query}
      environmentId={environmentId}
      projectId={props.projectId}
      memorySpaceId={space}
      scope={scope.scope}
      query={query}
    />
  );
  return (
    <View className="gap-3">
      {scope?.status === "ready" ? (
        <View className="flex-row">
          <SearchField
            inputRef={inputRef}
            autoFocus={false}
            accessibilityLabel="Search project memories"
            clearAccessibilityLabel="Clear search"
            placeholder="Search memories"
            value={queryInput}
            onChangeText={setQueryInput}
          />
        </View>
      ) : null}
      {body}
    </View>
  );
}

function MemoryPages(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly memorySpaceId: MemorySpaceId;
  readonly scope: MemoryScope;
  readonly query: string;
}) {
  const { environmentId, query } = props;
  const leaveSheet = useLeaveSheet();
  const forget = useForgetMemory(environmentId);
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  const cursor = cursors.at(-1);
  const input = memoryBrowseInput({
    memorySpaceId: props.memorySpaceId,
    scope: props.scope,
    limit: MEMORY_PAGE_MAX_ITEMS,
    ...(cursor ? { cursor } : {}),
  });
  const page = useEnvironmentQuery(
    query
      ? memory.search({ environmentId, input: memorySearchInput(input, query) })
      : memory.list({ environmentId, input: { ...input, includeQuarantined: false } }),
  );
  const value = page.data ? Option.getOrNull(page.data) : null;
  if (page.error !== null) {
    return <ProjectViewMessage title="Could not load memories" detail={page.error} />;
  }
  if (value === null) return <ProjectViewMessage title="Loading memories…" />;
  const items = value.items.filter((item): item is ActiveMemory => item.status === "active");
  const edit = (item: ActiveMemory) =>
    leaveSheet("SettingsMemory", {
      environmentId,
      memorySpaceId: item.memorySpaceId,
      memoryId: item.memoryId,
      project: { environmentId, projectId: ProjectId.make(props.projectId) },
    });
  return (
    <View className="gap-3">
      {items.length === 0 ? (
        <ProjectViewMessage
          title={query ? "No matching memories" : "No memories yet"}
          detail={
            query
              ? "Try other words."
              : "What agents learn about this project shows here, ready to edit or forget."
          }
        />
      ) : (
        <ListSection>
          {items.map((item) => {
            const rule = isMemoryRule(item.payload.text);
            const text = memoryPreview(rule ? memoryRuleText(item) : item.payload.text);
            return (
              <View key={item.memoryId} className="flex-row items-center bg-grouped-card">
                <RowPressable
                  accessibilityRole="button"
                  accessibilityLabel={`Edit memory: ${text}`}
                  onPress={() => edit(item)}
                  className="min-w-0 flex-1 bg-grouped-card"
                >
                  <ListRowLayout
                    label={text}
                    meta={
                      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                        {[rule ? "Rule" : null, item.pendingSync ? "Not synced" : null]
                          .filter(Boolean)
                          .map((chip) => `${chip} · `)
                          .join("")}
                        <RelativeTime timestamp={item.revision.createdAtUtc} />
                      </Text>
                    }
                  />
                </RowPressable>
                <IconButton
                  accessibilityLabel="Forget memory"
                  icon="trash"
                  onPress={() => forget(item)}
                />
              </View>
            );
          })}
        </ListSection>
      )}
      {cursors.length === 0 && !value.nextCursor ? null : (
        <View className="flex-row justify-between">
          <Button
            tone="secondary"
            size="compact"
            label="Newer"
            disabled={cursors.length === 0}
            onPress={() => setCursors((current) => current.slice(0, -1))}
          />
          <Button
            tone="secondary"
            size="compact"
            label="Older"
            disabled={!value.nextCursor}
            onPress={() => {
              const next = value.nextCursor;
              if (next) setCursors((current) => [...current, next]);
            }}
          />
        </View>
      )}
    </View>
  );
}
