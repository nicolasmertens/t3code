import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatXResearchSideChatPrompt,
  resolveGrokXResearchModelSelection,
} from "./xResearchSideChat";

function makeProvider(
  instanceId: string,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function makeModel(slug: string, isLegacy = false): ServerProvider["models"][number] {
  return {
    slug,
    name: slug,
    isCustom: false,
    ...(isLegacy ? { isLegacy: true } : {}),
    capabilities: null,
  };
}

describe("resolveGrokXResearchModelSelection", () => {
  it("picks the default grok instance and grok-4.7-build-fast when ready", () => {
    const result = resolveGrokXResearchModelSelection([
      makeProvider("claudeAgent", "claudeAgent", { models: [makeModel("claude-opus-5-5")] }),
      makeProvider("grok_alt", "grok", { models: [makeModel("grok-4.6")] }),
      makeProvider("grok", "grok", {
        models: [makeModel("grok-4.7"), makeModel("grok-4.7-build-fast")],
      }),
    ]);
    expect(result).toEqual({
      instanceId: ProviderInstanceId.make("grok"),
      model: "grok-4.7-build-fast",
    });
  });

  it("falls back to grok-4.7, then first non-legacy model, then default slug", () => {
    expect(
      resolveGrokXResearchModelSelection([
        makeProvider("grok", "grok", { models: [makeModel("grok-4.7")] }),
      ]),
    ).toEqual({ instanceId: ProviderInstanceId.make("grok"), model: "grok-4.7" });

    expect(
      resolveGrokXResearchModelSelection([
        makeProvider("grok", "grok", {
          models: [makeModel("grok-old", true), makeModel("grok-custom")],
        }),
      ]),
    ).toEqual({ instanceId: ProviderInstanceId.make("grok"), model: "grok-custom" });

    expect(resolveGrokXResearchModelSelection([makeProvider("grok", "grok")])).toEqual({
      instanceId: ProviderInstanceId.make("grok"),
      model: "grok-4.7-build-fast",
    });
  });

  it("returns null when Grok is disabled, missing, unavailable, or unauthenticated", () => {
    expect(resolveGrokXResearchModelSelection([])).toBeNull();
    expect(
      resolveGrokXResearchModelSelection([makeProvider("grok", "grok", { enabled: false })]),
    ).toBeNull();
    expect(
      resolveGrokXResearchModelSelection([makeProvider("grok", "grok", { installed: false })]),
    ).toBeNull();
    expect(
      resolveGrokXResearchModelSelection([
        makeProvider("grok", "grok", { availability: "unavailable" }),
      ]),
    ).toBeNull();
    expect(
      resolveGrokXResearchModelSelection([
        makeProvider("grok", "grok", { auth: { status: "unauthenticated" } }),
      ]),
    ).toBeNull();
  });
});

describe("formatXResearchSideChatPrompt", () => {
  it("returns empty string for blank input and keeps explicit X prompts verbatim", () => {
    expect(formatXResearchSideChatPrompt("   ")).toBe("");
    expect(formatXResearchSideChatPrompt("check https://x.com/expo/status/123")).toBe(
      "check https://x.com/expo/status/123",
    );
    expect(formatXResearchSideChatPrompt("what is trending on X for swiftui?")).toBe(
      "what is trending on X for swiftui?",
    );
  });

  it("adds native X search guidance when prompt has no explicit X reference", () => {
    expect(formatXResearchSideChatPrompt("Expo SDK 56 iOS widgets")).toBe(
      "Research on X (using your native X search tools, with @handles, America/New_York dates, and exact x.com status URLs): Expo SDK 56 iOS widgets",
    );
  });
});
