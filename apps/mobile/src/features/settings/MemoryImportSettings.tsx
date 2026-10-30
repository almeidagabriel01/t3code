import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import {
  MemoryOperationId,
  sessionGrantsScope,
  type MemoryImportProviderResult,
  type MemoryScope,
  type MemorySpaceId,
} from "@t3tools/contracts";
import {
  memoryImportFormatLabels,
  memoryImportFormats,
  memoryImportSkippedSummary,
  memoryImportSourceName,
} from "@t3tools/client-runtime/memory-import-workflow";
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import * as Crypto from "expo-crypto";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { memoryImportRequestFailureMessage } from "@t3tools/client-runtime/memory-import-workflow";
import { mobileMemoryImportRecovery } from "../../persistence/memory-import-recovery";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { memoryEnvironment as memory } from "../../state/memory";
import { environmentSession } from "../../state/session";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SettingsSection } from "./components/SettingsSection";
import { settled } from "../../lib/settled";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { nativeMemoryImportOutcomes } from "./SettingsMemoryRouteScreen.logic";
import type { MemoryScreenParams } from "./SettingsMemoryRouteScreen.logic";
import type { EnvironmentId } from "@t3tools/contracts";

type Discovery = Extract<MemoryImportProviderResult, { action: "discover" }>;
type Preview = Extract<MemoryImportProviderResult, { action: "preview" }>;
const Copy = ({ children }: { children: React.ReactNode }) => (
  <Text className="p-3 text-sm text-foreground-muted">{children}</Text>
);
const Action = SettingsActionRow;

