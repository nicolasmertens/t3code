import { useAtomValue } from "@effect/atom-react";
import {
  resolveRemoteSidebarQueuePreferencesUpdate,
  sidebarShelfFolderStateKey,
  type SidebarShelfKey,
  type SidebarStatusBucketKey,
  type SidebarTriageFilter,
} from "@t3tools/client-runtime/state/sidebar-grouping";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import {
  AuthSettingsWriteScope,
  type SidebarQueueGroupMode,
  type SidebarQueuePreferences,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import type * as MobilePreferences from "../../persistence/mobile-preferences";
import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

export const DEFAULT_MOBILE_THREAD_LIST_GROUP_MODE: SidebarQueueGroupMode = "project";

export interface ResolvedMobileGroupingPreferences {
  readonly loaded: boolean;
  readonly groupMode: SidebarQueueGroupMode;
  readonly urgencyOrder: boolean;
  readonly autoCollapseDone: boolean;
  readonly multilineRows: boolean;
  readonly workingShelfEnabled: boolean;
  readonly collapsedProjectGroups: ReadonlySet<string>;
  readonly collapsedStatusGroups: ReadonlySet<string>;
  readonly collapsedShelfProjectGroups: ReadonlySet<string>;
}

/** Resolves mobile thread-list grouping preferences with mobile-first defaults. */
export function resolveMobileGroupingPreferences(
  preferences: MobilePreferences.Preferences | undefined,
  loaded = true,
): ResolvedMobileGroupingPreferences {
  return {
    loaded,
    groupMode: preferences?.threadListGroupMode ?? DEFAULT_MOBILE_THREAD_LIST_GROUP_MODE,
    urgencyOrder: preferences?.threadListUrgencyOrder !== false,
    autoCollapseDone: preferences?.threadListAutoCollapseDone === true,
    multilineRows: preferences?.threadListMultilineRows === true,
    workingShelfEnabled: preferences?.workingShelfEnabled !== false,
    collapsedProjectGroups: new Set(preferences?.collapsedProjectGroups ?? []),
    collapsedStatusGroups: new Set(preferences?.collapsedStatusGroups ?? []),
    collapsedShelfProjectGroups: new Set(preferences?.collapsedShelfProjectGroups ?? []),
  };
}

/**
 * Computes a local mobile preference patch from connected servers' `sidebarQueuePreferences`
 * when a remote snapshot has a strictly newer `updatedAt` timestamp than the last sync.
 */
export function planInboundMobileQueuePreferencesPatch(
  candidates: Iterable<SidebarQueuePreferences | null | undefined>,
  preferences: MobilePreferences.Preferences | undefined,
): Partial<MobilePreferences.Preferences> | null {
  const remote = resolveRemoteSidebarQueuePreferencesUpdate(
    candidates,
    preferences?.sidebarQueuePreferencesSyncedAt,
  );
  if (remote === null) return null;
  const { preferences: next, updatedAt } = remote;
  return {
    sidebarQueuePreferencesSyncedAt: updatedAt,
    ...(next.groupMode !== undefined
      ? { threadListGroupMode: next.groupMode ?? DEFAULT_MOBILE_THREAD_LIST_GROUP_MODE }
      : {}),
    ...(next.urgencyOrder !== undefined ? { threadListUrgencyOrder: next.urgencyOrder } : {}),
    ...(next.autoCollapseDone !== undefined
      ? { threadListAutoCollapseDone: next.autoCollapseDone }
      : {}),
    ...(next.workingShelfEnabled !== undefined
      ? { workingShelfEnabled: next.workingShelfEnabled }
      : {}),
  };
}

function toggleListEntry(entries: readonly string[] | undefined, key: string): string[] {
  const next = new Set(entries ?? []);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return [...next];
}

function mergeCollapsedEntries(
  entries: readonly string[] | undefined,
  keysToUpdate: ReadonlyArray<string>,
  collapsed: boolean,
): string[] {
  const next = new Set(entries ?? []);
  for (const key of keysToUpdate) {
    if (collapsed) next.add(key);
    else next.delete(key);
  }
  return [...next];
}

export function useThreadListV2GroupingPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const updateServerSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "mobile sidebar queue preferences",
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const preferences = loaded ? preferencesResult.value : undefined;
  const resolved = resolveMobileGroupingPreferences(preferences, loaded);

  const inboundPatch = loaded
    ? planInboundMobileQueuePreferencesPatch(
        environments.map((env) => env.serverConfig?.settings.sidebarQueuePreferences),
        preferences,
      )
    : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies cross-device sidebar queue preferences from connected server settings
  useEffect(() => {
    if (inboundPatch === null) return;
    void savePreferences(inboundPatch);
  }, [inboundPatch, savePreferences]);

  const publishSynced = (next: {
    readonly groupMode?: SidebarQueueGroupMode;
    readonly urgencyOrder?: boolean;
    readonly autoCollapseDone?: boolean;
    readonly workingShelfEnabled?: boolean;
  }) => {
    if (!loaded) return;
    const updatedAt = new Date().toISOString();
    const snapshot: SidebarQueuePreferences = { ...next, updatedAt };
    void savePreferences({
      sidebarQueuePreferencesSyncedAt: updatedAt,
      ...(next.groupMode !== undefined ? { threadListGroupMode: next.groupMode } : {}),
      ...(next.urgencyOrder !== undefined ? { threadListUrgencyOrder: next.urgencyOrder } : {}),
      ...(next.autoCollapseDone !== undefined
        ? { threadListAutoCollapseDone: next.autoCollapseDone }
        : {}),
      ...(next.workingShelfEnabled !== undefined
        ? { workingShelfEnabled: next.workingShelfEnabled }
        : {}),
    });
    for (const environment of environments) {
      if (!supportsSharedSettingsSync(environment)) continue;
      if (!readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope)) continue;
      void updateServerSettings({
        environmentId: environment.environmentId,
        input: { patch: { sidebarQueuePreferences: snapshot } },
      });
    }
  };

  const setGroupMode = (groupMode: SidebarQueueGroupMode) => publishSynced({ groupMode });
  const setUrgencyOrder = (urgencyOrder: boolean) => publishSynced({ urgencyOrder });
  const setAutoCollapseDone = (autoCollapseDone: boolean) => publishSynced({ autoCollapseDone });
  const setWorkingShelfEnabled = (workingShelfEnabled: boolean) =>
    publishSynced({ workingShelfEnabled });
  const setMultilineRows = (multilineRows: boolean) => {
    if (!loaded) return;
    void savePreferences({ threadListMultilineRows: multilineRows });
  };

  const toggleProjectFolder = (projectKey: string) => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => ({
        collapsedProjectGroups: toggleListEntry(current.collapsedProjectGroups, projectKey),
      }),
    });
  };
  const setProjectFolderCollapsed = (projectKey: string, collapsed: boolean) => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => ({
        collapsedProjectGroups: mergeCollapsedEntries(
          current.collapsedProjectGroups,
          [projectKey],
          collapsed,
        ),
      }),
    });
  };
  const setCollapsedProjectGroups = (keys: ReadonlyArray<string>, collapsed: boolean) => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => ({
        collapsedProjectGroups: mergeCollapsedEntries(
          current.collapsedProjectGroups,
          keys,
          collapsed,
        ),
      }),
    });
  };
  const setProjectFoldersCollapsedByDone = (
    folders: ReadonlyArray<{ readonly projectKey: string; readonly doneOnly: boolean }>,
  ) => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => {
        const next = new Set(current.collapsedProjectGroups ?? []);
        for (const folder of folders) {
          if (folder.doneOnly) next.add(folder.projectKey);
          else next.delete(folder.projectKey);
        }
        return { collapsedProjectGroups: [...next] };
      },
    });
  };

  const toggleStatusGroup = (bucketKey: SidebarStatusBucketKey) => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => ({
        collapsedStatusGroups: toggleListEntry(current.collapsedStatusGroups, bucketKey),
      }),
    });
  };
  const setStatusGroupCollapsed = (bucketKey: SidebarStatusBucketKey, collapsed: boolean) => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => ({
        collapsedStatusGroups: mergeCollapsedEntries(
          current.collapsedStatusGroups,
          [bucketKey],
          collapsed,
        ),
      }),
    });
  };
  const setCollapsedStatusGroups = (
    keys: ReadonlyArray<SidebarStatusBucketKey>,
    collapsed: boolean,
  ) => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => ({
        collapsedStatusGroups: mergeCollapsedEntries(
          current.collapsedStatusGroups,
          keys,
          collapsed,
        ),
      }),
    });
  };
  const setStatusGroupsCollapsedByDone = (
    buckets: ReadonlyArray<{
      readonly bucketKey: SidebarStatusBucketKey;
      readonly doneOnly: boolean;
    }>,
  ) => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => {
        const next = new Set(current.collapsedStatusGroups ?? []);
        for (const bucket of buckets) {
          if (bucket.doneOnly) next.add(bucket.bucketKey);
          else next.delete(bucket.bucketKey);
        }
        return { collapsedStatusGroups: [...next] };
      },
    });
  };

  const toggleShelfProjectFolder = (shelf: SidebarShelfKey, projectKey: string) => {
    if (!loaded) return;
    const stateKey = sidebarShelfFolderStateKey(shelf, projectKey);
    void savePreferences({
      transform: (current) => ({
        collapsedShelfProjectGroups: toggleListEntry(current.collapsedShelfProjectGroups, stateKey),
      }),
    });
  };
  const setCollapsedShelfProjectGroups = (keys: ReadonlyArray<string>, collapsed: boolean) => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => ({
        collapsedShelfProjectGroups: mergeCollapsedEntries(
          current.collapsedShelfProjectGroups,
          keys,
          collapsed,
        ),
      }),
    });
  };

  const clearAllCollapsedGroups = () => {
    if (!loaded) return;
    void savePreferences({
      collapsedProjectGroups: [],
      collapsedStatusGroups: [],
      collapsedShelfProjectGroups: [],
    });
  };

  return {
    ...resolved,
    setGroupMode,
    setUrgencyOrder,
    setAutoCollapseDone,
    setMultilineRows,
    setWorkingShelfEnabled,
    toggleProjectFolder,
    setProjectFolderCollapsed,
    setCollapsedProjectGroups,
    setProjectFoldersCollapsedByDone,
    toggleStatusGroup,
    setStatusGroupCollapsed,
    setCollapsedStatusGroups,
    setStatusGroupsCollapsedByDone,
    toggleShelfProjectFolder,
    setCollapsedShelfProjectGroups,
    clearAllCollapsedGroups,
  } as const;
}

