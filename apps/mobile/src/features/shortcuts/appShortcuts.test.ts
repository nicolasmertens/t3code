import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { NavigationState } from "@react-navigation/native";
import { describe, expect, it } from "vite-plus/test";

import type { RecentThreadShortcut } from "../../persistence/imperative";
import { makeThreadShellFixture } from "../../test-fixtures";
import {
  activeThreadRef,
  areShortcutActionsEqual,
  buildIosShortcutActions,
  buildShortcutActions,
  MAX_IOS_SHORTCUTS,
  QUICK_SCRATCH_SHORTCUT_HREF,
  QUICK_SCRATCH_SHORTCUT_ID,
  selectIosShortcutThreads,
  shortcutHref,
  withRecentThreadShortcut,
} from "./appShortcuts";

function navState(route: { name: string; params?: unknown }): NavigationState {
  return { index: 0, routes: [route] } as unknown as NavigationState;
}

function thread(suffix: string, title = `Thread ${suffix}`): RecentThreadShortcut {
  return { environmentId: `env-${suffix}`, threadId: `thread-${suffix}`, title };
}

describe("withRecentThreadShortcut", () => {
  it("moves a reopened thread to the front without duplicating it", () => {
    const next = withRecentThreadShortcut([thread("a"), thread("b")], thread("b"));
    expect(next.map((entry) => entry.threadId)).toEqual(["thread-b", "thread-a"]);
  });

  it("keeps the known title when a reopen records an empty one", () => {
    const current = [thread("a", "Fix the build")];
    const next = withRecentThreadShortcut(current, thread("a", ""));
    expect(next).toBe(current);
  });
});

describe("buildShortcutActions", () => {
  it("deep-links threads with encoded route params", () => {
    const actions = buildShortcutActions([
      { environmentId: "env 1", threadId: "thread/2", title: "Spaced out" },
    ]);
    expect(actions[1]?.params?.href).toBe("/threads/env%201/thread%2F2");
    expect(actions[1]?.title).toBe("Spaced out");
  });
});

describe("shortcutHref", () => {
  it("accepts exactly the destinations shortcuts can produce", () => {
    expect(shortcutHref({ id: "x", title: "x", params: { href: "/new" } })).toBe("/new");
    expect(shortcutHref({ id: "x", title: "x", params: { href: "/new/scratch" } })).toBe(
      "/new/scratch",
    );
    expect(shortcutHref({ id: "x", title: "x", params: { href: "/threads/env-1/thread-2" } })).toBe(
      "/threads/env-1/thread-2",
    );
    expect(
      shortcutHref({ id: "x", title: "x", params: { href: "/threads/env%201/thread%2F2" } }),
    ).toBe("/threads/env%201/thread%2F2");
  });

  it("rejects everything else", () => {
    for (const href of [
      "https://evil.example",
      "//evil.example",
      "/settings",
      "/threads/only-one-segment",
      "/threads/a/b/c",
      "/threads//x",
      "/threads/a/b?x=1",
      "/threads/a/b#frag",
      "/new/extra",
    ]) {
      expect(shortcutHref({ id: "x", title: "x", params: { href } })).toBe(null);
    }
    expect(shortcutHref({ id: "x", title: "x", params: { href: 3 } })).toBe(null);
    expect(shortcutHref({ id: "x", title: "x" })).toBe(null);
  });
});

describe("activeThreadRef", () => {
  it("returns null instead of throwing for malformed params", () => {
    const malformed: unknown[] = [
      undefined,
      {},
      { environmentId: "env-1" },
      { environmentId: "", threadId: "thread-2" },
      { environmentId: "   ", threadId: "thread-2" },
      { environmentId: "env-1", threadId: "  " },
      { environmentId: 42, threadId: "thread-2" },
      { environmentId: { nested: true }, threadId: "thread-2" },
      { environmentId: [], threadId: [] },
    ];
    for (const params of malformed) {
      expect(activeThreadRef(navState({ name: "Thread", params }))).toBe(null);
    }
  });
});

