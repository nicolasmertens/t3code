import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import {
  buildHomeListFilterMenuItems,
  buildQueueGroupingAppBarMenuItems,
  homeListFilterEnvironments,
} from "./home-list-filter-menu";

function environment(
  environmentId: string,
  environmentLabel: string,
  isEnabled: boolean,
): WorkspaceEnvironment {
  return {
    environmentId: environmentId as EnvironmentId,
    environmentLabel,
    displayUrl: "",
    isRelayManaged: false,
    isEnabled,
    connectionState: isEnabled ? "connected" : "available",
    connectionError: null,
    connectionErrorTraceId: null,
  };
}

it("offers only switched-on environments, sorted by label", () => {
  expect(
    homeListFilterEnvironments([
      environment("env-studio", "Studio", true),
      environment("env-laptop", "Laptop", false),
      environment("env-desk", "Desk", true),
    ]),
  ).toEqual([
    { environmentId: "env-desk", label: "Desk", connectionState: "connected" },
    { environmentId: "env-studio", label: "Studio", connectionState: "connected" },
  ]);
});

describe("queue grouping filter menus", () => {
  it("builds grouping mode choices, conditional options, and bulk actions", () => {
    const onGroupModeChange = vi.fn();
    const onUrgencyOrderChange = vi.fn();
    const onAutoCollapseDoneChange = vi.fn();
    const onMultilineRowsChange = vi.fn();
    const onWorkingShelfEnabledChange = vi.fn();
    const onExpandAllGroups = vi.fn();
    const onCollapseDoneGroups = vi.fn();
    const onCollapseAllGroups = vi.fn();

    const grouping = {
      groupMode: "project" as const,
      urgencyOrder: true,
      autoCollapseDone: false,
      multilineRows: false,
      workingShelfEnabled: true,
      hasDoneOnlyGroups: true,
      onGroupModeChange,
      onUrgencyOrderChange,
      onAutoCollapseDoneChange,
      onMultilineRowsChange,
      onWorkingShelfEnabledChange,
      onExpandAllGroups,
      onCollapseDoneGroups,
      onCollapseAllGroups,
    };

    const items = buildQueueGroupingAppBarMenuItems(grouping);
    const flatLeafs = items.flatMap((item) => ("items" in item ? item.items : [item]));
    expect(flatLeafs.map((item) => item.id)).toEqual([
      "group-mode:project",
      "group-mode:status",
      "group-mode:flat",
      "group-action:expand-all",
      "group-action:collapse-done",
      "group-action:collapse-all",
      "group-option:urgency-order",
      "group-option:auto-collapse-done",
      "group-option:multiline-rows",
      "group-option:working-shelf",
    ]);

    const menu = buildHomeListFilterMenuItems({
      environments: [],
      projects: [],
      selectedEnvironmentId: null,
      selectedProjectKey: null,
      onEnvironmentChange: vi.fn(),
      onProjectChange: vi.fn(),
      grouping: { ...grouping, groupMode: "flat" },
    });
    const groupingSubmenu = menu.find((entry) => entry.id === "grouping");
    expect(groupingSubmenu && "items" in groupingSubmenu).toBe(true);
    const flatModeLeafs =
      groupingSubmenu && "items" in groupingSubmenu
        ? groupingSubmenu.items.flatMap((entry) => ("items" in entry ? entry.items : [entry]))
        : [];
    // Flat mode hides urgency order, auto-collapse, and batch expand/collapse actions.
    expect(flatModeLeafs.map((item) => item.id)).toEqual([
      "group-mode:project",
      "group-mode:status",
      "group-mode:flat",
      "group-option:multiline-rows",
      "group-option:working-shelf",
    ]);
  });
});
