/* oxlint-disable t3code/prefer-effect-fn -- ported as-is; Effect.fn would add spans to hot paths */
// @effect-diagnostics effectFnOpportunity:off -- hot memory path helpers; Effect.fn would add a span to every call.
import {
  MEMORY_HUB_MAX_MEMBERS,
  MemoryHubError,
  type MemoryHubForbiddenError,
  MemoryHubSettings,
  MemoryOperationId,
  type MemoryOwnerEnrollment,
  type MemoryOwnerRemoval,
  MemoryOwnerSourceReadPolicy,
  MemoryOwnerSourceReadPolicyUpdateInput,
  type MemoryOwnerSourceReadPolicyView,
  MemoryRpcError,
  MemorySourceReadRevokeAck,
  MemorySpaceId,
  matchesMemorySourceReadRevokeAck,
  ServerSettingsError,
  type EnvironmentId,
  type MemoryHubPublication,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import type * as MemoryStore from "./memory/MemoryStore.ts";
import { MemoryHubProvenance, type MemoryHubSettingsSnapshot } from "./memory/MemoryHubSettings.ts";

/** Persisted beside the settings so a crash between the settings commit and the SQL receipt reconciles. */
export const MemoryHubTransitionMarker = Schema.Struct({
  requestId: MemoryOperationId,
  version: Schema.Int,
  previousHubSpace: Schema.optionalKey(MemorySpaceId),
  provenance: Schema.optionalKey(Schema.NullOr(MemoryHubProvenance)),
});
export type HubTransitionMarker = typeof MemoryHubTransitionMarker.Type;

const encodeMemoryHubSettings = Schema.encodeEffect(Schema.fromJsonString(MemoryHubSettings));
const decodeMemoryHubSettings = Schema.decodeUnknownEffect(MemoryHubSettings);

export type MemoryHubTransition = {
  readonly requestId: MemoryOperationId;
  readonly expectedVersion: number;
  readonly settings: MemoryHubSettings;
  readonly provenance?: MemoryHubProvenance | null;
};

const transitionMemoryHubSettings = <E, R>(
  current: ServerSettings,
  input: MemoryHubTransition,
  permit: Effect.Effect<void, E, R>,
  marker: HubTransitionMarker | null,
) =>
  Effect.gen(function* () {
    yield* permit;
    const settings = yield* decodeMemoryHubSettings(input.settings).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath: "memory hub transition",
            operation: "normalize",
            cause,
          }),
      ),
    );
    const provenance = input.provenance ?? null;
    if (
      provenance !== null &&
      (settings.mode !== "hub" || settings.memorySpaceId !== provenance.memorySpaceId)
    )
      return yield* new MemoryHubError({ code: "invalid_output" });
    if (current.memoryHubVersion !== input.expectedVersion) {
      if (
        current.memoryHubVersion === input.expectedVersion + 1 &&
        marker?.requestId === input.requestId &&
        marker.version === current.memoryHubVersion &&
        (marker.provenance?.memorySpaceId ?? null) === (provenance?.memorySpaceId ?? null) &&
        (yield* encodeMemoryHubSettings(current.memoryHub).pipe(
          Effect.mapError(() => new MemoryHubError({ code: "invalid_output" })),
        )) ===
          (yield* encodeMemoryHubSettings(settings).pipe(
            Effect.mapError(() => new MemoryHubError({ code: "invalid_output" })),
          ))
      )
        return current;
      return yield* new MemoryHubError({ code: "revision_changed" });
    }
    return {
      ...current,
      memoryHub: settings,
      memoryHubVersion: current.memoryHubVersion + 1,
    };
  });

export class MemoryHubSettingsTransitions extends Context.Service<
  MemoryHubSettingsTransitions,
  {
    readonly applyMemoryHubTransition: <E, R>(
      input: MemoryHubTransition,
      permit: Effect.Effect<void, E, R>,
    ) => Effect.Effect<MemoryHubSettingsSnapshot, E | ServerSettingsError | MemoryHubError, R>;
  }
>()("t3/serverSettingsMemory/MemoryHubSettingsTransitions") {}

/** Current committed hub epoch. SQL transactions must use this instead of the full settings cache. */
export class MemoryHubCommittedSettings extends Context.Service<
  MemoryHubCommittedSettings,
  {
    readonly read: Effect.Effect<MemoryHubSettingsSnapshot>;
    readonly readPublication?: Effect.Effect<import("@t3tools/contracts").MemoryHubPublication>;
  }
>()("t3/serverSettingsMemory/MemoryHubCommittedSettings") {}

