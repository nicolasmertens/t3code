import { afterEach, expect, it, vi } from "vite-plus/test";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.nicolasmertens.browne"],
  ["development", "com.nicolasmertens.browne.dev"],
  ["preview", "com.nicolasmertens.browne.preview"],
  ["production", "com.nicolasmertens.browne"],
])("keeps the Browne iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  expect(config.ios?.appleTeamId).toBe("33QSRBWAD4");
  expect(config.ios?.associatedDomains).toEqual([]);
  expect(config.ios?.infoPlist?.UIBackgroundModes).toEqual(["audio", "remote-notification"]);
});

it("registers the configurable stack-ready BrowneHub widget for iOS", async () => {
  const config = await loadConfig("production");
  const widgetsEntry = config.plugins?.find(
    (plugin): plugin is [string, { widgets?: Array<Record<string, unknown>> }] =>
      Array.isArray(plugin) && plugin[0] === "expo-widgets",
  );
  expect(widgetsEntry).toBeDefined();
  const hub = widgetsEntry?.[1]?.widgets?.find((widget) => widget.name === "BrowneHub") as
    | {
        ios?: {
          supportedFamilies?: string[];
          initialLayout?: string;
          configuration?: { parameters?: Record<string, { dynamic?: boolean; default?: unknown }> };
        };
      }
    | undefined;
  expect(hub?.ios?.supportedFamilies).toEqual([
    "systemSmall",
    "systemMedium",
    "systemLarge",
    "accessoryRectangular",
  ]);
  expect(hub?.ios?.initialLayout).toBe("./src/widgets/BrowneHubWidget.tsx");
  expect(hub?.ios?.configuration?.parameters?.projectKey?.dynamic).toBe(true);
  expect(hub?.ios?.configuration?.parameters?.viewMode?.default).toBe("auto");
});
