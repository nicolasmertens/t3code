import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  hasCompletedRun: true,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
      moveToProjectTargets: [{ id: "proj-2", name: "Beta" }],
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "move-to-project")?.disabled).toBe(true);
  });

  it("includes move-to-project submenu targets and disables them without operate permission", () => {
    const omitted = buildThreadActionMenuItems({ ...baseState, moveToProjectTargets: [] });
    expect(omitted.map((item) => item.id)).not.toContain("move-to-project");

    const items = buildThreadActionMenuItems({
      ...baseState,
      canTurnIntoProject: true,
      moveToProjectTargets: [
        { id: "proj-1", name: "Alpha" },
        { id: "proj-2", name: "Beta" },
      ],
    });
    const turnIndex = items.findIndex((item) => item.id === "turn-into-project");
    const moveIndex = items.findIndex((item) => item.id === "move-to-project");
    expect(moveIndex).toBe(turnIndex + 1);
    expect(items[moveIndex]).toMatchObject({
      id: "move-to-project",
      icon: "folder-input",
      children: [
        { id: "move-to-project:proj-1", label: "Alpha" },
        { id: "move-to-project:proj-2", label: "Beta" },
      ],
    });

    const readonlyItems = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      moveToProjectTargets: [{ id: "proj-1", name: "Alpha" }],
    });
    const readonlyMove = readonlyItems.find((item) => item.id === "move-to-project");
    expect(readonlyMove?.disabled).toBe(true);
    expect(readonlyMove?.children?.map((child) => child.disabled)).toEqual([true]);
  });

  it.each([
    ["while the thread is running", { isRunning: true }],
    ["before any run has completed", { hasCompletedRun: false }],
  ])("omits mark unread %s", (_, overrides) => {
    const items = buildThreadActionMenuItems({ ...baseState, ...overrides });
    expect(items.map((item) => item.id)).not.toContain("mark-unread");
  });

  it("disables only rename where no inline title editor exists", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canRename: false });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["rename"]);
  });
});