export interface MemoryOwnerSourceReadCommitted {
  readonly policy: MemoryOwnerSourceReadPolicy;
  readonly version: number;
}

export class MemoryOwnerSourceReadCommittedPolicy extends Context.Service<
  MemoryOwnerSourceReadCommittedPolicy,
  {
    readonly read: Effect.Effect<MemoryOwnerSourceReadCommitted>;
    readonly changes: Effect.Effect<
      Stream.Stream<MemoryOwnerSourceReadCommitted>,
      never,
      Scope.Scope
    >;
    readonly recordRevokeAck: (
      ack: MemorySourceReadRevokeAck,
    ) => Effect.Effect<MemoryOwnerSourceReadCommitted, ServerSettingsError | MemoryRpcError>;
  }
>()("t3/serverSettingsMemory/MemoryOwnerSourceReadCommittedPolicy") {}

export class MemoryOwnerSourceReadPolicyAdministration extends Context.Service<
  MemoryOwnerSourceReadPolicyAdministration,
  {
    readonly get: (
      permit: Effect.Effect<void, MemoryRpcError>,
    ) => Effect.Effect<MemoryOwnerSourceReadPolicyView, MemoryRpcError>;
    readonly update: (
      input: MemoryOwnerSourceReadPolicyUpdateInput,
      permit: Effect.Effect<void, MemoryRpcError>,
    ) => Effect.Effect<MemoryOwnerSourceReadPolicyView, ServerSettingsError | MemoryRpcError>;
  }
>()("t3/serverSettingsMemory/MemoryOwnerSourceReadPolicyAdministration") {}

const ownerView = ({
  policy,
  version,
}: MemoryOwnerSourceReadCommitted): MemoryOwnerSourceReadPolicyView => ({
  policy,
  version,
  revocationPropagation: policy.removals.some((r) => r.state === "pending")
    ? "pending"
    : "acknowledged",
});
export const ownerProjection = (
  settings: Pick<
    ServerSettings,
    "memoryOwnerSourceReadPolicy" | "memoryOwnerSourceReadPolicyVersion"
  >,
): MemoryOwnerSourceReadCommitted => ({
  policy: settings.memoryOwnerSourceReadPolicy,
  version: settings.memoryOwnerSourceReadPolicyVersion,
});
const ownerInvalid = () => new MemoryRpcError({ code: "invalid_output" });
const decodeOwnerPolicyRaw = Schema.decodeUnknownEffect(MemoryOwnerSourceReadPolicy);
const decodeOwnerUpdateRaw = Schema.decodeUnknownEffect(MemoryOwnerSourceReadPolicyUpdateInput);
const decodeOwnerAckRaw = Schema.decodeUnknownEffect(MemorySourceReadRevokeAck);
const decodeOwnerPolicy = (input: unknown) =>
  decodeOwnerPolicyRaw(input).pipe(Effect.mapError(ownerInvalid));
const decodeOwnerUpdate = (input: unknown) =>
  decodeOwnerUpdateRaw(input).pipe(Effect.mapError(ownerInvalid));
const decodeOwnerAck = (input: unknown) =>
  decodeOwnerAckRaw(input).pipe(Effect.mapError(ownerInvalid));
const ownerPairKey = (
  p: Pick<MemoryOwnerEnrollment, "memorySpaceId" | "ownerEnvironmentId" | "requesterEnvironmentId">,
) => JSON.stringify([p.memorySpaceId, p.ownerEnvironmentId, p.requesterEnvironmentId]);

// Retire acknowledged pairs only after retaining every fence in the monotone epoch.
// Active enrollments without a removal are valid; pending barriers must survive.
const normalizeOwnerPolicy = (policy: MemoryOwnerSourceReadPolicy) => ({
  ...policy,
  ownerPolicyEpoch: policy.removals.reduce(
    (epoch, removal) =>
      removal.state === "acknowledged" ? Math.max(epoch, removal.ack.revokedThroughEpoch) : epoch,
    policy.ownerPolicyEpoch,
  ),
  removals: policy.removals.filter((removal) => removal.state === "pending"),
});

