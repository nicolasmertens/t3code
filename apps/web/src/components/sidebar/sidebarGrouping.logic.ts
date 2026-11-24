import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import {
  hasUnseenCompletion,
  resolveSidebarRowStatus,
  resolveThreadLastVisitedAt,
  type SidebarThreadStatus,
} from "../Sidebar.logic";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarQueueGroupMode } from "../../uiStateStore";

export type SidebarTriageFilter = "all" | "attention" | "done" | "no-project";
export type SidebarStatusBucketKey = "attention" | "active" | "done";

export interface SidebarThreadTriage {
  readonly status: SidebarThreadStatus;
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

export function resolveEffectiveSidebarGroupMode(
  persistedMode: SidebarQueueGroupMode | null,
  boringSidebarEnabled: boolean,
): SidebarQueueGroupMode {
  if (persistedMode !== null) return persistedMode;
  return boringSidebarEnabled ? "project" : "flat";
}

export function classifySidebarThreadTriage(
  thread: EnvironmentThreadShell,
  snoozeNow: string,
  localLastVisitedAt?: string,
): SidebarThreadTriage {
  const effectiveThread = {
    ...thread,
    lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
  };
  const status = resolveSidebarRowStatus(effectiveThread);
  const isWoke = threadWokeAt(thread, { now: snoozeNow }) !== null;
  const isFailed = status === "failed";
  const isInteractiveBlock = status === "approval" || status === "input" || status === "request";
  const isWorking = status === "working" || status === "preparing";
  const isLimited = status === "limited";
  const isAttention = isInteractiveBlock || isFailed || isLimited || isWoke;
  const isDone =
    !isAttention && !isWorking && status === "ready" && hasUnseenCompletion(effectiveThread);

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

export function computeSidebarGroupRollup(
  threads: readonly EnvironmentThreadShell[],
  snoozeNow: string,
  localLastVisitedAtById: Readonly<Record<string, string>>,
): SidebarGroupRollup {
  let attention = 0;
  let failed = 0;
  let working = 0;
  let done = 0;
  for (const thread of threads) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const triage = classifySidebarThreadTriage(thread, snoozeNow, localLastVisitedAtById[key]);
    if (triage.isFailed) failed += 1;
    else if (triage.isAttention) attention += 1;
    else if (triage.isWorking) working += 1;
    else if (triage.isDone) done += 1;
  }
  return { attention, failed, working, done };
}

export function isSidebarGroupDoneOnly(
  threads: readonly EnvironmentThreadShell[],
  snoozeNow: string,
  localLastVisitedAtById: Readonly<Record<string, string>>,
): boolean {
  if (threads.length === 0) return false;
  return threads.every((thread) => {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    return classifySidebarThreadTriage(thread, snoozeNow, localLastVisitedAtById[key]).isDone;
  });
}

function computeFolderUrgencyRank(
  threads: readonly EnvironmentThreadShell[],
  snoozeNow: string,
  localLastVisitedAtById: Readonly<Record<string, string>>,
): number {
  if (threads.length === 0) return 0;
  let maxTier = 1;
  for (const thread of threads) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const { urgencyTier } = classifySidebarThreadTriage(
      thread,
      snoozeNow,
      localLastVisitedAtById[key],
    );
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
export function sortProjectFoldersByUrgency<
  TFolder extends {
    readonly group: Pick<SidebarProjectSnapshot, "isScratch" | "projectKey">;
    readonly threads: readonly EnvironmentThreadShell[];
  },
>(
  folders: readonly TFolder[],
  snoozeNow: string,
  localLastVisitedAtById: Readonly<Record<string, string>>,
): TFolder[] {
  return folders
    .map((folder, index) => {
      const rank = computeFolderUrgencyRank(folder.threads, snoozeNow, localLastVisitedAtById);
      const isUrgent = rank >= 3;
      const pinToBottom = folder.group.isScratch === true && !isUrgent;
      return { folder, index, rank, pinToBottom };
    })
    .toSorted((left, right) => {
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

export function buildScratchProjectKeySet(
  groups: readonly Pick<SidebarProjectSnapshot, "isScratch" | "memberProjectRefs">[],
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

export function isScratchThread(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
  scratchProjectKeys: ReadonlySet<string>,
): boolean {
  return scratchProjectKeys.has(`${thread.environmentId}:${thread.projectId}`);
}

export function countTriageBuckets(
  threads: readonly EnvironmentThreadShell[],
  scratchProjectKeys: ReadonlySet<string>,
  snoozeNow: string,
  localLastVisitedAtById: Readonly<Record<string, string>>,
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
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const triage = classifySidebarThreadTriage(thread, snoozeNow, localLastVisitedAtById[key]);
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

export function filterThreadsByTriage(
  threads: readonly EnvironmentThreadShell[],
  filter: SidebarTriageFilter,
  scratchProjectKeys: ReadonlySet<string>,
  snoozeNow: string,
  localLastVisitedAtById: Readonly<Record<string, string>>,
): readonly EnvironmentThreadShell[] {
  if (filter === "all") return threads;
  return threads.filter((thread) => {
    if (filter === "no-project") return isScratchThread(thread, scratchProjectKeys);
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const triage = classifySidebarThreadTriage(thread, snoozeNow, localLastVisitedAtById[key]);
    if (filter === "attention") return triage.isAttention;
    return triage.isDone;
  });
}

export interface SidebarStatusBucket {
  readonly key: SidebarStatusBucketKey;
  readonly threads: readonly EnvironmentThreadShell[];
}

export function groupThreadsByStatus(
  threads: readonly EnvironmentThreadShell[],
  snoozeNow: string,
  localLastVisitedAtById: Readonly<Record<string, string>>,
): SidebarStatusBucket[] {
  const attention: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const done: EnvironmentThreadShell[] = [];
  for (const thread of threads) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const triage = classifySidebarThreadTriage(thread, snoozeNow, localLastVisitedAtById[key]);
    if (triage.isAttention) {
      attention.push(thread);
    } else if (triage.isDone) {
      done.push(thread);
    } else {
      active.push(thread);
    }
  }
  const buckets: SidebarStatusBucket[] = [];
  if (attention.length > 0) buckets.push({ key: "attention", threads: attention });
  if (active.length > 0) buckets.push({ key: "active", threads: active });
  if (done.length > 0) buckets.push({ key: "done", threads: done });
  return buckets;
}

const SIDEBAR_FOLDER_DROP_PREFIX = "folder-drop:";

export function sidebarFolderDropId(projectKey: string): string {
  return `${SIDEBAR_FOLDER_DROP_PREFIX}${projectKey}`;
}

export function parseSidebarFolderDropProjectKey(droppableId: string): string | null {
  return droppableId.startsWith(SIDEBAR_FOLDER_DROP_PREFIX)
    ? droppableId.slice(SIDEBAR_FOLDER_DROP_PREFIX.length)
    : null;
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) {
    return true;
  }
  if (target.closest("[role='textbox'], [role='combobox'], [role='searchbox']")) {
    return true;
  }
  return false;
}
