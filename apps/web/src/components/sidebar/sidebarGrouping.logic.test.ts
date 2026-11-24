import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  buildScratchProjectKeySet,
  classifySidebarThreadTriage,
  computeSidebarGroupRollup,
  countTriageBuckets,
  filterThreadsByTriage,
  groupThreadsByStatus,
  isSidebarGroupDoneOnly,
  parseSidebarFolderDropProjectKey,
  resolveEffectiveSidebarGroupMode,
  sidebarFolderDropId,
  sortProjectFoldersByUrgency,
} from "./sidebarGrouping.logic";

const ENV = EnvironmentId.make("local");
const NOW = "2026-03-10T12:00:00.000Z";
const PROJ_A = ProjectId.make("proj-a");
const PROJ_B = ProjectId.make("proj-b");
const PROJ_SCRATCH = ProjectId.make("proj-scratch");

const baseRun = {
  runId: "run-1" as never,
  status: "completed" as const,
  requestedAt: "2026-03-10T10:00:00.000Z",
  startedAt: "2026-03-10T10:00:05.000Z",
  completedAt: "2026-03-10T10:05:00.000Z",
  assistantMessageId: null,
};

const baseRuntime = {
  status: "running" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-03-10T10:00:00.000Z",
};

function makeThread(
  id: string,
  projectId: ProjectId,
  overrides: Partial<ReturnType<typeof makeThreadFixture>> = {},
) {
  return makeThreadFixture({
    environmentId: ENV,
    id: ThreadId.make(id),
    projectId,
    title: id,
    latestRun: baseRun,
    lastVisitedAt: "2026-03-10T10:06:00.000Z",
    runtime: null,
    ...overrides,
  });
}