export type ThreadListV2GroupingPreferencesController = ReturnType<
  typeof useThreadListV2GroupingPreferences
>;

export function buildQueueGroupingHandlers(input: {
  readonly grouping: ThreadListV2GroupingPreferencesController;
  readonly setTriageFilter: (filter: SidebarTriageFilter) => void;
  readonly autoCollapseOpenedKeys: ReadonlySet<string>;
  readonly setAutoCollapseOpenedKeys: (keys: ReadonlySet<string>) => void;
  readonly projectFolderSummary: ReadonlyArray<{
    readonly projectKey: string;
    readonly doneOnly: boolean;
  }>;
  readonly statusGroupSummary: ReadonlyArray<{
    readonly bucketKey: SidebarStatusBucketKey;
    readonly doneOnly: boolean;
  }>;
  readonly shelfFolderKeys: ReadonlyArray<string>;
}) {
  const { grouping } = input;
  const hasDoneOnlyGroups =
    grouping.groupMode === "project"
      ? input.projectFolderSummary.some((folder) => folder.doneOnly)
      : grouping.groupMode === "status"
        ? input.statusGroupSummary.some((bucket) => bucket.doneOnly)
        : false;

  const toggleProjectFolder = (projectKey: string, doneOnly: boolean, collapsed: boolean) => {
    if (grouping.autoCollapseDone && doneOnly) {
      const next = new Set(input.autoCollapseOpenedKeys);
      if (collapsed) next.add(projectKey);
      else next.delete(projectKey);
      input.setAutoCollapseOpenedKeys(next);
      if (grouping.collapsedProjectGroups.has(projectKey)) {
        grouping.setProjectFolderCollapsed(projectKey, false);
      }
      return;
    }
    grouping.toggleProjectFolder(projectKey);
  };

  const toggleStatusGroup = (
    bucketKey: SidebarStatusBucketKey,
    doneOnly: boolean,
    collapsed: boolean,
  ) => {
    if (grouping.autoCollapseDone && doneOnly) {
      const next = new Set(input.autoCollapseOpenedKeys);
      if (collapsed) next.add(bucketKey);
      else next.delete(bucketKey);
      input.setAutoCollapseOpenedKeys(next);
      if (grouping.collapsedStatusGroups.has(bucketKey)) {
        grouping.setStatusGroupCollapsed(bucketKey, false);
      }
      return;
    }
    grouping.toggleStatusGroup(bucketKey);
  };

  const groupingMenuOptions = {
    groupMode: grouping.groupMode,
    urgencyOrder: grouping.urgencyOrder,
    autoCollapseDone: grouping.autoCollapseDone,
    multilineRows: grouping.multilineRows,
    workingShelfEnabled: grouping.workingShelfEnabled,
    hasDoneOnlyGroups,
    onGroupModeChange: (mode: SidebarQueueGroupMode) => {
      grouping.setGroupMode(mode);
      if (mode === "flat") input.setTriageFilter("all");
    },
    onUrgencyOrderChange: grouping.setUrgencyOrder,
    onAutoCollapseDoneChange: (enabled: boolean) => {
      grouping.setAutoCollapseDone(enabled);
      if (enabled) input.setAutoCollapseOpenedKeys(new Set());
    },
    onMultilineRowsChange: grouping.setMultilineRows,
    onWorkingShelfEnabledChange: grouping.setWorkingShelfEnabled,
    onExpandAllGroups: () => {
      if (grouping.groupMode === "project") {
        grouping.setCollapsedProjectGroups(
          input.projectFolderSummary.map((folder) => folder.projectKey),
          false,
        );
        grouping.setCollapsedShelfProjectGroups(input.shelfFolderKeys, false);
        if (grouping.autoCollapseDone) {
          input.setAutoCollapseOpenedKeys(
            new Set(
              input.projectFolderSummary
                .filter((folder) => folder.doneOnly)
                .map((folder) => folder.projectKey),
            ),
          );
        }
      } else if (grouping.groupMode === "status") {
        grouping.setCollapsedStatusGroups(
          input.statusGroupSummary.map((bucket) => bucket.bucketKey),
          false,
        );
        if (grouping.autoCollapseDone) {
          input.setAutoCollapseOpenedKeys(
            new Set(
              input.statusGroupSummary
                .filter((bucket) => bucket.doneOnly)
                .map((bucket) => bucket.bucketKey),
            ),
          );
        }
      }
    },
    onCollapseDoneGroups: () => {
      if (grouping.groupMode === "project") {
        grouping.setProjectFoldersCollapsedByDone(input.projectFolderSummary);
        if (grouping.autoCollapseDone) input.setAutoCollapseOpenedKeys(new Set());
      } else if (grouping.groupMode === "status") {
        grouping.setStatusGroupsCollapsedByDone(input.statusGroupSummary);
        if (grouping.autoCollapseDone) input.setAutoCollapseOpenedKeys(new Set());
      }
    },
    onCollapseAllGroups: () => {
      if (grouping.groupMode === "project") {
        grouping.setCollapsedProjectGroups(
          input.projectFolderSummary.map((folder) => folder.projectKey),
          true,
        );
        grouping.setCollapsedShelfProjectGroups(input.shelfFolderKeys, true);
        input.setAutoCollapseOpenedKeys(new Set());
      } else if (grouping.groupMode === "status") {
        grouping.setCollapsedStatusGroups(
          input.statusGroupSummary.map((bucket) => bucket.bucketKey),
          true,
        );
        input.setAutoCollapseOpenedKeys(new Set());
      }
    },
  };

  return {
    toggleProjectFolder,
    toggleStatusGroup,
    groupingMenuOptions,
  } as const;
}