/** Mount/reconnect/foreground only recover status. Applying needs the one explicit Import action. */
export function MemoryImportSettings({
  params,
  memorySpaceId,
  scope,
  bindingToken,
  enabled,
  retireRef,
}: {
  params: MemoryScreenParams & { environmentId: EnvironmentId };
  memorySpaceId: MemorySpaceId;
  scope: MemoryScope | undefined;
  bindingToken: string;
  enabled: boolean;
  retireRef: React.RefObject<() => Promise<void>>;
}) {
  const registry = useContext(RegistryContext);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const allowed = useAtomValue(memory.importProvider.permissionAtom(params.environmentId));
  const formats = memoryImportFormats;
  const connection = useAtomValue(
    environmentSession.preparedConnectionValueAtom(params.environmentId),
  );
  const grants = useAtomValue(environmentSession.sessionStateAtom(params.environmentId));
  const revoked =
    AsyncResult.isSuccess(grants) &&
    (!sessionGrantsScope(grants.value, "memory:write") ||
      !sessionGrantsScope(grants.value, "filesystem:read"));
  const [workflow] = useState(() =>
    memory.createImportWorkflow(registry, {
      fence: { environmentId: params.environmentId, memorySpaceId, session: Crypto.randomUUID() },
      recovery: mobileMemoryImportRecovery,
      operationId: () => MemoryOperationId.make(Crypto.randomUUID()),
    }),
  );
  const state = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot);
  const [sources, setSources] = useState<Discovery | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [choosingSource, setChoosingSource] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const previous = useRef({ connection, allowed, enabled, bindingToken, scope });
  const transition = useRef(Promise.resolve());
  const invalidateSelection = useCallback(() => {
    setPreview(null);
    setSources(null);
    setSelected(new Set());
    setChoosingSource(false);
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fences the import workflow and removes revoked destinations on unmount
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      workflow.invalidate();
      // A lost connection preserves recovery. Explicit grant revocation removes this destination.
      const latestGrants = registry.get(environmentSession.sessionStateAtom(params.environmentId));
      if (
        AsyncResult.isSuccess(latestGrants) &&
        registry.get(environmentSession.preparedConnectionValueAtom(params.environmentId)) ===
          connection &&
        Option.isSome(connection) &&
        (!sessionGrantsScope(latestGrants.value, "memory:write") ||
          !sessionGrantsScope(latestGrants.value, "filesystem:read"))
      ) {
        void workflow.removeDestination().catch(() => {});
      }
    };
  }, [workflow, params.environmentId, registry, connection]);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    const token = generation.current;
    setBusy(true);
    setError(null);
    await settled(
      async () => {
        await transition.current;
        if (!mounted.current || token !== generation.current) return;
        const request = action();
        await request;
      },
      () => {
        if (mounted.current && token === generation.current) {
          setBusy(false);
          pending.current = false;
        }
      },
      (error) => {
        if (mounted.current && token === generation.current)
          setError(
            memoryImportRequestFailureMessage(error) ??
              "Import could not finish. Check the saved result before previewing again.",
          );
      },
    );
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the retire callback the parent calls before rebinding
  useEffect(() => {
    const retire = async () => {
      generation.current++;
      pending.current = false;
      setBusy(false);
      invalidateSelection();
      // Invalidation fences an admitted reply immediately; clear must settle before rebinding.
      workflow.invalidate();
      transition.current = transition.current.then(() => workflow.removeDestination());
      await transition.current;
    };
    retireRef.current = retire;
    return () => {
      retireRef.current = async () => {};
    };
  }, [workflow, retireRef, invalidateSelection]);
  const recover = useCallback(() => {
    if (["save_failed", "recovery"].includes(workflow.getSnapshot().phase)) return;
    if (!registry.get(memory.importProvider.permissionAtom(params.environmentId)) || !enabled)
      return;
    void run(async () => {
      if (
        await mobileMemoryImportRecovery.load({
          environmentId: params.environmentId,
          memorySpaceId,
        })
      )
        await workflow.recover();
    });
  }, [registry, params.environmentId, memorySpaceId, enabled, run, workflow]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retires the import destination when its connection, scope or binding changes
  useEffect(() => {
    const old = previous.current;
    previous.current = { connection, allowed, enabled, bindingToken, scope };
    const remove =
      (revoked && old.connection === connection && Option.isSome(connection)) ||
      (old.enabled && !enabled) ||
      old.bindingToken !== bindingToken;
    if (remove || old.connection !== connection || old.scope !== scope) {
      generation.current++;
      pending.current = false;
      // The workflow is external mutable state; retire the displayed preview with its fence.
      setBusy(false);
      invalidateSelection();
      workflow.invalidate();
      const nextFence = {
        environmentId: params.environmentId,
        memorySpaceId,
        session: Crypto.randomUUID(),
      };
      transition.current = transition.current.then(async () => {
        if (remove) await workflow.removeDestination();
        workflow.invalidate(nextFence);
      });
      void transition.current
        .then(() => {
          if (mounted.current) {
            recover();
          }
        })
        .catch(() => {
          if (mounted.current)
            setError("Could not clear the previous import. Reopen Settings before importing.");
        });
    } else if (allowed) void Promise.resolve().then(recover);
  }, [
    allowed,
    revoked,
    enabled,
    connection,
    bindingToken,
    scope,
    workflow,
    params.environmentId,
    memorySpaceId,
    recover,
    invalidateSelection,
  ]);
  useFocusEffect(
    useCallback(() => {
      recover();
      const listener = AppState.addEventListener("change", (next) => {
        if (next === "active") recover();
      });
      return () => listener.remove();
    }, [recover]),
  );
  const writable =
    allowed && enabled && !busy && state.phase !== "save_failed" && state.phase !== "recovery";
  const selecting = state.phase === "selecting";
  const importable = (preview?.items ?? []).filter(
    (item) => item.issue === undefined && item.sourceFingerprint,
  );
  const skipped = (preview?.items.length ?? 0) - importable.length;
  const importSelected = () => {
    if (!scope || !preview) return;
    try {
      workflow.select(
        importable
          .filter((item) => selected.has(item.sourceItemKey))
          .map((item) => ({
            sourceItemKey: item.sourceItemKey,
            sourceFingerprint: item.sourceFingerprint!,
            scope,
            ...(scope.kind !== "user" && params.project ? { project: params.project } : {}),
          })),
      );
    } catch {
      setError("Preview again before importing.");
      return;
    }
    void run(async () => {
      await workflow.apply();
      invalidateSelection();
    });
  };
  const hasStatus =
    state.message ||
    state.phase === "recovery" ||
    state.phase === "completed" ||
    state.phase === "partial" ||
    state.receipt ||
    error;
  return (
    <>
      <SettingsSection
        title="Import memories"
        footer="Import from Codex or Claude. Other providers are not supported."
      >
        <Copy>
          Imports into{" "}
          {savedConnectionsById[params.environmentId]?.environmentLabel ??
            "the selected environment"}{" "}
          ·{" "}
          {scope?.kind === "user"
            ? "User memories"
            : scope?.kind === "project"
              ? "the selected project"
              : scope?.kind === "thread"
                ? "the selected thread"
                : "choose a scope first"}
        </Copy>
        {!allowed ? <Copy>Memory write and file read permissions are required.</Copy> : null}
        {formats.map((value) => (
          <Action
            key={value}
            icon="arrow.down.circle"
            label={`Find ${memoryImportFormatLabels[value]} memories`}
            disabled={!writable}
            onPress={() => {
              invalidateSelection();
              void run(async () => {
                const result = await workflow.discover(value);
                if (result) setSources(result);
              });
            }}
          />
        ))}
        {sources?.sources.length === 0 ? (
          <Copy>No supported memories found on this device.</Copy>
        ) : null}
        {busy ? (
          <Action icon="stop.fill" label="Stop import" onPress={() => workflow.stop()} />
        ) : null}
        <Action
          icon="clock"
          label="Check saved import result"
          disabled={!allowed || !enabled || busy}
          onPress={() => void run(() => workflow.recover())}
        />
        {state.phase === "save_failed" ? (
          <Action
            icon="arrow.clockwise"
            label="Retry saving import"
            disabled={!allowed || !enabled || busy}
            onPress={() => void run(() => workflow.retry())}
          />
        ) : null}
      </SettingsSection>
      {sources && sources.sources.length > 0 ? (
        <SettingsSection title="Project to import from">
          {(preview && !choosingSource
            ? sources.sources.filter((source) => source.sourceId === preview.sourceId)
            : sources.sources
          ).map((source) => (
            <Action
              key={source.sourceId}
              icon={preview?.sourceId === source.sourceId ? "folder.fill" : "folder"}
              label={memoryImportSourceName(source.label)}
              disabled={!writable}
              onPress={() => {
                setSelected(new Set());
                setChoosingSource(false);
                void run(async () => {
                  const result = await workflow.preview(source.sourceId);
                  if (result) setPreview(result);
                });
              }}
            />
          ))}
          {preview && !choosingSource && sources.sources.length > 1 ? (
            <Action
              icon="arrow.left.arrow.right"
              label="Choose another project"
              disabled={!writable}
              onPress={() => setChoosingSource(true)}
            />
          ) : null}
        </SettingsSection>
      ) : null}
      {preview && selecting ? (
        importable.length > 0 ? (
          <>
            <SettingsSection
              title={`${importable.length} ${importable.length === 1 ? "memory" : "memories"} found${skipped > 0 ? ` · ${skipped} skipped` : ""}`}
              {...(skipped > 0 ? { footer: memoryImportSkippedSummary(preview.items) ?? "" } : {})}
            >
              <SettingsSwitchRow
                label={`Select all (${importable.length})`}
                value={selected.size === importable.length}
                disabled={!writable}
                onValueChange={(value) =>
                  setSelected(
                    value ? new Set(importable.map((item) => item.sourceItemKey)) : new Set(),
                  )
                }
              />
              {importable.map((item, index) => (
                <SettingsSwitchRow
                  key={item.sourceItemKey}
                  label={item.title ?? `Memory ${index + 1}`}
                  {...(item.tooLargeForTurnStart
                    ? { subtitle: "Stored, but too large to add to new turns automatically" }
                    : {})}
                  value={selected.has(item.sourceItemKey)}
                  disabled={!writable}
                  onValueChange={(value) =>
                    setSelected((old) => {
                      const next = new Set(old);
                      if (value) next.add(item.sourceItemKey);
                      else next.delete(item.sourceItemKey);
                      return next;
                    })
                  }
                />
              ))}
            </SettingsSection>
            <Button
              tone="primary"
              fullWidth
              icon="arrow.down.circle"
              label={`Import ${selected.size} selected`}
              disabled={!writable || !scope || selected.size === 0}
              onPress={importSelected}
            />
          </>
        ) : (
          <SettingsSection
            title="No memories found"
            {...(skipped > 0 ? { footer: memoryImportSkippedSummary(preview.items) ?? "" } : {})}
          >
            <Copy>No importable memories found in this project.</Copy>
          </SettingsSection>
        )
      ) : null}
      {hasStatus ? (
        <SettingsSection title="Import result">
          {state.phase === "recovery" ? (
            <Copy>Check the saved import result before continuing.</Copy>
          ) : null}
          {state.message ? <Copy>{state.message}</Copy> : null}
          {state.phase === "completed" ? (
            <Copy>
              Import completed. Accepted memories may still be processing or waiting to sync.
            </Copy>
          ) : null}
          {state.phase === "partial" ? (
            <Copy>Import stopped with partial progress. Preview again before importing more.</Copy>
          ) : null}
          {state.receipt ? (
            <Copy>
              {state.receipt.items.length} results in the latest batch; {state.receipt.remaining}{" "}
              remaining. Completed batches: {state.settledChunks}. Accepted items may still be
              processing.
            </Copy>
          ) : null}
          {state.receipt ? (
            <>
              <Copy>Totals across all import batches</Copy>
              {nativeMemoryImportOutcomes(state.totals).map((label) => (
                <Copy key={label}>{label}</Copy>
              ))}
            </>
          ) : null}
          {error ? <Copy>{error}</Copy> : null}
        </SettingsSection>
      ) : null}
    </>
  );
}
