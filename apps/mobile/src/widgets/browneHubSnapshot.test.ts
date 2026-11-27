import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../test-fixtures";
import {
  BROWNE_HUB_STALE_AFTER_MS,
  browneHubProjectKey,
  browneHubThreadDeepLink,
  browneHubTimeline,
  buildBrowneHubProjectOptions,
  buildBrowneHubSnapshot,
} from "./browneHubSnapshot";
import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

const ENV_1 = EnvironmentId.make("env-1");
const ENV_OTHER = EnvironmentId.make("env-unlisted");
const PROJ_A = ProjectId.make("proj-a");
const PROJ_B = ProjectId.make("proj-b");
const PROJ_SCRATCH = ProjectId.make("proj-scratch");

const NOW_ISO = "2026-11-26T14:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function makeProject(overrides: Partial<EnvironmentProject> = {}): EnvironmentProject {
  const id = overrides.id ?? PROJ_A;
  const environmentId = overrides.environmentId ?? ENV_1;
  const created = "2026-11-01T00:00:00.000Z" as EnvironmentProject["createdAt"];
  return {
    environmentId,
    id,
    title: "Browne App",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    scripts: [],
    createdAt: created,
    updatedAt: created,
    ...overrides,
  };
}

describe("browneHubSnapshot", () => {
  it("ranks urgent items approval > input > request > failed > limited and respects snooze/settled/deleted filters", () => {
    const projects = [
      makeProject({ id: PROJ_A, title: "Browne" }),
      makeProject({ id: PROJ_B, title: "Postroom" }),
    ];

    const approval = makeThreadShellFixture({
      environmentId: ENV_1,
      id: ThreadId.make("t-approval"),
      projectId: PROJ_A,
      title: "Restart server?",
      hasPendingApprovals: true,
      updatedAt: "2026-11-26T13:00:00.000Z",
    });
    const input = makeThreadShellFixture({
      environmentId: ENV_1,
      id: ThreadId.make("t-input"),
      projectId: PROJ_B,
      title: "Pick Fluvius option",
      hasPendingUserInput: true,
      pendingUserInputAt: "2026-11-26T13:45:00.000Z",
      updatedAt: "2026-11-26T13:45:00.000Z",
    });
    const request = makeThreadShellFixture({
      environmentId: ENV_1,
      id: ThreadId.make("t-request"),
      projectId: PROJ_A,
      title: "Guest question",
      pendingGuestMessageCount: 2,
      updatedAt: "2026-11-26T13:50:00.000Z",
    });
    const failed = makeThreadShellFixture({
      environmentId: ENV_1,
      id: ThreadId.make("t-failed"),
      projectId: PROJ_B,
      title: "Build failed",
      runtime: {
        status: "failed",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: null,
        lastError: "boom",
        lastErrorClass: null,
        lastErrorCode: null,
        usageLimitResetAt: null,
        updatedAt: "2026-11-26T13:55:00.000Z",
      },
    });
    const limited = makeThreadShellFixture({
      environmentId: ENV_1,
      id: ThreadId.make("t-limited"),
      projectId: PROJ_B,
      title: "Quota limited",
      runtime: {
        status: "failed",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: null,
        lastError: "limit",
        lastErrorClass: "usage_limit",
        lastErrorCode: null,
        usageLimitResetAt: null,
        updatedAt: "2026-11-26T13:56:00.000Z",
      },
    });
    const snoozedInput = makeThreadShellFixture({
      environmentId: ENV_1,
      id: ThreadId.make("t-snoozed-input"),
      projectId: PROJ_A,
      title: "Snoozed input",
      hasPendingUserInput: true,
      pendingUserInputAt: "2026-11-26T12:00:00.000Z",
      snoozedAt: "2026-11-26T13:00:00.000Z",
      snoozedUntil: "2026-11-27T12:00:00.000Z",
    });
    const raisedHandWhileSnoozed = makeThreadShellFixture({
      environmentId: ENV_1,
      id: ThreadId.make("t-raised-hand"),
      projectId: PROJ_A,
      title: "Woke approval",
      hasPendingApprovals: true,
      snoozedUntil: "2026-11-27T12:00:00.000Z",
      updatedAt: "2026-11-26T13:10:00.000Z",
    });
    const settledFailed = makeThreadShellFixture({
      environmentId: ENV_1,
      id: ThreadId.make("t-settled-failed"),
      projectId: PROJ_A,
      title: "Already handled failure",
      settledOverride: "settled",
      runtime: {
        status: "failed",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: null,
        lastError: "old",
        lastErrorClass: null,
        lastErrorCode: null,
        usageLimitResetAt: null,
        updatedAt: "2026-11-26T13:00:00.000Z",
      },
    });
    const deleted = makeThreadShellFixture({
      environmentId: ENV_1,
      id: ThreadId.make("t-deleted"),
      projectId: PROJ_A,
      hasPendingApprovals: true,
      deletedAt: "2026-11-26T13:59:00.000Z",
    });
    const unsavedEnv = makeThreadShellFixture({
      environmentId: ENV_OTHER,
      id: ThreadId.make("t-other"),
      projectId: PROJ_A,
      hasPendingApprovals: true,
    });

    const snapshot = buildBrowneHubSnapshot({
      threads: [
        failed,
        limited,
        request,
        input,
        approval,
        snoozedInput,
        raisedHandWhileSnoozed,
        settledFailed,
        deleted,
        unsavedEnv,
      ],
      projects,
      environmentLabelsById: new Map([[ENV_1, "agents"]]),
      savedEnvironmentIds: new Set([ENV_1]),
      connectedEnvCount: 1,
      totalEnvCount: 1,
      nowMs: NOW_MS,
    });

    expect(snapshot.urgentTopics.map((topic) => topic.threadId)).toEqual([
      "t-raised-hand",
      "t-approval",
      "t-input",
      "t-request",
      "t-failed",
      "t-limited",
    ]);
    expect(snapshot.stats.urgentCount).toBe(6);
    expect(snapshot.stats.approvalCount).toBe(2);
    expect(snapshot.stats.inputCount).toBe(2);
    expect(snapshot.stats.failedCount).toBe(2);
    expect(snapshot.urgentTopics[1]?.deepLink).toBe("browne://threads/env-1/t-approval");
  });

  it("computes running, doneToday, quota, and project summaries accurately", () => {
    const projects = [
      makeProject({ id: PROJ_A, title: "Browne" }),
      makeProject({ id: PROJ_B, title: "Fleet" }),
    ];

    const running = makeThreadShellFixture({
      environmentId: ENV_1,
      id: ThreadId.make("t-run"),
      projectId: PROJ_A,
      title: "Streaming response",
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: null,
        lastError: null,
        lastErrorClass: null,
        lastErrorCode: null,
        usageLimitResetAt: null,
        updatedAt: "2026-11-26T13:59:00.000Z",
      },
    });
    // Idle runtime (parked thread without active work) must not inflate runningCount.
    const parkedIdle = makeThreadShellFixture({
      environmentId: ENV_1,
      id: ThreadId.make("t-done-today"),
      projectId: PROJ_B,
      title: "Completed earlier today",
      runtime: {
        status: "idle",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: null,
        lastError: null,
        lastErrorClass: null,
        lastErrorCode: null,
        usageLimitResetAt: null,
        updatedAt: "2026-11-26T11:00:00.000Z",
      },
      updatedAt: "2026-11-26T11:00:00.000Z",
    });
    const doneYesterday = makeThreadShellFixture({
      environmentId: ENV_1,
      id: ThreadId.make("t-done-yesterday"),
      projectId: PROJ_B,
      title: "Old thread",
      updatedAt: "2026-11-24T11:00:00.000Z",
    });

    const usageSnapshot: SubscriptionUsageSnapshot = {
      checkedAt: NOW_MS,
      providers: [
        {
          name: "Claude",
          detail: "",
          expiresAt: NOW_MS + 60_000,
          totalWindows: 2,
          windows: [
            { kind: "session", label: "5h", remaining: 82, reset: "" },
            { kind: "weekly", label: "7d", remaining: 64, reset: "" },
          ],
        },
      ],
    };

    const snapshot = buildBrowneHubSnapshot({
      threads: [running, parkedIdle, doneYesterday],
      projects,
      environmentLabelsById: new Map([[ENV_1, "agents"]]),
      savedEnvironmentIds: new Set([ENV_1]),
      connectedEnvCount: 1,
      totalEnvCount: 1,
      usageSnapshot,
      nowMs: NOW_MS,
    });

    expect(snapshot.stats.runningCount).toBe(1);
    expect(snapshot.stats.doneTodayCount).toBe(1);
    expect(snapshot.stats.tightestQuotaPercent).toBe(64);
    expect(snapshot.runningTopics.map((topic) => topic.threadId)).toEqual(["t-run"]);
    expect(snapshot.projects.map((project) => project.key)).toEqual([
      browneHubProjectKey(ENV_1, PROJ_A),
      browneHubProjectKey(ENV_1, PROJ_B),
    ]);
  });

  it("encodes deep links and project configuration options while omitting archived projects", () => {
    const projects = [
      makeProject({ id: PROJ_SCRATCH, title: "Scratch", isScratch: true }),
      makeProject({ id: PROJ_A, title: "Browne App" }),
      makeProject({
        id: PROJ_B,
        title: "Archived",
        archivedAt: NOW_ISO as EnvironmentProject["archivedAt"],
      }),
    ];

    expect(browneHubThreadDeepLink("env 1", "thread/2")).toBe(
      "browne://threads/env%201/thread%2F2",
    );

    const options = buildBrowneHubProjectOptions(projects, new Map([[ENV_1, "agents"]]));
    expect(options).toEqual([
      { name: "All projects", value: "all" },
      { name: "Browne App", value: browneHubProjectKey(ENV_1, PROJ_A), subtitle: "agents" },
      { name: "Scratch", value: browneHubProjectKey(ENV_1, PROJ_SCRATCH), subtitle: "agents" },
    ]);
  });

  it("schedules a stale timeline entry only when active or urgent items exist", () => {
    const emptySnapshot = buildBrowneHubSnapshot({
      threads: [],
      projects: [],
      environmentLabelsById: new Map(),
      connectedEnvCount: 0,
      totalEnvCount: 0,
      nowMs: NOW_MS,
    });
    expect(browneHubTimeline(emptySnapshot, NOW_MS)).toHaveLength(1);
    expect(browneHubTimeline(emptySnapshot, NOW_MS)[0]?.props.stale).toBe(false);

    const activeSnapshot = buildBrowneHubSnapshot({
      threads: [
        makeThreadShellFixture({
          environmentId: ENV_1,
          id: ThreadId.make("t-active"),
          projectId: PROJ_A,
          title: "Active approval",
          hasPendingApprovals: true,
        }),
      ],
      projects: [makeProject({ id: PROJ_A, title: "Browne" })],
      environmentLabelsById: new Map([[ENV_1, "agents"]]),
      connectedEnvCount: 1,
      totalEnvCount: 1,
      nowMs: NOW_MS,
    });
    const timeline = browneHubTimeline(activeSnapshot, NOW_MS);
    expect(timeline.map((entry) => [entry.date.getTime(), entry.props.stale])).toEqual([
      [NOW_MS, false],
      [NOW_MS + BROWNE_HUB_STALE_AFTER_MS, true],
    ]);
  });
});
