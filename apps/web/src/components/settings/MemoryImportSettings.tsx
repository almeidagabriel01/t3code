import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AuthMemoryWriteScope,
  AuthFilesystemReadScope,
  MemoryOperationId,
  type EnvironmentId,
  type MemorySpaceId,
  type MemoryImportSourceFormat,
  type MemoryImportSource,
  type MemoryImportPreviewItem,
} from "@t3tools/contracts";
import {
  memoryImportFormatLabels,
  memoryImportFormats,
  memoryImportSourceName,
} from "@t3tools/client-runtime/memory-import-workflow";
import { useContext, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import { memoryImportRequestFailureMessage } from "@t3tools/client-runtime/memory-import-workflow";
import { memoryEnvironment } from "../../state/memory";
import {
  registerMemoryImportDestination,
  createMemoryImportAdmission,
  canSafelyImport,
  unsafeImportBrowserMessage,
  changedImportDestinationMessage,
} from "../../lib/memoryImportRecoveryStorage";
import { randomUUID } from "../../lib/utils";
import { MemoryScopeSettings, type MemoryScopeSelection } from "./MemoryScopeSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

/** A mount may check a saved receipt; only the explicit Apply button admits writes. */
export function MemoryImportSettings({
  environmentId,
  memorySpaceId,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
}) {
  const registry = useContext(RegistryContext);
  const providerId = useId();
  const sourceFieldId = useId();
  const canImport = useAtomValue(memoryEnvironment.importProvider.permissionAtom(environmentId));
  const formats = memoryImportFormats;
  const [admission] = useState(() => {
    try {
      return createMemoryImportAdmission({ environmentId, memorySpaceId });
    } catch {
      return null;
    }
  });
  const [workflow] = useState(() => {
    try {
      if (!admission) return null;
      return memoryEnvironment.createImportWorkflow(registry, {
        fence: { environmentId, memorySpaceId, session: randomUUID() },
        recovery: admission.recovery,
        operationId: () => MemoryOperationId.make(randomUUID()),
      });
    } catch {
      return null;
    }
  });
  const progress = useSyncExternalStore(
    workflow?.subscribe ?? (() => () => {}),
    workflow?.getSnapshot ?? (() => undefined),
  );
  const [format, setFormat] = useState<MemoryImportSourceFormat | null>(null);
  const [sources, setSources] = useState<readonly MemoryImportSource[]>([]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [items, setItems] = useState<readonly MemoryImportPreviewItem[]>([]);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [scopeEpoch, setScopeEpoch] = useState(0);
  const [scope, setScope] = useState<MemoryScopeSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const authorized = useRef(canImport);
  const generation = useRef(0);
  const previousScope = useRef<MemoryScopeSelection | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    const token = generation.current;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      if (mounted.current && token === generation.current)
        setError(
          memoryImportRequestFailureMessage(error) ??
            "Import request failed. Check the result before previewing again.",
        );
    }
    if (mounted.current && token === generation.current) {
      setBusy(false);
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- recovers the saved import handle with the server and guards async results against unmount
  useEffect(() => {
    mounted.current = true;
    if (canImport) authorized.current = true;
    // Recover synchronizes the saved handle with the server, never admitting a write.
    // eslint-disable-next-line react/set-state-in-effect
    if (canImport && workflow) void run(() => workflow.recover());
    if (
      !canImport &&
      authorized.current &&
      workflow &&
      readPreparedConnection(environmentId) !== null &&
      (!readEnvironmentScope(environmentId, AuthMemoryWriteScope) ||
        !readEnvironmentScope(environmentId, AuthFilesystemReadScope))
    ) {
      generation.current++;
      setItems([]);
      setSelected([]);
      setSources([]);
      setBusy(true);
      void workflow
        .removeDestination()
        .then(() => {
          if (mounted.current) {
            setBusy(false);
          }
        })
        .catch(() => {
          if (mounted.current) setError("Could not clear saved import recovery.");
        });
    }
    return () => {
      mounted.current = false;
      generation.current++;
      if (
        workflow &&
        authorized.current &&
        readPreparedConnection(environmentId) !== null &&
        (!readEnvironmentScope(environmentId, AuthMemoryWriteScope) ||
          !readEnvironmentScope(environmentId, AuthFilesystemReadScope))
      )
        void workflow.removeDestination().catch(() => undefined);
      else workflow?.invalidate({ environmentId, memorySpaceId, session: randomUUID() });
    };
  }, [canImport, workflow, run, environmentId, memorySpaceId]);
  const changeScope = (next: MemoryScopeSelection | null) => {
    const previous = previousScope.current;
    previousScope.current = next;
    setScope(next);
    if (JSON.stringify(previous) === JSON.stringify(next) || !workflow) return;
    generation.current++;
    workflow.stop();
    workflow.invalidate({ environmentId, memorySpaceId, session: randomUUID() });
    setItems([]);
    setSelected([]);
    setSourceId(null);
    setBusy(false);
  };
  const invalidateDestination = async () => {
    generation.current++;
    previousScope.current = null;
    setScope(null);
    setScopeEpoch((current) => current + 1);
    workflow?.stop();
    workflow?.invalidate({ environmentId, memorySpaceId, session: randomUUID() });
    setError(changedImportDestinationMessage);
    setBusy(false);
    setItems([]);
    setSelected([]);
    setSources([]);
    setSourceId(null);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this destination with the import invalidation channel
  useEffect(() => {
    const unsubscribe = admission?.subscribeInvalidation(() => {
      void invalidateDestination();
    });
    const unregister = registerMemoryImportDestination(
      { environmentId, memorySpaceId },
      invalidateDestination,
    );
    return () => {
      unsubscribe?.();
      unregister();
    };
  }, [environmentId, memorySpaceId, invalidateDestination, admission]);
  const importable = items.filter((item) => item.issue === undefined && item.sourceFingerprint);
  const skipped = items.length - importable.length;
  const sourceLabel = (source: MemoryImportSource | undefined) =>
    source ? memoryImportSourceName(source.label) : undefined;
  const locked =
    busy ||
    ["previewed", "save_failed", "recovery", "saving", "applying", "checking"].includes(
      progress?.phase ?? "",
    );
  return (
    <SettingsSection title="Import memories">
      <SettingsRow
        title="Provider memories"
        description={`Import supported ${new Intl.ListFormat("en", { type: "disjunction" }).format(formats.map((f) => memoryImportFormatLabels[f]))} memories from the selected device. Other providers are not supported. Memory write and file read permissions are required.`}
      >
        <div className="space-y-4 pt-4 pb-2 sm:max-w-md">
          <div className="grid gap-1.5">
            <Label htmlFor={providerId}>Provider</Label>
            <Select
              value={format}
              disabled={!canImport || locked || !workflow}
              onValueChange={(value) => {
                setFormat(value);
                setSources([]);
                setSourceId(null);
                setItems([]);
                setSelected([]);
                workflow?.invalidate();
              }}
            >
              <SelectTrigger id={providerId} aria-label="Import provider">
                <SelectValue placeholder="Choose a provider" />
              </SelectTrigger>
              <SelectPopup>
                {formats.map((value) => (
                  <SelectItem key={value} value={value}>
                    {memoryImportFormatLabels[value]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <MemoryScopeSettings
            key={scopeEpoch}
            environmentId={environmentId}
            memorySpaceId={memorySpaceId}
            disabled={!canImport || locked}
            onChange={changeScope}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!workflow || !canImport || !format || !scope || locked}
            onClick={() =>
              void run(async () => {
                setItems([]);
                setSelected([]);
                setSourceId(null);
                const result = await workflow!.discover(format!);
                if (result && mounted.current) setSources(result.sources);
              })
            }
          >
            Find memories
          </Button>
          {progress?.phase === "discovered" && sources.length === 0 ? (
            <p className="text-xs leading-normal text-muted-foreground/80">
              No supported memories found on this device.
            </p>
          ) : null}
          {sources.length > 0 ? (
            <div className="grid gap-1.5">
              <Label htmlFor={sourceFieldId}>Project to import from</Label>
              <Select
                value={sourceId}
                disabled={!canImport || locked}
                onValueChange={(value) => {
                  const source = sources.find((candidate) => candidate.sourceId === value);
                  if (!source) return;
                  void run(async () => {
                    setSourceId(source.sourceId);
                    setItems([]);
                    setSelected([]);
                    await admission!.capturePreview();
                    const result = await workflow!.preview(source.sourceId);
                    if (result && mounted.current) setItems(result.items);
                  });
                }}
              >
                <SelectTrigger id={sourceFieldId} aria-label="Import source">
                  <SelectValue placeholder="Choose a project">
                    {sourceLabel(sources.find((source) => source.sourceId === sourceId))}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {sources.map((source) => (
                    <SelectItem key={source.sourceId} value={source.sourceId} title={source.label}>
                      {sourceLabel(source)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
          {sourceId && progress?.phase === "selecting" ? (
            importable.length > 0 ? (
              <div className="space-y-2" role="group" aria-label="Choose memories to import">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    disabled={!canImport || locked}
                    checked={selected.length === importable.length}
                    onChange={(event) =>
                      setSelected(
                        event.currentTarget.checked
                          ? importable.map((item) => item.sourceItemKey)
                          : [],
                      )
                    }
                  />
                  {`Select all (${importable.length})`}
                </label>
                {importable.map((item, index) => (
                  <label key={item.sourceItemKey} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      disabled={!canImport || locked}
                      checked={selected.includes(item.sourceItemKey)}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setSelected((current) =>
                          checked
                            ? [...current, item.sourceItemKey]
                            : current.filter((key) => key !== item.sourceItemKey),
                        );
                      }}
                    />
                    <span>
                      {item.title ?? `Memory ${index + 1}`}
                      {item.tooLargeForTurnStart
                        ? " · Stored, but too large to add to new turns automatically"
                        : ""}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-xs leading-normal text-muted-foreground/80">
                No importable memories found in this project.
              </p>
            )
          ) : null}
          {skipped > 0 && progress?.phase === "selecting" ? (
            <p className="text-xs leading-normal text-muted-foreground/80">
              {`${skipped} ${skipped === 1 ? "file" : "files"} skipped (not a supported memory).`}
            </p>
          ) : null}
          {importable.length > 0 && progress?.phase === "selecting" ? (
            <Button
              size="sm"
              disabled={
                !canImport || locked || !scope || selected.length === 0 || !canSafelyImport()
              }
              onClick={() => {
                if (!workflow || !scope) return;
                try {
                  workflow.select(
                    importable
                      .filter((item) => selected.includes(item.sourceItemKey))
                      .map((item) => ({
                        sourceItemKey: item.sourceItemKey,
                        sourceFingerprint: item.sourceFingerprint!,
                        ...scope,
                      })),
                  );
                } catch {
                  setError("Preview again before importing.");
                  return;
                }
                void run(async () => {
                  await workflow.apply();
                  setItems([]);
                  setSelected([]);
                  setSourceId(null);
                });
              }}
            >
              {`Import ${selected.length} selected`}
            </Button>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!busy && progress?.phase !== "save_failed"}
              onClick={() => {
                workflow?.stop();
              }}
            >
              Stop import
            </Button>
            {progress?.phase === "save_failed" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canImport || busy || !canSafelyImport()}
                onClick={() => void run(() => workflow!.retry())}
              >
                Retry saving import
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={!workflow || !canImport || busy}
              onClick={() => void run(() => workflow!.recover())}
            >
              Check import result
            </Button>
          </div>
        </div>
      </SettingsRow>
      {!canSafelyImport() ? (
        <SettingsRow
          title="Import unavailable"
          description={<span role="alert">{unsafeImportBrowserMessage}</span>}
        />
      ) : null}
      {!workflow ? (
        <SettingsRow
          title="Browser storage unavailable"
          description={
            <span role="alert">
              Browser storage is unavailable. Imports require saved recovery information.
            </span>
          }
        />
      ) : null}
      {progress &&
      (busy ||
        progress.message ||
        progress.stopped ||
        ["saving", "applying", "checking", "recovery", "partial", "completed"].includes(
          progress.phase,
        )) ? (
        <SettingsRow
          title="Import progress"
          description={
            <span role="status">
              {busy ? "Import request in progress. " : ""}
              {progress.message}
              {progress.stopped ? " Future chunks stopped. Already sent work can finish." : ""}{" "}
              {progress.phase === "applying" || progress.receipt
                ? `${progress.settledChunks} chunks completed.`
                : null}
            </span>
          }
        />
      ) : null}
      {progress?.receipt ? (
        <SettingsRow
          title="Import result"
          description={
            <>
              {progress.receipt.state === "partial"
                ? "Partial import; some memories may have been applied."
                : "Import results received across all chunks."}{" "}
              {progress.totals.outcomes.created ?? 0} created,{" "}
              {progress.totals.outcomes.revised ?? 0} updated,{" "}
              {progress.totals.outcomes.rejected ?? 0} rejected. Acceptance does not mean content is
              available on every device.
            </>
          }
        />
      ) : null}
      {error ? (
        <SettingsRow
          title="Import needs attention"
          description={<span role="alert">{error}</span>}
        />
      ) : null}
    </SettingsSection>
  );
}
