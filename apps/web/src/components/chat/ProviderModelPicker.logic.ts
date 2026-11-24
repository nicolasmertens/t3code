import type { ProviderDriverKind } from "@t3tools/contracts";

import type { ModelEsque } from "./providerIconUtils";

// Rendered heights in `--spacing` units. Chrome is the search box and list padding, plus a 1px border.
const MODEL_PICKER_ROW_UNITS = 8;
const MODEL_PICKER_ROW_SEPARATOR_UNITS = 0.5;
export const MODEL_PICKER_LIST_CHROME_UNITS = 15.5;
// Tall enough for all 9 jump-shortcut rows (⌘1–⌘9) plus headroom (12 rows, or 11 with a list footer)
// and 10 provider icons; keep synced with `h-120` in ProviderModelPicker and `max-h-[min(...)]` in ModelPickerContent.
export const MODEL_PICKER_MAX_HEIGHT_UNITS = 120;

export function modelPickerContentHeightUnits(rowCount: number): number {
  const rows = Math.max(0, rowCount);
  if (rows === 0) return MODEL_PICKER_LIST_CHROME_UNITS;
  return (
    rows * MODEL_PICKER_ROW_UNITS +
    (rows - 1) * MODEL_PICKER_ROW_SEPARATOR_UNITS +
    MODEL_PICKER_LIST_CHROME_UNITS
  );
}

/** Keeps a hidden model visible while its provider is locked or turned off. */
export function retainedModelWhileProviderLocked(
  entry: {
    readonly driverKind: ProviderDriverKind;
    readonly enabled: boolean;
    readonly isAvailable: boolean;
    readonly models: ReadonlyArray<Pick<ModelEsque, "slug" | "name" | "shortName" | "subProvider">>;
  } | null,
  model: string,
): ModelEsque | undefined {
  if (!entry || (entry.enabled && entry.isAvailable) || !model) return undefined;
  if (entry.driverKind === "opencode" || entry.driverKind === "antigravity") return undefined;
  return entry.models.find((candidate) => candidate.slug === model) ?? { slug: model, name: model };
}
