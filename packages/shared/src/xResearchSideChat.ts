import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

const PREFERRED_GROK_MODELS = ["grok-4.7-build-fast", "grok-4.7", "grok-4.6"] as const;
const FALLBACK_GROK_MODEL = "grok-4.7-build-fast";
const HAS_X_CONTEXT_PATTERN = /\b(?:x\.com|twitter\.com|twitter)\b|\bon\s+x\b/iu;

function isUsableGrokProvider(provider: ServerProvider): boolean {
  return (
    provider.driver === "grok" &&
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.auth.status !== "unauthenticated"
  );
}

export function resolveGrokXResearchModelSelection(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const candidates = providers.filter(isUsableGrokProvider);
  if (candidates.length === 0) {
    return null;
  }
  const preferred = candidates.find((provider) => provider.instanceId === "grok") ?? candidates[0]!;
  const slugs = new Set(preferred.models.map((model) => model.slug));
  const preferredModel = PREFERRED_GROK_MODELS.find((slug) => slugs.has(slug));
  const firstNonLegacyModel = preferred.models.find((model) => model.isLegacy !== true)?.slug;
  return {
    instanceId: preferred.instanceId,
    model: preferredModel ?? firstNonLegacyModel ?? FALLBACK_GROK_MODEL,
  };
}

export function formatXResearchSideChatPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (HAS_X_CONTEXT_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return `Research on X (using your native X search tools, with @handles, America/New_York dates, and exact x.com status URLs): ${trimmed}`;
}