describe("sidebarGrouping.logic", () => {
  it("resolves effective grouping mode from persisted override or boringSidebarEnabled", () => {
    expect(resolveEffectiveSidebarGroupMode(null, false)).toBe("flat");
    expect(resolveEffectiveSidebarGroupMode(null, true)).toBe("project");
    expect(resolveEffectiveSidebarGroupMode("status", false)).toBe("status");
    expect(resolveEffectiveSidebarGroupMode("flat", true)).toBe("flat");
  });

  it("classifies thread triage states and computes rollups", () => {
    const working = makeThread("working", PROJ_A, { runtime: baseRuntime });
    const limited = makeThread("limited", PROJ_A, {
      runtime: { ...baseRuntime, status: "failed", lastErrorClass: "usage_limit" },
    });
    const failed = makeThread("failed", PROJ_A, {
      latestRun: { ...baseRun, status: "failed" },
      lastVisitedAt: "2026-03-10T10:00:00.000Z",
      runtime: { ...baseRuntime, status: "failed" },
    });
    const woke = makeThread("woke", PROJ_A, {
      snoozedAt: "2026-03-10T11:00:00.000Z",
      snoozedUntil: "2026-03-10T11:30:00.000Z",
    });
    const done = makeThread("done", PROJ_A, {
      lastVisitedAt: "2026-03-10T10:04:00.000Z",
    });
    const idle = makeThread("idle", PROJ_A);

    expect(classifySidebarThreadTriage(working, NOW).isWorking).toBe(true);
    expect(classifySidebarThreadTriage(working, NOW).urgencyTier).toBe(4);
    expect(classifySidebarThreadTriage(limited, NOW).isAttention).toBe(true);
    expect(classifySidebarThreadTriage(limited, NOW).urgencyTier).toBe(3);
    expect(classifySidebarThreadTriage(failed, NOW).isFailed).toBe(true);
    expect(classifySidebarThreadTriage(woke, NOW).isWoke).toBe(true);
    expect(classifySidebarThreadTriage(done, NOW).isDone).toBe(true);
    expect(classifySidebarThreadTriage(done, NOW).urgencyTier).toBe(1);
    expect(classifySidebarThreadTriage(idle, NOW).urgencyTier).toBe(2);

    expect(
      computeSidebarGroupRollup([working, limited, failed, woke, done, idle], NOW, {}),
    ).toEqual({
      attention: 2,
      failed: 1,
      working: 1,
      done: 1,
    });
    expect(isSidebarGroupDoneOnly([done], NOW, {})).toBe(true);
    expect(isSidebarGroupDoneOnly([done, idle], NOW, {})).toBe(false);
    expect(isSidebarGroupDoneOnly([], NOW, {})).toBe(false);
  });

  it("sorts project folders by urgency and floats No project only when urgent", () => {
    const working = makeThread("working", PROJ_A, { runtime: baseRuntime });
    const limited = makeThread("limited", PROJ_B, {
      runtime: { ...baseRuntime, status: "failed", lastErrorClass: "usage_limit" },
    });
    const done = makeThread("done", PROJ_A, { lastVisitedAt: "2026-03-10T10:04:00.000Z" });
    const idle = makeThread("idle", PROJ_SCRATCH);
    const urgentScratch = makeThread("urgent-scratch", PROJ_SCRATCH, {
      runtime: { ...baseRuntime, status: "failed", lastErrorClass: "usage_limit" },
    });

    const quietOrder = sortProjectFoldersByUrgency(
      [
        { group: { projectKey: "done-proj" }, threads: [done] },
        { group: { projectKey: "scratch", isScratch: true }, threads: [idle] },
        { group: { projectKey: "limited-proj" }, threads: [limited] },
        { group: { projectKey: "working-proj" }, threads: [working] },
      ],
      NOW,
      {},
    );
    expect(quietOrder.map((folder) => folder.group.projectKey)).toEqual([
      "working-proj",
      "limited-proj",
      "done-proj",
      "scratch",
    ]);

    const urgentOrder = sortProjectFoldersByUrgency(
      [
        { group: { projectKey: "done-proj" }, threads: [done] },
        { group: { projectKey: "scratch", isScratch: true }, threads: [urgentScratch] },
        { group: { projectKey: "working-proj" }, threads: [working] },
      ],
      NOW,
      {},
    );
    expect(urgentOrder.map((folder) => folder.group.projectKey)).toEqual([
      "working-proj",
      "scratch",
      "done-proj",
    ]);
  });

  it("counts, filters, and groups threads by triage status", () => {
    const scratchKeys = buildScratchProjectKeySet([
      {
        isScratch: true,
        memberProjectRefs: [{ environmentId: ENV, projectId: PROJ_SCRATCH }],
      },
    ]);
    const limited = makeThread("limited", PROJ_SCRATCH, {
      runtime: { ...baseRuntime, status: "failed", lastErrorClass: "usage_limit" },
    });
    const done = makeThread("done", PROJ_A, { lastVisitedAt: "2026-03-10T10:04:00.000Z" });
    const idle = makeThread("idle", PROJ_SCRATCH);
    const threads = [limited, done, idle];

    expect(countTriageBuckets(threads, scratchKeys, NOW, {})).toEqual({
      all: 3,
      attention: 1,
      done: 1,
      noProject: 2,
    });
    expect(
      filterThreadsByTriage(threads, "attention", scratchKeys, NOW, {}).map((t) => t.id),
    ).toEqual([limited.id]);
    expect(filterThreadsByTriage(threads, "done", scratchKeys, NOW, {}).map((t) => t.id)).toEqual([
      done.id,
    ]);
    expect(
      filterThreadsByTriage(threads, "no-project", scratchKeys, NOW, {}).map((t) => t.id),
    ).toEqual([limited.id, idle.id]);
    expect(
      groupThreadsByStatus(threads, NOW, {}).map((bucket) => ({
        key: bucket.key,
        ids: bucket.threads.map((t) => t.id),
      })),
    ).toEqual([
      { key: "attention", ids: [limited.id] },
      { key: "active", ids: [idle.id] },
      { key: "done", ids: [done.id] },
    ]);
  });

  it("round-trips folder drop identifiers", () => {
    const id = sidebarFolderDropId("repo:github.com/acme/demo");
    expect(parseSidebarFolderDropProjectKey(id)).toBe("repo:github.com/acme/demo");
    expect(parseSidebarFolderDropProjectKey("sidebar-marker-active")).toBeNull();
  });
});
