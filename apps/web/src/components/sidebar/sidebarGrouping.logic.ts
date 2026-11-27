import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  buildScratchProjectKeySet,
  computeSidebarGroupRollupWith,
  countTriageBucketsWith,
  deriveSidebarThreadTriage,
  filterThreadsByTriageWith,
  groupShelfThreadsByProject as groupSharedShelfThreadsByProject,
  groupThreadsByStatusWith,
  isScratchThread,
  isSidebarGroupDoneOnlyWith,
  partitionSnoozeableFolderThreads,
  sidebarShelfFolderRowId,
  sidebarShelfFolderStateKey,
  sortProjectFoldersByUrgencyWith,
  type SidebarGroupRollup,
  type SidebarShelfKey,
  type SidebarShelfProjectGroup,
  type SidebarStatusBucket,
  type SidebarStatusBucketKey,
  type SidebarThreadTriage,
  type SidebarTriageFilter,
} from "@t3tools/client-runtime/state/sidebar-grouping";

import {
  hasUnseenCompletion,
  resolveSidebarRowStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarQueueGroupMode } from "../../uiStateStore";

export type {
  SidebarGroupRollup,
  SidebarShelfKey,
  SidebarShelfProjectGroup,
  SidebarStatusBucket,
  SidebarStatusBucketKey,
  SidebarThreadTriage,
  SidebarTriageFilter,
};
export {
  buildScratchProjectKeySet,
  isScratchThread,
  partitionSnoozeableFolderThreads,
  sidebarShelfFolderRowId,
  sidebarShelfFolderStateKey,
};

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
  return deriveSidebarThreadTriage({
    status: resolveSidebarRowStatus(effectiveThread),
    isWoke: threadWokeAt(thread, { now: snoozeNow }) !== null,
    hasUnseenCompletion: hasUnseenCompletion(effectiveThread),
  });
}

function makeThreadClassifier(
  snoozeNow: string,
  localLastVisitedAtById: Readonly<Record<string, string>>,
) {
  return (thread: EnvironmentThreadShell) => {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    return classifySidebarThreadTriage(thread, snoozeNow, localLastVisitedAtById[key]);
  };
}

export function computeSidebarGroupRollup(
  threads: readonly EnvironmentThreadShell[],
  snoozeNow: string,
  localLastVisitedAtById: Readonly<Record<string, string>>,
): SidebarGroupRollup {
  return computeSidebarGroupRollupWith(
    threads,
    makeThreadClassifier(snoozeNow, localLastVisitedAtById),
  );
}

export function isSidebarGroupDoneOnly(
  threads: readonly EnvironmentThreadShell[],
  snoozeNow: string,
  localLastVisitedAtById: Readonly<Record<string, string>>,
): boolean {
  return isSidebarGroupDoneOnlyWith(
    threads,
    makeThreadClassifier(snoozeNow, localLastVisitedAtById),
  );
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
  return sortProjectFoldersByUrgencyWith(
    folders,
    makeThreadClassifier(snoozeNow, localLastVisitedAtById),
    (folder) => folder.group.isScratch === true,
  );
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
  return countTriageBucketsWith(
    threads,
    scratchProjectKeys,
    makeThreadClassifier(snoozeNow, localLastVisitedAtById),
  );
}

export function filterThreadsByTriage(
  threads: readonly EnvironmentThreadShell[],
  filter: SidebarTriageFilter,
  scratchProjectKeys: ReadonlySet<string>,
  snoozeNow: string,
  localLastVisitedAtById: Readonly<Record<string, string>>,
): readonly EnvironmentThreadShell[] {
  return filterThreadsByTriageWith(
    threads,
    filter,
    scratchProjectKeys,
    makeThreadClassifier(snoozeNow, localLastVisitedAtById),
  );
}

export function groupThreadsByStatus(
  threads: readonly EnvironmentThreadShell[],
  snoozeNow: string,
  localLastVisitedAtById: Readonly<Record<string, string>>,
): SidebarStatusBucket[] {
  return groupThreadsByStatusWith(threads, makeThreadClassifier(snoozeNow, localLastVisitedAtById));
}

/**
 * Groups a shelf's threads by project folder, ordered by first appearance in `threads`.
 * Threads whose project is not in `groups` stay in `ungroupedThreads`.
 */
export function groupShelfThreadsByProject<
  TGroup extends Pick<SidebarProjectSnapshot, "projectKey" | "memberProjectRefs">,
  TThread extends Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
>(
  groups: readonly TGroup[],
  threads: readonly TThread[],
): {
  readonly folders: Array<SidebarShelfProjectGroup<TGroup, TThread>>;
  readonly ungroupedThreads: TThread[];
} {
  return groupSharedShelfThreadsByProject(groups, threads, (group) => group.projectKey);
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
