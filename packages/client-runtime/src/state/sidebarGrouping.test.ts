import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildScratchProjectKeySet,
  computeSidebarGroupRollupWith,
  countTriageBucketsWith,
  deriveSidebarThreadTriage,
  filterThreadsByTriageWith,
  groupShelfThreadsByProject,
  groupThreadsByStatusWith,
  isScratchThread,
  isSidebarGroupDoneOnlyWith,
  resolveRemoteSidebarQueuePreferencesUpdate,
  sidebarShelfFolderRowId,
  sidebarShelfFolderStateKey,
  sortProjectFoldersByUrgencyWith,
  type SidebarThreadTriage,
} from "./sidebarGrouping.ts";

const ENV = EnvironmentId.make("local");
const PROJ_A = ProjectId.make("proj-a");
const PROJ_B = ProjectId.make("proj-b");
const PROJ_SCRATCH = ProjectId.make("proj-scratch");

interface TestThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly triage: SidebarThreadTriage;
}

function makeThread(
  id: string,
  projectId: ProjectId,
  input: Parameters<typeof deriveSidebarThreadTriage>[0],
): TestThread {
  return {
    environmentId: ENV,
    id: ThreadId.make(id),
    projectId,
    triage: deriveSidebarThreadTriage(input),
  };
}