const transitionOwnerPolicy = (
  current: MemoryOwnerSourceReadCommitted,
  input: MemoryOwnerSourceReadPolicyUpdateInput,
  space: MemorySpaceId | null,
  owner: EnvironmentId,
) =>
  Effect.gen(function* () {
    const value = yield* decodeOwnerUpdate(input);
    if (value.expectedVersion !== current.version)
      return yield* new MemoryRpcError({ code: "revision_changed" });
    const previous = normalizeOwnerPolicy(current.policy);
    const wanted = new Set(value.allowedRequesterEnvironmentIds);
    const enrollments: MemoryOwnerEnrollment[] = [];
    const removals: MemoryOwnerRemoval[] = [...previous.removals];
    let epoch = previous.ownerPolicyEpoch;
    const advance = () => ++epoch;
    for (const enrollment of previous.enrollments) {
      // Space changes never carry an enrollment into another pair implicitly.
      if (
        wanted.has(enrollment.requesterEnvironmentId) &&
        enrollment.memorySpaceId === space &&
        enrollment.ownerEnvironmentId === owner
      ) {
        enrollments.push(enrollment);
      } else if (enrollment.state === "active") {
        const removal: MemoryOwnerRemoval = {
          memorySpaceId: enrollment.memorySpaceId,
          ownerEnvironmentId: enrollment.ownerEnvironmentId,
          requesterEnvironmentId: enrollment.requesterEnvironmentId,
          removalEpoch: advance(),
          state: "pending",
        };
        const index = removals.findIndex((r) => ownerPairKey(r) === ownerPairKey(removal));
        if (index < 0) removals.push(removal);
        else removals[index] = removal;
      }
    }
    let enrolling = false;
    for (const requesterEnvironmentId of wanted) {
      if (enrollments.some((e) => e.requesterEnvironmentId === requesterEnvironmentId)) continue;
      if (space === null) return yield* new MemoryRpcError({ code: "bootstrap_required" });
      const pair = { memorySpaceId: space, ownerEnvironmentId: owner, requesterEnvironmentId };
      const removal = removals.find((r) => ownerPairKey(r) === ownerPairKey(pair));
      enrolling = true;
      const ownerPolicyEpoch = advance();
      enrollments.push(
        removal?.state === "pending"
          ? { ...pair, ownerPolicyEpoch, state: "pending", removalEpoch: removal.removalEpoch }
          : { ...pair, ownerPolicyEpoch, state: "active" },
      );
    }
    // Reserve a removal slot for every committed enrollment, including pending ones.
    // Revocation only moves an existing pair into removals and cannot grow this union.
    const reserved = new Set([...removals, ...enrollments].map(ownerPairKey)).size;
    if (enrolling && reserved > MEMORY_HUB_MAX_MEMBERS)
      return yield* new MemoryRpcError({
        code: "capacity_exceeded",
        capacity: {
          code: "capacity_exceeded",
          dimension: "members",
          current: reserved,
          limit: MEMORY_HUB_MAX_MEMBERS,
          reclaimable: 0,
        },
      });
    const policy = yield* decodeOwnerPolicy({
      allowedRequesterEnvironmentIds: [
        ...new Set(
          enrollments.filter((e) => e.state === "active").map((e) => e.requesterEnvironmentId),
        ),
      ],
      ownerPolicyEpoch: epoch,
      removals,
      enrollments,
    });
    return { policy, version: current.version + 1 };
  });

const acknowledgeOwnerPolicy = (
  current: MemoryOwnerSourceReadCommitted,
  ack: MemorySourceReadRevokeAck,
) =>
  Effect.gen(function* () {
    const value = yield* decodeOwnerAck(ack);
    const match = current.policy.removals.find(
      (r) => r.state === "pending" && matchesMemorySourceReadRevokeAck(r, value),
    );
    if (!match) return current;
    const previous = normalizeOwnerPolicy(current.policy);
    let epoch = Math.max(previous.ownerPolicyEpoch, value.revokedThroughEpoch);
    const enrollments = previous.enrollments.map((e): MemoryOwnerEnrollment => {
      if (e.state !== "pending" || ownerPairKey(e) !== ownerPairKey(match)) return e;
      return {
        memorySpaceId: e.memorySpaceId,
        ownerEnvironmentId: e.ownerEnvironmentId,
        requesterEnvironmentId: e.requesterEnvironmentId,
        ownerPolicyEpoch: ++epoch,
        state: "active",
      };
    });
    const policy = yield* decodeOwnerPolicy({
      ...previous,
      ownerPolicyEpoch: epoch,
      allowedRequesterEnvironmentIds: [
        ...new Set(
          enrollments.filter((e) => e.state === "active").map((e) => e.requesterEnvironmentId),
        ),
      ],
      enrollments,
      removals: previous.removals.filter((r) => r !== match),
    });
    return { policy, version: current.version + 1 };
  });

export type CommittedMemorySettings = Pick<
  ServerSettings,
  | "memoryHub"
  | "memoryHubVersion"
  | "memoryOwnerSourceReadPolicy"
  | "memoryOwnerSourceReadPolicyVersion"
