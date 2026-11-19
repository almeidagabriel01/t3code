import type { ModelSelection, ProviderDriverKind } from "@t3tools/contracts";
import { resolveModelShortName } from "@t3tools/client-runtime/provider-clients";
import { formatModelSlugName } from "@t3tools/shared/model";

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  aliases?: ReadonlyArray<string> | undefined;
  isDefault?: boolean | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(
  model: ModelEsque,
  driverKind: ProviderDriverKind | null | undefined,
): string {
  const shortName = resolveModelShortName(model, driverKind);
  return getDisplayModelName({ ...model, shortName }, { preferShortName: true });
}

/** A selection's name as its provider lists it; a model the provider does not list reads from its slug. */
export function modelSelectionDisplayName(
  providers:
    | ReadonlyArray<{ readonly instanceId: string; readonly models: ReadonlyArray<ModelEsque> }>
    | undefined,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): string {
  const found = providers
    ?.find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((model) => model.slug === selection.model);
  return found ? getDisplayModelName(found) : formatModelSlugName(selection.model);
}