describe("launcher shortcut ids", () => {
  it("cannot collide across different env/thread pairs", () => {
    const a = buildShortcutActions([{ environmentId: "a-b", threadId: "c", title: "x" }]);
    const b = buildShortcutActions([{ environmentId: "a", threadId: "b-c", title: "x" }]);
    expect(a[1]?.id).not.toBe(b[1]?.id);
  });
});

describe("selectIosShortcutThreads", () => {
  const envId = EnvironmentId.make("env-1");
  const projA = ProjectId.make("proj-a");
  const projB = ProjectId.make("proj-b");
  const projectTitleByKey = new Map<string, string>([
    [`${envId}:${projA}`, "Browne"],
    [`${envId}:${projB}`, "Openbot"],
  ]);
  const nowIso = "2026-11-26T12:00:00.000Z";

  const makeRuntime = (
    status: "failed" | "running" | "idle",
    updatedAt: string,
    extra: Partial<{ readonly lastErrorClass: "usage_limit" | "provider_error" }> = {},
  ) => ({
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: status === "failed" ? "boom" : null,
    lastErrorClass: extra.lastErrorClass ?? null,
    updatedAt,
  });

  it("orders attention threads by urgency then recency, deduplicating recents", () => {
    const approvalOld = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-approval-old"),
      projectId: projA,
      title: "Approve migration",
      hasPendingApprovals: true,
      updatedAt: "2026-11-26T10:00:00.000Z",
    });
    const approvalNew = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-approval-new"),
      projectId: projB,
      title: "Approve deploy",
      hasPendingApprovals: true,
      updatedAt: "2026-11-26T11:30:00.000Z",
    });
    const input = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-input"),
      projectId: projB,
      title: "Pick branch",
      hasPendingUserInput: true,
      pendingUserInputAt: "2026-11-26T11:45:00.000Z",
      updatedAt: "2026-11-26T11:45:00.000Z",
    });
    const request = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-request"),
      projectId: projA,
      title: "Guest question",
      pendingGuestMessageCount: 1,
      updatedAt: "2026-11-26T11:50:00.000Z",
    });
    const failed = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-failed"),
      projectId: projA,
      title: "Build broken",
      runtime: makeRuntime("failed", "2026-11-26T11:55:00.000Z"),
      updatedAt: "2026-11-26T11:55:00.000Z",
    });
    const limited = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-limited"),
      projectId: projA,
      title: "Quota hit",
      runtime: makeRuntime("failed", "2026-11-26T11:58:00.000Z", {
        lastErrorClass: "usage_limit",
      }),
      updatedAt: "2026-11-26T11:58:00.000Z",
    });
    const recentLive = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-recent"),
      projectId: projB,
      title: "New live title",
      updatedAt: "2026-11-26T11:59:00.000Z",
    });

    const selected = selectIosShortcutThreads({
      threads: [input, failed, approvalOld, limited, request, approvalNew, recentLive],
      projectTitleByKey,
      recents: [
        { environmentId: envId, threadId: "t-input", title: "Old input title" },
        { environmentId: envId, threadId: "t-recent", title: "Stale title" },
      ],
      savedEnvironmentIds: new Set([envId]),
      nowIso,
      maxCount: 8,
    });

    expect(selected).toEqual([
      {
        environmentId: envId,
        threadId: "t-approval-new",
        title: "Approve deploy",
        projectTitle: "Openbot",
        attentionKind: "approval",
      },
      {
        environmentId: envId,
        threadId: "t-approval-old",
        title: "Approve migration",
        projectTitle: "Browne",
        attentionKind: "approval",
      },
      {
        environmentId: envId,
        threadId: "t-input",
        title: "Pick branch",
        projectTitle: "Openbot",
        attentionKind: "input",
      },
      {
        environmentId: envId,
        threadId: "t-request",
        title: "Guest question",
        projectTitle: "Browne",
        attentionKind: "request",
      },
      {
        environmentId: envId,
        threadId: "t-failed",
        title: "Build broken",
        projectTitle: "Browne",
        attentionKind: "failed",
      },
      {
        environmentId: envId,
        threadId: "t-limited",
        title: "Quota hit",
        projectTitle: "Browne",
        attentionKind: "limited",
      },
      {
        environmentId: envId,
        threadId: "t-recent",
        title: "New live title",
        projectTitle: "Openbot",
        attentionKind: null,
      },
    ]);
  });

  it("excludes archived, deleted, subagent, settled failures, and snoozed inputs unless waking", () => {
    const archived = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-archived"),
      hasPendingApprovals: true,
      archivedAt: "2026-11-26T09:00:00.000Z",
    });
    const deleted = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-deleted"),
      hasPendingApprovals: true,
      deletedAt: "2026-11-26T09:00:00.000Z",
    });
    const subagent = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-subagent"),
      hasPendingApprovals: true,
      lineage: {
        rootThreadId: ThreadId.make("t-root"),
        parentThreadId: ThreadId.make("t-root"),
        relationshipToParent: "subagent",
      },
    });
    const settledFailed = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-settled-fail"),
      settledOverride: "settled",
      runtime: makeRuntime("failed", "2026-11-26T11:00:00.000Z"),
    });
    const snoozedOldInput = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-snoozed-input"),
      hasPendingUserInput: true,
      pendingUserInputAt: "2026-11-26T10:00:00.000Z",
      snoozedAt: "2026-11-26T10:30:00.000Z",
      snoozedUntil: "2026-11-26T15:00:00.000Z",
    });
    const snoozedApproval = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-snoozed-approval"),
      hasPendingApprovals: true,
      snoozedAt: "2026-11-26T10:30:00.000Z",
      snoozedUntil: "2026-11-26T15:00:00.000Z",
    });
    const activeFallback = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-active-fallback"),
      projectId: projA,
      title: "Active fallback",
      updatedAt: "2026-11-26T11:20:00.000Z",
    });
    const settledFallback = makeThreadShellFixture({
      environmentId: envId,
      id: ThreadId.make("t-settled-fallback"),
      settledAt: "2026-11-26T11:50:00.000Z",
      updatedAt: "2026-11-26T11:50:00.000Z",
    });

    const selected = selectIosShortcutThreads({
      threads: [
        archived,
        deleted,
        subagent,
        settledFailed,
        snoozedOldInput,
        snoozedApproval,
        activeFallback,
        settledFallback,
      ],
      projectTitleByKey,
      recents: [{ environmentId: envId, threadId: "t-archived", title: "Archived" }],
      savedEnvironmentIds: new Set([envId]),
      nowIso,
      maxCount: 5,
    });

    expect(selected.map((item) => [item.threadId, item.attentionKind])).toEqual([
      ["t-snoozed-approval", "approval"],
      ["t-active-fallback", null],
    ]);
  });
});