>;

/** What the settings service hands the memory writers: its write lock and one serialized commit. */
export interface MemorySettingsCommit {
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** The caller holds the lock; the update runs against freshly loaded settings. */
  readonly commitLocked: <E, R>(
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, E | ServerSettingsError, R>,
    marker?: HubTransitionMarker,
  ) => Effect.Effect<ServerSettings, E | ServerSettingsError, R>;
  readonly marker: Effect.Effect<HubTransitionMarker | null>;
  readonly publication: Effect.Effect<MemoryHubPublication>;
  /** The last committed epochs, read without waiting on a settings reload. */
  readonly committed: Effect.Effect<CommittedMemorySettings>;
}

const HubSettingsLock = Context.Reference<boolean>("t3/serverSettings/HubSettingsLock", {
  defaultValue: () => false,
});

/** Interface seam for the hub administrator; the settings layer supplies the owner. */
export class MemoryHubAdminSettings extends Context.Service<
  MemoryHubAdminSettings,
  {
    readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly read: Effect.Effect<MemoryHubSettingsSnapshot, MemoryHubError>;
    readonly readPublication: Effect.Effect<import("@t3tools/contracts").MemoryHubPublication>;
    readonly readPreviousHubRequestId: Effect.Effect<MemoryOperationId | null, MemoryHubError>;
    readonly readPreviousHubSpace: Effect.Effect<MemorySpaceId | null, MemoryHubError>;
    readonly apply: (
      record: MemoryStore.AdminRecord,
      permit: Effect.Effect<void, MemoryHubForbiddenError>,
    ) => Effect.Effect<
      { readonly view: MemoryHubSettingsSnapshot },
      MemoryHubError | MemoryHubForbiddenError
    >;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off -- the administrator consumes this runtime key.
  "t3/memory/MemoryHubService/MemoryHubAdminSettings",
) {}

/** Origin recorded for the committed epoch; a marker for another version proves nothing. */
const provenanceOf = (
  settings: Pick<ServerSettings, "memoryHub" | "memoryHubVersion">,
  marker: HubTransitionMarker | null,
) =>
  marker?.version === settings.memoryHubVersion &&
  settings.memoryHub.mode === "hub" &&
  settings.memoryHub.memorySpaceId === marker.provenance?.memorySpaceId
    ? (marker.provenance ?? null)
    : null;

const snapshotOf = (
  settings: Pick<ServerSettings, "memoryHub" | "memoryHubVersion">,
  marker: HubTransitionMarker | null,
): MemoryHubSettingsSnapshot => ({
  settings: settings.memoryHub,
  version: settings.memoryHubVersion,
  provenance: provenanceOf(settings, marker),
});

export interface MemorySettingsServices {
  readonly transitions: MemoryHubSettingsTransitions["Service"];
  readonly committedHub: MemoryHubCommittedSettings["Service"];
  readonly committedOwner: Omit<MemoryOwnerSourceReadCommittedPolicy["Service"], "changes">;
  readonly ownerAdmin: MemoryOwnerSourceReadPolicyAdministration["Service"];
  readonly adminSettings: MemoryHubAdminSettings["Service"];
}

