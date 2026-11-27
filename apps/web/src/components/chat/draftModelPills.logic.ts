import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import { providerModelKey } from "../../modelOrdering";
import {
  isProviderInstancePickerReady,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { resolveModelPickerSelectedModel } from "./ModelPickerContent";
import {
  getDisplayModelName,
  getTriggerDisplayModelName,
  type ModelEsque,
} from "./providerIconUtils";

export interface DraftModelPillItem {
  readonly key: string;
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly model: string;
  readonly label: string;
  readonly disambiguationLabel?: string | undefined;
  readonly fullLabel: string;
  readonly providerDisplayName: string;
  readonly providerAccentColor?: string | undefined;
  readonly acpRegistryAgentId?: string | undefined;
  readonly acpRegistryIconUrl?: string | undefined;
  readonly showInstanceBadge: boolean;
  readonly isSelected: boolean;
  readonly isFavorite: boolean;
  readonly isUnavailable: boolean;
}

export interface ResolveDraftModelPillsInput {
  readonly favorites: ReadonlyArray<{
    readonly provider: ProviderInstanceId;
    readonly model: string;
  }>;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModel: string;
  readonly selectedModels?:
    | ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly model: string }>
    | null
    | undefined;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey?: string | null | undefined;
  readonly getModelDisabledReason?:
    | ((instanceId: ProviderInstanceId, model: string) => string | null)
    | undefined;
}

function matchesLockedProvider(
  entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">,
  lockedProvider: ProviderDriverKind | null,
  lockedContinuationGroupKey: string | null | undefined,
): boolean {
  if (lockedProvider === null) return true;
  if (entry.driverKind !== lockedProvider) return false;
  if (!lockedContinuationGroupKey) return true;
  return entry.continuationGroupKey === lockedContinuationGroupKey;
}

function resolveOptionForEntry(
  entry: ProviderInstanceEntry,
  model: string,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): ModelEsque | undefined {
  const options = modelOptionsByInstance.get(entry.instanceId) ?? [];
  return resolveModelPickerSelectedModel({
    driverKind: entry.driverKind,
    model,
    options,
  });
}

function buildPillItem(input: {
  readonly entry: ProviderInstanceEntry;
  readonly option: ModelEsque;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly isSelected: boolean;
  readonly isFavorite: boolean;
}): DraftModelPillItem {
  const { entry, option } = input;
  return {
    key: providerModelKey(entry.instanceId, option.slug),
    instanceId: entry.instanceId,
    driverKind: entry.driverKind,
    model: option.slug,
    label: getTriggerDisplayModelName(option, entry.driverKind),
    fullLabel: getDisplayModelName(option),
    providerDisplayName: entry.displayName,
    ...(entry.accentColor !== undefined ? { providerAccentColor: entry.accentColor } : {}),
    ...(entry.acpRegistryAgentId !== undefined
      ? { acpRegistryAgentId: entry.acpRegistryAgentId }
      : {}),
    ...(entry.acpRegistryIconUrl !== undefined
      ? { acpRegistryIconUrl: entry.acpRegistryIconUrl }
      : {}),
    showInstanceBadge: shouldShowInstanceBadge(entry, input.instanceEntries),
    isSelected: input.isSelected,
    isFavorite: input.isFavorite,
    isUnavailable: option.isUnavailable === true,
  };
}

const DISAMBIGUATION_PREFIX_LENGTH = 16;

function labelCollisionKey(label: string): string {
  return label.trim().toLowerCase().slice(0, DISAMBIGUATION_PREFIX_LENGTH);
}

function shortProviderTag(displayName: string): string {
  return displayName.split("·")[0]?.trim() || displayName.trim();
}

function attachDisambiguationLabels(
  pills: ReadonlyArray<DraftModelPillItem>,
): ReadonlyArray<DraftModelPillItem> {
  const instancesByPrefix = new Map<string, Set<ProviderInstanceId>>();
  for (const pill of pills) {
    const key = labelCollisionKey(pill.label);
    let instances = instancesByPrefix.get(key);
    if (!instances) {
      instances = new Set();
      instancesByPrefix.set(key, instances);
    }
    instances.add(pill.instanceId);
  }
  return pills.map((pill) => {
    const instances = instancesByPrefix.get(labelCollisionKey(pill.label));
    if (!instances || instances.size < 2) return pill;
    const tag = shortProviderTag(pill.providerDisplayName);
    if (!tag || pill.label.toLowerCase().includes(tag.toLowerCase())) return pill;
    return { ...pill, disambiguationLabel: tag };
  });
}

/**
 * Resolves the inline pill strip items shown below the new-thread composer.
 *
 * Returns an empty array when the user has no pickable favorites so the composer falls back to the
 * standard dropdown trigger. When favorites exist and the active model is not a favorite, the
 * active model is prepended so the current selection is always visible.
 */
export function resolveDraftModelPills(
  input: ResolveDraftModelPillsInput,
): ReadonlyArray<DraftModelPillItem> {
  const entryByInstanceId = new Map(
    input.instanceEntries.map((entry) => [entry.instanceId, entry]),
  );

  const selectedList =
    input.selectedModels && input.selectedModels.length > 0
      ? input.selectedModels
      : [{ instanceId: input.activeInstanceId, model: input.activeModel }];

  const resolvedSelections: Array<{
    readonly key: string;
    readonly entry: ProviderInstanceEntry;
    readonly option: ModelEsque;
  }> = [];
  const selectedKeySet = new Set<string>();

  for (const selection of selectedList) {
    const entry = entryByInstanceId.get(selection.instanceId);
    if (!entry) continue;
    const option = resolveOptionForEntry(entry, selection.model, input.modelOptionsByInstance);
    if (!option) continue;
    if (entry.driverKind === "antigravity" && option.slug === ANTIGRAVITY_DEFAULT_MODEL) {
      continue;
    }
    const key = providerModelKey(entry.instanceId, option.slug);
    if (selectedKeySet.has(key)) continue;
    selectedKeySet.add(key);
    resolvedSelections.push({ key, entry, option });
  }

  const favoritePills: DraftModelPillItem[] = [];
  const seenKeys = new Set<string>();

  for (const favorite of input.favorites) {
    const entry = entryByInstanceId.get(favorite.provider);
    if (!entry || !isProviderInstancePickerReady(entry)) continue;
    if (!matchesLockedProvider(entry, input.lockedProvider, input.lockedContinuationGroupKey)) {
      continue;
    }
    const option = resolveOptionForEntry(entry, favorite.model, input.modelOptionsByInstance);
    if (!option || option.isUnavailable === true) continue;
    if (entry.driverKind === "antigravity" && option.slug === ANTIGRAVITY_DEFAULT_MODEL) {
      continue;
    }
    if (input.getModelDisabledReason?.(entry.instanceId, option.slug) != null) continue;
    const key = providerModelKey(entry.instanceId, option.slug);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    favoritePills.push(
      buildPillItem({
        entry,
        option,
        instanceEntries: input.instanceEntries,
        isSelected: selectedKeySet.has(key),
        isFavorite: true,
      }),
    );
  }

  if (favoritePills.length === 0) {
    return [];
  }

  const prependedNonFavorites: DraftModelPillItem[] = [];
  for (const selection of resolvedSelections) {
    if (seenKeys.has(selection.key)) continue;
    seenKeys.add(selection.key);
    prependedNonFavorites.push(
      buildPillItem({
        entry: selection.entry,
        option: selection.option,
        instanceEntries: input.instanceEntries,
        isSelected: true,
        isFavorite: false,
      }),
    );
  }

  return attachDisambiguationLabels([...prependedNonFavorites, ...favoritePills]);
}
