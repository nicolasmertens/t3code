import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { resolveDraftModelPills } from "./draftModelPills.logic";
import type { ModelEsque } from "./providerIconUtils";

const antigravityDriver = ProviderDriverKind.make("antigravity");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const grokDriver = ProviderDriverKind.make("grok");

function makeEntry(input: {
  instanceId: string;
  driverKind: ProviderDriverKind;
  displayName: string;
  enabled?: boolean;
  isAvailable?: boolean;
  status?: "ready" | "disabled";
  models: ReadonlyArray<{ slug: string; name: string; shortName?: string }>;
}): ProviderInstanceEntry {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const models = input.models.map((model) => ({
    slug: model.slug,
    name: model.name,
    ...(model.shortName ? { shortName: model.shortName } : {}),
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  }));
  const snapshot: ServerProvider = {
    driver: input.driverKind,
    instanceId,
    displayName: input.displayName,
    enabled: input.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: input.status ?? "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-26T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models,
  };
  return {
    instanceId,
    driverKind: input.driverKind,
    displayName: input.displayName,
    enabled: input.enabled ?? true,
    installed: true,
    status: input.status ?? "ready",
    isDefault: false,
    isAvailable: input.isAvailable ?? true,
    snapshot,
    models,
  };
}

const maxAg = makeEntry({
  instanceId: "antigravity_max_antigravity",
  driverKind: antigravityDriver,
  displayName: "Max Antigravity",
  models: [
    { slug: "gemini-4-neon", name: "Gemini 4 Neon", shortName: "4 Neon" },
    { slug: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", shortName: "4 Hydrogen" },
  ],
});

const disabledAg = makeEntry({
  instanceId: "antigravity",
  driverKind: antigravityDriver,
  displayName: "Antigravity",
  enabled: false,
  isAvailable: false,
  status: "disabled",
  models: [{ slug: "gemini-4-neon", name: "Gemini 4 Neon", shortName: "4 Neon" }],
});

const claude = makeEntry({
  instanceId: "claudeAgent",
  driverKind: claudeDriver,
  displayName: "Claude",
  models: [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5", shortName: "Opus 5.5" },
    { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", shortName: "Sonnet 5.5" },
  ],
});

const grok = makeEntry({
  instanceId: "grok",
  driverKind: grokDriver,
  displayName: "Grok Build",
  models: [{ slug: "grok-4.7", name: "Grok 4.7", shortName: "Grok 4.7" }],
});

const entries = [disabledAg, maxAg, claude, grok];
const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>(
  entries.map((entry) => [entry.instanceId, entry.models]),
);

describe("resolveDraftModelPills", () => {
  it("returns empty when no pickable favorites exist so the standard dropdown remains", () => {
    expect(
      resolveDraftModelPills({
        favorites: [],
        instanceEntries: entries,
        modelOptionsByInstance,
        activeInstanceId: maxAg.instanceId,
        activeModel: "gemini-4-neon",
        lockedProvider: null,
      }),
    ).toEqual([]);

    expect(
      resolveDraftModelPills({
        favorites: [{ provider: disabledAg.instanceId, model: "gemini-4-neon" }],
        instanceEntries: entries,
        modelOptionsByInstance,
        activeInstanceId: maxAg.instanceId,
        activeModel: "gemini-4-neon",
        lockedProvider: null,
      }),
    ).toEqual([]);
  });

  it("preserves favorite order, skips disabled providers, and marks the active favorite", () => {
    const pills = resolveDraftModelPills({
      favorites: [
        { provider: disabledAg.instanceId, model: "gemini-4-neon" },
        { provider: maxAg.instanceId, model: "gemini-4-neon" },
        { provider: claude.instanceId, model: "claude-opus-5-5" },
        { provider: maxAg.instanceId, model: "gemini-4-neon" }, // duplicate
      ],
      instanceEntries: entries,
      modelOptionsByInstance,
      activeInstanceId: claude.instanceId,
      activeModel: "claude-opus-5-5",
      lockedProvider: null,
    });

    expect(pills.map((pill) => [pill.instanceId, pill.model, pill.isSelected])).toEqual([
      [maxAg.instanceId, "gemini-4-neon", false],
      [claude.instanceId, "claude-opus-5-5", true],
    ]);
    expect(pills[0]?.label).toBe("4 Neon");
    expect(pills[1]?.label).toBe("Opus 5.5");
  });

  it("prepends the active model when it is not starred as a favorite", () => {
    const pills = resolveDraftModelPills({
      favorites: [
        { provider: maxAg.instanceId, model: "gemini-4-neon" },
        { provider: claude.instanceId, model: "claude-opus-5-5" },
      ],
      instanceEntries: entries,
      modelOptionsByInstance,
      activeInstanceId: grok.instanceId,
      activeModel: "grok-4.7",
      lockedProvider: null,
    });

    expect(pills.map((pill) => [pill.model, pill.isFavorite, pill.isSelected])).toEqual([
      ["grok-4.7", false, true],
      ["gemini-4-neon", true, false],
      ["claude-opus-5-5", true, false],
    ]);
  });

  it("highlights all selected models in multi-model mode and respects lockedProvider", () => {
    const pills = resolveDraftModelPills({
      favorites: [
        { provider: maxAg.instanceId, model: "gemini-4-neon" },
        { provider: maxAg.instanceId, model: "gemini-4-hydrogen" },
        { provider: claude.instanceId, model: "claude-opus-5-5" },
      ],
      instanceEntries: entries,
      modelOptionsByInstance,
      activeInstanceId: maxAg.instanceId,
      activeModel: "gemini-4-neon",
      selectedModels: [
        { instanceId: maxAg.instanceId, model: "gemini-4-neon" },
        { instanceId: claude.instanceId, model: "claude-opus-5-5" },
      ],
      lockedProvider: null,
    });

    expect(pills.map((pill) => [pill.model, pill.isSelected])).toEqual([
      ["gemini-4-neon", true],
      ["gemini-4-hydrogen", false],
      ["claude-opus-5-5", true],
    ]);

    const lockedPills = resolveDraftModelPills({
      favorites: [
        { provider: maxAg.instanceId, model: "gemini-4-neon" },
        { provider: claude.instanceId, model: "claude-opus-5-5" },
      ],
      instanceEntries: entries,
      modelOptionsByInstance,
      activeInstanceId: claude.instanceId,
      activeModel: "claude-opus-5-5",
      lockedProvider: claudeDriver,
    });

    expect(lockedPills.map((pill) => pill.model)).toEqual(["claude-opus-5-5"]);
  });
});