export const makeMemorySettingsServices = (
  commit: MemorySettingsCommit,
  read: Effect.Effect<ServerSettings, ServerSettingsError>,
  identity: Option.Option<ServerEnvironment.ServerEnvironmentIdentity["Service"]>,
): MemorySettingsServices => {
  const applyHubLocked: MemoryHubSettingsTransitions["Service"]["applyMemoryHubTransition"] = (
    input,
    permit,
  ) =>
    Effect.gen(function* () {
      const current = yield* read;
      const marker = yield* commit.marker;
      const previousHubSpace =
        input.settings.mode === "hub" && input.settings.memorySpaceId !== null
          ? input.settings.memorySpaceId
          : current.memoryHub.mode === "hub"
            ? current.memoryHub.memorySpaceId
            : marker?.previousHubSpace;
      const committed: HubTransitionMarker = {
        requestId: input.requestId,
        version: input.expectedVersion + 1,
        provenance: input.provenance ?? null,
        ...(previousHubSpace ? { previousHubSpace } : {}),
      };
      const next = yield* commit.commitLocked(
        (settings) => transitionMemoryHubSettings(settings, input, permit, marker),
        committed,
      );
      return snapshotOf(next, committed);
    });

  const committedHubRead = Effect.gen(function* () {
    const settings = yield* commit.committed;
    return snapshotOf(settings, yield* commit.marker);
  });

  const readOwner = commit.committed.pipe(Effect.map(ownerProjection));
  const commitOwner = (next: MemoryOwnerSourceReadCommitted) =>
    commit
      .commitLocked((settings) =>
        Effect.succeed({
          ...settings,
          memoryOwnerSourceReadPolicy: next.policy,
          memoryOwnerSourceReadPolicyVersion: next.version,
        }),
      )
      .pipe(Effect.map(ownerProjection));

  return {
    transitions: {
      applyMemoryHubTransition: (input, permit) => commit.withLock(applyHubLocked(input, permit)),
    },
    committedHub: { read: committedHubRead, readPublication: commit.publication },
    committedOwner: {
      read: readOwner,
      recordRevokeAck: (ack) =>
        commit.withLock(
          Effect.gen(function* () {
            const current = yield* readOwner;
            const next = yield* acknowledgeOwnerPolicy(current, ack);
            return next === current ? current : yield* commitOwner(next);
          }),
        ),
    },
    ownerAdmin: {
      get: (permit) => permit.pipe(Effect.andThen(readOwner), Effect.map(ownerView)),
      update: (input, permit) =>
        commit.withLock(
          Effect.gen(function* () {
            yield* permit;
            if (Option.isNone(identity)) return yield* new MemoryRpcError({ code: "unavailable" });
            const settings = yield* commit.committed;
            const owner = yield* identity.value.getEnvironmentId;
            const next = yield* transitionOwnerPolicy(
              ownerProjection(settings),
              input,
              settings.memoryHub.mode === "disabled" ? null : settings.memoryHub.memorySpaceId,
              owner,
            );
            yield* permit;
            return ownerView(yield* commitOwner(next));
          }),
        ),
    },
    adminSettings: {
      withLock: (effect) =>
        commit.withLock(effect.pipe(Effect.provideService(HubSettingsLock, true))),
      readPublication: commit.publication,
      read: read.pipe(
        Effect.flatMap((current) =>
          Effect.map(commit.marker, (marker) => snapshotOf(current, marker)),
        ),
        Effect.mapError(() => new MemoryHubError({ code: "storage_failed" })),
      ),
      readPreviousHubRequestId: commit.marker.pipe(Effect.map((saved) => saved?.requestId ?? null)),
      readPreviousHubSpace: read.pipe(
        Effect.flatMap((current) =>
          current.memoryHub.mode === "hub" && current.memoryHub.memorySpaceId !== null
            ? Effect.succeed(current.memoryHub.memorySpaceId)
            : Effect.map(commit.marker, (saved) => saved?.previousHubSpace ?? null),
        ),
        Effect.mapError(() => new MemoryHubError({ code: "storage_failed" })),
      ),
      apply: (record, permit) =>
        Effect.gen(function* () {
          if (!(yield* HubSettingsLock))
            return yield* new MemoryHubError({ code: "storage_failed" });
          yield* permit;
          const current = yield* read.pipe(
            Effect.mapError(() => new MemoryHubError({ code: "storage_failed" })),
          );
          const marker = yield* commit.marker;
          if (record.stage !== "activated")
            return yield* new MemoryHubError({ code: "bootstrap_required" });
          const action = record.action;
          let settings = current.memoryHub;
          if (action.action === "configure") {
            settings = action.settings;
            // The administrator supplies the space only after SQL publication commits.
            if (settings.mode === "hub" && settings.memorySpaceId === null)
              return yield* new MemoryHubError({ code: "bootstrap_required" });
          } else if (action.action === "installCredential") {
            if (!record.secretName)
              return yield* new MemoryHubError({ code: "bootstrap_required" });
            settings = {
              mode: "member",
              hubEnvironmentId: action.hubEnvironmentId,
              endpoint: action.endpoint,
              memorySpaceId: action.memorySpaceId,
              secretName: record.secretName,
            };
          }
          const view = yield* applyHubLocked(
            {
              requestId: record.requestId,
              expectedVersion: record.expectedVersion,
              settings,
              provenance:
                record.initialization === "auto-initialized" &&
                settings.mode === "hub" &&
                settings.memorySpaceId !== null
                  ? { source: "auto-initialized", memorySpaceId: settings.memorySpaceId }
                  : action.action === "configure" || action.action === "installCredential"
                    ? null
                    : provenanceOf(current, marker),
            },
            permit,
          ).pipe(
            Effect.mapError((error) =>
              error._tag === "ServerSettingsError"
                ? new MemoryHubError({ code: "storage_failed" })
                : error,
            ),
          );
          return { view };
        }),
    },
  };
};
