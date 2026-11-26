import type { ScopedProjectRef, SidebarQueuePreferences } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

export type SidebarTriageFilter = "all" | "attention" | "done" | "no-project";
export type SidebarStatusBucketKey = "attention" | "active" | "done";
export type SidebarShelfKey = "working" | "snoozed" | "settled";

export type SidebarThreadTriageStatus =
  | "approval"
  | "input"
  | "request"
  | "preparing"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export interface SidebarThreadTriage {
  readonly status: SidebarThreadTriageStatus;
  readonly isWoke: boolean;
  readonly isAttention: boolean;
  readonly isFailed: boolean;
  readonly isWorking: boolean;
  readonly isDone: boolean;
  /** Higher means more urgent: 4 running/blocking, 3 limited/failed/woke, 2 idle, 1 done-only. */
  readonly urgencyTier: 1 | 2 | 3 | 4;
}

export interface SidebarGroupRollup {
  readonly attention: number;
  readonly failed: number;
  readonly working: number;
  readonly done: number;
}

export interface SidebarStatusBucket<TThread = EnvironmentThreadShell> {
  readonly key: SidebarStatusBucketKey;
  readonly threads: readonly TThread[];
}

export interface SidebarShelfProjectGroup<TGroup, TThread> {
  readonly group: TGroup;
  readonly threads: TThread[];
}

/**
 * Classifies a thread's triage state and urgency tier from platform-normalized
 * row status, snooze wake state, and unseen-completion state.
 */
export function deriveSidebarThreadTriage(input: {
  readonly status: SidebarThreadTriageStatus;
  readonly isWoke: boolean;
  readonly hasUnseenCompletion: boolean;
}): SidebarThreadTriage {
  const { status, isWoke, hasUnseenCompletion } = input;
  const isFailed = status === "failed";
  const isInteractiveBlock = status === "approval" || status === "input" || status === "request";
  const isWorking = status === "working" || status === "preparing";
  const isLimited = status === "limited";
  const isAttention = isInteractiveBlock || isFailed || isLimited || isWoke;
  const isDone = !isAttention && !isWorking && status === "ready" && hasUnseenCompletion;

  const urgencyTier: 1 | 2 | 3 | 4 =
    isWorking || isInteractiveBlock ? 4 : isLimited || isFailed || isWoke ? 3 : isDone ? 1 : 2;

  return {
    status,
    isWoke,
    isAttention,
    isFailed,
    isWorking,
    isDone,
    urgencyTier,
  };
}

/** Tallies failed, attention, working, and unseen-done counts across a group's threads. */
export function computeSidebarGroupRollupWith<TThread>(
  threads: readonly TThread[],
  classify: (thread: TThread) => SidebarThreadTriage,
): SidebarGroupRollup {
  let attention = 0;
  let failed = 0;
  let working = 0;
  let done = 0;
  for (const thread of threads) {
    const triage = classify(thread);
    if (triage.isFailed) failed += 1;
    else if (triage.isAttention) attention += 1;
    else if (triage.isWorking) working += 1;
    else if (triage.isDone) done += 1;
  }
  return { attention, failed, working, done };
}

/** True when a non-empty group contains exclusively unseen-done threads. */
export function isSidebarGroupDoneOnlyWith<TThread>(
  threads: readonly TThread[],
  classify: (thread: TThread) => SidebarThreadTriage,
): boolean {
  if (threads.length === 0) return false;
  return threads.every((thread) => classify(thread).isDone);
}

function computeFolderUrgencyRankWith<TThread>(
  threads: readonly TThread[],
  classify: (thread: TThread) => SidebarThreadTriage,
): number {
  if (threads.length === 0) return 0;
  let maxTier = 1;
  for (const thread of threads) {
    const { urgencyTier } = classify(thread);
    if (urgencyTier > maxTier) maxTier = urgencyTier;
  }
  return maxTier;
}

/**
 * Sorts project folders by highest-priority thread inside them:
 * Running / Interactive -> Limited / Failed / Woke -> Idle -> Done-only -> Empty.
 * "No project" stays pinned at the bottom unless it contains urgent (tier >= 3) threads,
 * in which case it floats up to its urgency tier.
 */
export function sortProjectFoldersByUrgencyWith<
  TThread,
  TFolder extends { readonly threads: readonly TThread[] },
>(
  folders: readonly TFolder[],
  classify: (thread: TThread) => SidebarThreadTriage,
  isScratchFolder: (folder: TFolder) => boolean,
): TFolder[] {
  return folders
    .map((folder, index) => {
      const rank = computeFolderUrgencyRankWith(folder.threads, classify);
      const isUrgent = rank >= 3;
      const pinToBottom = isScratchFolder(folder) && !isUrgent;
      return { folder, index, rank, pinToBottom };
    })
    .sort((left, right) => {
      if (left.pinToBottom !== right.pinToBottom) {
        return left.pinToBottom ? 1 : -1;
      }
      if (right.rank !== left.rank) {
        return right.rank - left.rank;
      }
      return left.index - right.index;
    })
    .map(({ folder }) => folder);
}

/** Collects `environmentId:projectId` keys belonging to scratch ("No project") groups. */
export function buildScratchProjectKeySet(
  groups: ReadonlyArray<{
    readonly isScratch?: boolean;
    readonly memberProjectRefs: readonly ScopedProjectRef[];
  }>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const group of groups) {
    if (!group.isScratch) continue;
    for (const ref of group.memberProjectRefs) {
      keys.add(`${ref.environmentId}:${ref.projectId}`);
    }
  }
  return keys;
}

