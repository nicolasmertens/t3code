import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  saveMobilePreferences: {},
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => async () => {} }));

import {
  planInboundMobileQueuePreferencesPatch,
  resolveMobileGroupingPreferences,
} from "./use-thread-list-v2-grouping-preferences";

describe("use-thread-list-v2-grouping-preferences helpers", () => {
  it("defaults mobile grouping preferences to project mode and compact single-line rows", () => {
    const resolved = resolveMobileGroupingPreferences(undefined);
    expect(resolved.groupMode).toBe("project");
    expect(resolved.urgencyOrder).toBe(true);
    expect(resolved.autoCollapseDone).toBe(false);
    expect(resolved.multilineRows).toBe(false);
    expect(resolved.workingShelfEnabled).toBe(true);
    expect(resolved.collapsedProjectGroups.size).toBe(0);
    expect(resolved.collapsedStatusGroups.size).toBe(0);
    expect(resolved.collapsedShelfProjectGroups.size).toBe(0);
  });

  it("applies strictly newer remote sidebarQueuePreferences and ignores older ones", () => {
    const patch = planInboundMobileQueuePreferencesPatch(
      [
        {
          groupMode: "status",
          urgencyOrder: false,
          autoCollapseDone: true,
          workingShelfEnabled: false,
          updatedAt: "2026-11-26T12:00:00.000Z",
        },
      ],
      { sidebarQueuePreferencesSyncedAt: "2026-11-26T11:00:00.000Z" },
    );
    expect(patch).toEqual({
      sidebarQueuePreferencesSyncedAt: "2026-11-26T12:00:00.000Z",
      threadListGroupMode: "status",
      threadListUrgencyOrder: false,
      threadListAutoCollapseDone: true,
      workingShelfEnabled: false,
    });

    expect(
      planInboundMobileQueuePreferencesPatch(
        [{ groupMode: "flat", updatedAt: "2026-11-26T12:00:00.000Z" }],
        { sidebarQueuePreferencesSyncedAt: "2026-11-26T12:00:00.000Z" },
      ),
    ).toBeNull();

    // Null groupMode on desktop resets mobile back to its default project mode.
    expect(
      planInboundMobileQueuePreferencesPatch(
        [{ groupMode: null, updatedAt: "2026-11-26T12:05:00.000Z" }],
        { sidebarQueuePreferencesSyncedAt: "2026-11-26T12:00:00.000Z" },
      ),
    ).toEqual({
      sidebarQueuePreferencesSyncedAt: "2026-11-26T12:05:00.000Z",
      threadListGroupMode: "project",
    });
  });
});