describe("buildIosShortcutActions", () => {
  it("puts Quick task first and formats attention and recent thread actions within MAX_IOS_SHORTCUTS", () => {
    const actions = buildIosShortcutActions({
      threads: [
        {
          environmentId: "env-1",
          threadId: "t-1",
          title: "Approve push",
          projectTitle: "Browne",
          attentionKind: "approval",
        },
        {
          environmentId: "env-1",
          threadId: "t-2",
          title: "Answer question",
          projectTitle: "Openbot",
          attentionKind: "input",
        },
        {
          environmentId: "env-1",
          threadId: "t-3",
          title: "Recent chat",
          projectTitle: null,
          attentionKind: null,
        },
        {
          environmentId: "env-1",
          threadId: "t-4",
          title: "Overflow",
          projectTitle: "Browne",
          attentionKind: "failed",
        },
      ],
      featureShortcuts: [],
    });

    expect(actions).toHaveLength(MAX_IOS_SHORTCUTS);
    expect(actions[0]).toEqual({
      id: QUICK_SCRATCH_SHORTCUT_ID,
      title: "Quick task",
      subtitle: "No project",
      icon: "symbol:square.and.pencil",
      params: { href: QUICK_SCRATCH_SHORTCUT_HREF },
    });
    expect(actions[1]).toEqual({
      id: "thread:/threads/env-1/t-1",
      title: "Approve push",
      subtitle: "Needs approval · Browne",
      icon: "symbol:checkmark.shield.fill",
      params: { href: "/threads/env-1/t-1" },
    });
    expect(actions[2]).toEqual({
      id: "thread:/threads/env-1/t-2",
      title: "Answer question",
      subtitle: "Needs input · Openbot",
      icon: "symbol:exclamationmark.bubble.fill",
      params: { href: "/threads/env-1/t-2" },
    });
    expect(actions[3]).toEqual({
      id: "thread:/threads/env-1/t-3",
      title: "Recent chat",
      subtitle: "Recent thread",
      icon: "symbol:bubble.left.and.text.bubble.right",
      params: { href: "/threads/env-1/t-3" },
    });
  });

  it("reserves Slot 1 and at least 1 thread slot when featureShortcuts are registered", () => {
    const actions = buildIosShortcutActions({
      threads: [
        {
          environmentId: "env-1",
          threadId: "t-1",
          title: "Top attention",
          projectTitle: "Browne",
          attentionKind: "failed",
        },
        {
          environmentId: "env-1",
          threadId: "t-2",
          title: "Second",
          projectTitle: "Browne",
          attentionKind: "limited",
        },
      ],
      featureShortcuts: [
        {
          id: "discuss-emails",
          title: () => "Discuss emails",
          subtitle: () => "Urgent mail",
          icon: "symbol:envelope.badge.fill",
          href: "/new/discuss-emails",
        },
        {
          id: "talk-to-fleet",
          title: () => "Talk to Fleet",
          icon: "symbol:waveform",
          href: "/talk-to-fleet",
        },
        {
          id: "extra-ignored",
          title: () => "Ignored",
          icon: "symbol:star",
          href: "/extra",
        },
      ],
    });

    expect(actions.map((item) => item.id)).toEqual([
      QUICK_SCRATCH_SHORTCUT_ID,
      "discuss-emails",
      "talk-to-fleet",
      "thread:/threads/env-1/t-1",
    ]);
    expect(actions[3]?.subtitle).toBe("Failed · Browne");
  });

  it("includes Talk to Fleet in the default iOS feature shortcuts and allowlists /talk-to-fleet", () => {
    const actions = buildIosShortcutActions({
      threads: [
        {
          environmentId: "env-1",
          threadId: "t-1",
          title: "Top attention",
          projectTitle: "Browne",
          attentionKind: "approval",
        },
      ],
    });
    expect(actions.map((item) => item.id)).toEqual([
      QUICK_SCRATCH_SHORTCUT_ID,
      "talk-to-fleet",
      "thread:/threads/env-1/t-1",
    ]);
    expect(actions[1]).toMatchObject({
      id: "talk-to-fleet",
      icon: "symbol:waveform",
      params: { href: "/talk-to-fleet" },
    });
  });
});

describe("areShortcutActionsEqual", () => {
  it("compares action arrays by serialized fields", () => {
    const base = [
      {
        id: "quick-scratch",
        title: "Quick task",
        subtitle: "No project",
        icon: "symbol:square.and.pencil",
        params: { href: "/new/scratch" },
      },
    ];
    expect(areShortcutActionsEqual(null, base)).toBe(false);
    expect(areShortcutActionsEqual(base, [{ ...base[0]!, params: { href: "/new/scratch" } }])).toBe(
      true,
    );
    expect(areShortcutActionsEqual(base, [{ ...base[0]!, subtitle: undefined }])).toBe(false);
    expect(areShortcutActionsEqual(base, [...base, base[0]!])).toBe(false);
  });
});
