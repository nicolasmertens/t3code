import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("gt-react-native", () => ({
  msg: (text: string) => text,
}));
vi.mock("../../i18n/messages", () => ({
  m: (text: string) => text,
}));

import {
  BROWNE_INTEGRATIONS,
  DISCUSS_EMAILS_HREF,
  DISCUSS_EMAILS_INTEGRATION_ID,
  filterIntegrationsByQuery,
  TALK_TO_FLEET_INTEGRATION_ID,
  visibleIntegrationsForSurface,
} from "./integrationRegistry";

describe("integrationRegistry", () => {
  it("defines unique ids and hrefs for all registered integrations", () => {
    const ids = BROWNE_INTEGRATIONS.map((item) => item.id);
    const hrefs = BROWNE_INTEGRATIONS.map((item) => item.href);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(ids).toContain(DISCUSS_EMAILS_INTEGRATION_ID);
    expect(hrefs).toContain(DISCUSS_EMAILS_HREF);
  });

  it("filters integrations by surface and platform", () => {
    const iosAll = (["iosQuickAction", "homeStrip", "newTask", "commandPalette"] as const).map(
      (surface) => visibleIntegrationsForSurface(surface, "ios").map((item) => item.id),
    );
    for (const list of iosAll) {
      expect(list).toEqual([DISCUSS_EMAILS_INTEGRATION_ID, TALK_TO_FLEET_INTEGRATION_ID]);
    }

    expect(visibleIntegrationsForSurface("homeStrip", "android").map((item) => item.id)).toEqual([
      DISCUSS_EMAILS_INTEGRATION_ID,
    ]);
    expect(visibleIntegrationsForSurface("newTask", "android").map((item) => item.id)).toEqual([
      DISCUSS_EMAILS_INTEGRATION_ID,
    ]);
  });

  it("filters integrations by query across title, subtitle, and searchTerms", () => {
    const all = visibleIntegrationsForSurface("newTask", "ios");
    expect(filterIntegrationsByQuery(all, "")).toEqual(all);
    expect(filterIntegrationsByQuery(all, "godwit").map((item) => item.id)).toEqual([
      DISCUSS_EMAILS_INTEGRATION_ID,
    ]);
    expect(filterIntegrationsByQuery(all, "VOICE").map((item) => item.id)).toEqual([
      TALK_TO_FLEET_INTEGRATION_ID,
    ]);
    expect(filterIntegrationsByQuery(all, "nonexistent-xyz")).toEqual([]);
  });
});