/** Whether a thread belongs to a scratch ("No project") project. */
export function isScratchThread(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
  scratchProjectKeys: ReadonlySet<string>,
): boolean {
  return scratchProjectKeys.has(`${thread.environmentId}:${thread.projectId}`);
}

/** Counts triage filter buckets across a list of threads. */
export function countTriageBucketsWith<
  TThread extends Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
>(
  threads: readonly TThread[],
  scratchProjectKeys: ReadonlySet<string>,
  classify: (thread: TThread) => SidebarThreadTriage,
): {
  readonly all: number;
  readonly attention: number;
  readonly done: number;
  readonly noProject: number;
} {
  let attention = 0;
  let done = 0;
  let noProject = 0;
  for (const thread of threads) {
    const triage = classify(thread);
    if (triage.isAttention) attention += 1;
    if (triage.isDone) done += 1;
    if (isScratchThread(thread, scratchProjectKeys)) noProject += 1;
  }
  return {
    all: threads.length,
    attention,
    done,
    noProject,
  };
}

/** Filters threads according to the active triage chip. */
export function filterThreadsByTriageWith<
  TThread extends Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
>(
  threads: readonly TThread[],
  filter: SidebarTriageFilter,
  scratchProjectKeys: ReadonlySet<string>,
  classify: (thread: TThread) => SidebarThreadTriage,
): readonly TThread[] {
  if (filter === "all") return threads;
  return threads.filter((thread) => {
    if (filter === "no-project") return isScratchThread(thread, scratchProjectKeys);
    const triage = classify(thread);
    if (filter === "attention") return triage.isAttention;
    return triage.isDone;
  });
}

/** Partitions threads into non-empty status buckets: attention -> active -> done. */
export function groupThreadsByStatusWith<TThread>(
  threads: readonly TThread[],
  classify: (thread: TThread) => SidebarThreadTriage,
): SidebarStatusBucket<TThread>[] {
  const attention: TThread[] = [];
  const active: TThread[] = [];
  const done: TThread[] = [];
  for (const thread of threads) {
    const triage = classify(thread);
    if (triage.isAttention) {
      attention.push(thread);
    } else if (triage.isDone) {
      done.push(thread);
    } else {
      active.push(thread);
    }
  }
  const buckets: SidebarStatusBucket<TThread>[] = [];
  if (attention.length > 0) buckets.push({ key: "attention", threads: attention });
  if (active.length > 0) buckets.push({ key: "active", threads: active });
  if (done.length > 0) buckets.push({ key: "done", threads: done });
  return buckets;
}

/** Storage key for a shelf project folder's collapse state. */
export function sidebarShelfFolderStateKey(shelf: SidebarShelfKey, projectKey: string): string {
  return `${shelf}:${projectKey}`;
}

/** Accessibility/row identifier for a shelf project folder. */
export function sidebarShelfFolderRowId(shelf: SidebarShelfKey, projectKey: string): string {
  return `shelf:${shelf}:folder:${projectKey}`;
}

/**
 * Groups a shelf's threads by project folder, ordered by first appearance in `threads`.
 * Threads whose project is not in `groups` stay in `ungroupedThreads`.
 */
export function groupShelfThreadsByProject<
  TGroup extends { readonly memberProjectRefs: readonly ScopedProjectRef[] },
  TThread extends Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
>(
  groups: readonly TGroup[],
  threads: readonly TThread[],
  getGroupKey: (group: TGroup) => string,
): {
  readonly folders: Array<SidebarShelfProjectGroup<TGroup, TThread>>;
  readonly ungroupedThreads: TThread[];
} {
  const groupByProject = new Map<string, TGroup>();
  for (const group of groups) {
    for (const ref of group.memberProjectRefs) {
      groupByProject.set(`${ref.environmentId}:${ref.projectId}`, group);
    }
  }
  const folders: Array<SidebarShelfProjectGroup<TGroup, TThread>> = [];
  const folderByKey = new Map<string, SidebarShelfProjectGroup<TGroup, TThread>>();
  const ungroupedThreads: TThread[] = [];
  for (const thread of threads) {
    const group = groupByProject.get(`${thread.environmentId}:${thread.projectId}`);
    if (group === undefined) {
      ungroupedThreads.push(thread);
      continue;
    }
    const groupKey = getGroupKey(group);
    let folder = folderByKey.get(groupKey);
    if (folder === undefined) {
      folder = { group, threads: [] };
      folderByKey.set(groupKey, folder);
      folders.push(folder);
    }
    folder.threads.push(thread);
  }
  return { folders, ungroupedThreads };
}

/**
 * Selects the newest remote `SidebarQueuePreferences` snapshot across connected
 * environments when its `updatedAt` timestamp is strictly newer than `localSyncedAt`.
 */
export function resolveRemoteSidebarQueuePreferencesUpdate(
  candidates: Iterable<SidebarQueuePreferences | null | undefined>,
  localSyncedAt: string | null | undefined,
): {
  readonly preferences: SidebarQueuePreferences;
  readonly updatedAt: string;
} | null {
  let latest: SidebarQueuePreferences | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate?.updatedAt) continue;
    const ms = Date.parse(candidate.updatedAt);
    if (!Number.isFinite(ms)) continue;
    if (
      latest === null ||
      ms > latestMs ||
      (ms === latestMs && candidate.updatedAt > (latest.updatedAt ?? ""))
    ) {
      latest = candidate;
      latestMs = ms;
    }
  }
  if (latest === null || latest.updatedAt === undefined) return null;
  const localMs = localSyncedAt ? Date.parse(localSyncedAt) : Number.NaN;
  if (Number.isFinite(localMs) && latestMs <= localMs) {
    return null;
  }
  return { preferences: latest, updatedAt: latest.updatedAt };
}