describe("sidebarGrouping", () => {
  it("derives triage flags and urgency tiers consistently", () => {
    expect(
      deriveSidebarThreadTriage({ status: "working", isWoke: false, hasUnseenCompletion: false }),
    ).toMatchObject({ isWorking: true, isAttention: false, isDone: false, urgencyTier: 4 });
    expect(
      deriveSidebarThreadTriage({ status: "approval", isWoke: false, hasUnseenCompletion: false }),
    ).toMatchObject({ isWorking: false, isAttention: true, urgencyTier: 4 });
    expect(
      deriveSidebarThreadTriage({ status: "failed", isWoke: false, hasUnseenCompletion: false }),
    ).toMatchObject({ isFailed: true, isAttention: true, urgencyTier: 3 });
    expect(
      deriveSidebarThreadTriage({ status: "limited", isWoke: false, hasUnseenCompletion: false }),
    ).toMatchObject({ isFailed: false, isAttention: true, urgencyTier: 3 });
    expect(
      deriveSidebarThreadTriage({ status: "ready", isWoke: true, hasUnseenCompletion: true }),
    ).toMatchObject({ isWoke: true, isAttention: true, isDone: false, urgencyTier: 3 });
    expect(
      deriveSidebarThreadTriage({ status: "ready", isWoke: false, hasUnseenCompletion: true }),
    ).toMatchObject({ isDone: true, isAttention: false, urgencyTier: 1 });
    expect(
      deriveSidebarThreadTriage({ status: "waiting", isWoke: false, hasUnseenCompletion: false }),
    ).toMatchObject({ isDone: false, isWorking: false, urgencyTier: 2 });
  });

  it("computes rollups, done-only checks, and urgency ordering with scratch pinning", () => {
    const working = makeThread("w", PROJ_A, {
      status: "working",
      isWoke: false,
      hasUnseenCompletion: false,
    });
    const failed = makeThread("f", PROJ_A, {
      status: "failed",
      isWoke: false,
      hasUnseenCompletion: false,
    });
    const woke = makeThread("wk", PROJ_B, {
      status: "ready",
      isWoke: true,
      hasUnseenCompletion: false,
    });
    const done = makeThread("d", PROJ_A, {
      status: "ready",
      isWoke: false,
      hasUnseenCompletion: true,
    });
    const idleScratch = makeThread("s", PROJ_SCRATCH, {
      status: "ready",
      isWoke: false,
      hasUnseenCompletion: false,
    });
    const urgentScratch = makeThread("us", PROJ_SCRATCH, {
      status: "limited",
      isWoke: false,
      hasUnseenCompletion: false,
    });

    const classify = (t: TestThread) => t.triage;
    expect(computeSidebarGroupRollupWith([working, failed, woke, done], classify)).toEqual({
      attention: 1,
      failed: 1,
      working: 1,
      done: 1,
    });
    expect(isSidebarGroupDoneOnlyWith([done], classify)).toBe(true);
    expect(isSidebarGroupDoneOnlyWith([done, idleScratch], classify)).toBe(false);
    expect(isSidebarGroupDoneOnlyWith([], classify)).toBe(false);

    const quietOrder = sortProjectFoldersByUrgencyWith(
      [
        { key: "done", isScratch: false, threads: [done] },
        { key: "scratch", isScratch: true, threads: [idleScratch] },
        { key: "woke", isScratch: false, threads: [woke] },
        { key: "working", isScratch: false, threads: [working] },
      ],
      classify,
      (folder) => folder.isScratch,
    );
    expect(quietOrder.map((folder) => folder.key)).toEqual(["working", "woke", "done", "scratch"]);

    const urgentOrder = sortProjectFoldersByUrgencyWith(
      [
        { key: "done", isScratch: false, threads: [done] },
        { key: "scratch", isScratch: true, threads: [urgentScratch] },
        { key: "working", isScratch: false, threads: [working] },
      ],
      classify,
      (folder) => folder.isScratch,
    );
    expect(urgentOrder.map((folder) => folder.key)).toEqual(["working", "scratch", "done"]);
  });

  it("counts, filters, and groups by status and shelf project", () => {
    const scratchKeys = buildScratchProjectKeySet([
      { isScratch: true, memberProjectRefs: [{ environmentId: ENV, projectId: PROJ_SCRATCH }] },
    ]);
    const limited = makeThread("limited", PROJ_SCRATCH, {
      status: "limited",
      isWoke: false,
      hasUnseenCompletion: false,
    });
    const done = makeThread("done", PROJ_A, {
      status: "ready",
      isWoke: false,
      hasUnseenCompletion: true,
    });
    const idle = makeThread("idle", PROJ_B, {
      status: "ready",
      isWoke: false,
      hasUnseenCompletion: false,
    });
    const classify = (t: TestThread) => t.triage;

    expect(isScratchThread(limited, scratchKeys)).toBe(true);
    expect(isScratchThread(done, scratchKeys)).toBe(false);
    expect(countTriageBucketsWith([limited, done, idle], scratchKeys, classify)).toEqual({
      all: 3,
      attention: 1,
      done: 1,
      noProject: 1,
    });
    expect(
      filterThreadsByTriageWith([limited, done, idle], "no-project", scratchKeys, classify).map(
        (t) => t.id,
      ),
    ).toEqual([limited.id]);
    expect(
      groupThreadsByStatusWith([limited, done, idle], classify).map((b) => [
        b.key,
        b.threads.map((t) => t.id),
      ]),
    ).toEqual([
      ["attention", [limited.id]],
      ["active", [idle.id]],
      ["done", [done.id]],
    ]);

    const orphan = makeThread("orphan", ProjectId.make("missing"), {
      status: "ready",
      isWoke: false,
      hasUnseenCompletion: false,
    });
    const shelf = groupShelfThreadsByProject(
      [
        { id: "a", memberProjectRefs: [{ environmentId: ENV, projectId: PROJ_A }] },
        { id: "b", memberProjectRefs: [{ environmentId: ENV, projectId: PROJ_B }] },
      ],
      [idle, orphan, done],
      (g) => g.id,
    );
    expect(shelf.folders.map((f) => f.group.id)).toEqual(["b", "a"]);
    expect(shelf.ungroupedThreads.map((t) => t.id)).toEqual([orphan.id]);
    expect(sidebarShelfFolderStateKey("snoozed", "a")).toBe("snoozed:a");
    expect(sidebarShelfFolderRowId("working", "a")).toBe("shelf:working:folder:a");
  });

  it("picks the newest strictly newer remote queue preference snapshot", () => {
    const older = { groupMode: "flat" as const, updatedAt: "2026-11-26T10:00:00.000Z" };
    const newer = {
      groupMode: "status" as const,
      urgencyOrder: false,
      updatedAt: "2026-11-26T11:00:00.000Z",
    };

    expect(resolveRemoteSidebarQueuePreferencesUpdate([undefined, older, newer], null)).toEqual({
      preferences: newer,
      updatedAt: "2026-11-26T11:00:00.000Z",
    });
    expect(
      resolveRemoteSidebarQueuePreferencesUpdate([older, newer], "2026-11-26T11:00:00.000Z"),
    ).toBeNull();
    expect(
      resolveRemoteSidebarQueuePreferencesUpdate([older, newer], "2026-11-26T12:00:00.000Z"),
    ).toBeNull();
    expect(resolveRemoteSidebarQueuePreferencesUpdate([{ groupMode: "project" }], null)).toBeNull();
  });
});
