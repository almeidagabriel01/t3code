import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformEffect({
      decode: (raw) => {
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === "string"
              ? raw.provider
              : undefined;
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        };
        if (raw.options !== undefined) base.options = raw.options;
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
      },
      encode: (value) => {
        const base: Record<string, unknown> = {
          instanceId: value.instanceId,
          model: value.model,
        };
        if (value.options !== undefined) base.options = value.options;
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
      },
    }),
  ),
);
export type ModelSelection = typeof ModelSelection.Type;

/** The longest model id or option a client or an agent may send with a pick. */
export const PICKED_MODEL_MAX_CHARS = 256;
/** A model id a client or an agent sends: `ModelSelection`'s, bounded. */
export const PickedModelSlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PICKED_MODEL_MAX_CHARS),
);

/**
 * A model a client or an agent picks for some work: `ModelSelection`'s wire form with its strings
 * and options bounded. Stored settings keep `ModelSelection`, so values saved before still decode.
 */
export const PickedModelSelection = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: PickedModelSlug,
  options: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: PickedModelSlug,
        value: Schema.Union([PickedModelSlug, Schema.Boolean]),
      }),
    ).check(Schema.isMaxLength(32)),
  ),
});
