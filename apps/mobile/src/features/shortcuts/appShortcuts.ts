import type { Action } from "expo-quick-actions";
import { msg } from "gt-react-native";
import type { NavigationState } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  effectiveSnoozed,
  threadRaisedHandWhileSnoozed,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  EnvironmentId,
  isListedThreadLineage,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { m } from "../../i18n/messages";
import { scopedProjectKey } from "../../lib/scopedEntities";
import type { RecentThreadShortcut } from "../../persistence/imperative";
import { resolveThreadListV2Status } from "../threads/threadListV2";

const MAX_RECENT_THREAD_SHORTCUTS = 3;

const NEW_TASK_SHORTCUT_ID = "new-task";
const NEW_TASK_SHORTCUT_HREF = "/new";

export const QUICK_SCRATCH_SHORTCUT_ID = "quick-scratch";
export const QUICK_SCRATCH_SHORTCUT_HREF = "/new/scratch";
export const TALK_TO_FLEET_SHORTCUT_ID = "talk-to-fleet";
export const TALK_TO_FLEET_SHORTCUT_HREF = "/talk-to-fleet";
export const MAX_IOS_SHORTCUTS = 4;

const SHORTCUT_ICON = "shortcut_icon";

const THREAD_SHORTCUT_HREF_PATTERN = /^\/threads\/[^/?#]+\/[^/?#]+$/;

export type AttentionShortcutKind = "approval" | "input" | "request" | "failed" | "limited";

export interface ThreadShortcutCandidate {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly attentionKind: AttentionShortcutKind | null;
}

export interface FeatureShortcutDefinition {
  readonly id: string;
  readonly title: () => string;
  readonly subtitle?: () => string | undefined;
  readonly icon: Action["icon"];
  readonly href: string;
}

/**
 * Extension point for top-level feature Quick Actions (e.g. Discuss emails, Talk to Fleet).
 * Slot budgeting reserves Slot 1 for Quick task and at least 1 slot for Top attention needed.
 */
export const IOS_FEATURE_SHORTCUTS: ReadonlyArray<FeatureShortcutDefinition> = [
  {
    id: TALK_TO_FLEET_SHORTCUT_ID,
    title: () => m(msg("Talk to Fleet")),
    subtitle: () => m(msg("Live voice")),
    icon: "symbol:waveform",
    href: TALK_TO_FLEET_SHORTCUT_HREF,
  },
];

function threadShortcutKey(environmentId: string, threadId: string): string {
  return `${environmentId}\0${threadId}`;
}

function threadShortcutHref(
  thread: Pick<RecentThreadShortcut, "environmentId" | "threadId">,
): string {
  return `/threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`;
}

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

/** Never throw: malformed deep-link or restored ids can fail schema constructors during root-stack render. */
export function activeThreadRef(state: NavigationState): ScopedThreadRef | null {
  const route = state.routes[state.index];
  if (route?.name !== "Thread") {
    return null;
  }

  try {
    const params = route.params as
      | {
          readonly environmentId?: string | string[];
          readonly threadId?: string | string[];
        }
      | undefined;
    const environmentId = firstRouteParam(params?.environmentId)?.trim();
    const threadId = firstRouteParam(params?.threadId)?.trim();
    if (!environmentId || !threadId) {
      return null;
    }

    return {
      environmentId: EnvironmentId.make(environmentId),
      threadId: ThreadId.make(threadId),
    };
  } catch {
    return null;
  }
}

function threadShortcutLabel(thread: Pick<RecentThreadShortcut, "title">): string {
  const title = thread.title.trim();
  return title.length > 0
    ? title
    : m(msg("Thread", { $context: "fallback name for an untitled thread" }));
}

/** Launcher shortcuts survive updates; allowlist destinations so malformed or stale paths cannot navigate. */
export function shortcutHref(action: Action): string | null {
  const href = action.params?.href;
  if (typeof href !== "string") {
    return null;
  }

  return href === NEW_TASK_SHORTCUT_HREF ||
    href === QUICK_SCRATCH_SHORTCUT_HREF ||
    THREAD_SHORTCUT_HREF_PATTERN.test(href) ||
    IOS_FEATURE_SHORTCUTS.some((feature) => feature.href === href)
    ? href
    : null;
}

export function withRecentThreadShortcut(
  current: ReadonlyArray<RecentThreadShortcut>,
  opened: RecentThreadShortcut,
): ReadonlyArray<RecentThreadShortcut> {
  const existing = current.find(
    (thread) =>
      thread.environmentId === opened.environmentId && thread.threadId === opened.threadId,
  );
  const title = opened.title.trim().length > 0 ? opened.title : (existing?.title ?? opened.title);
  if (current[0] === existing && existing !== undefined && existing.title === title) {
    return current;
  }

  return [
    { environmentId: opened.environmentId, threadId: opened.threadId, title },
    ...current.filter((thread) => thread !== existing),
  ].slice(0, MAX_RECENT_THREAD_SHORTCUTS);
}

export function buildShortcutActions(recents: ReadonlyArray<RecentThreadShortcut>): Action[] {
  return [
    {
      id: NEW_TASK_SHORTCUT_ID,
      title: m(msg("New task")),
      icon: SHORTCUT_ICON,
      params: { href: NEW_TASK_SHORTCUT_HREF },
    },
    ...recents.slice(0, MAX_RECENT_THREAD_SHORTCUTS).map((thread): Action => ({
      // URI-encoded hrefs avoid env/thread id collisions that plain hyphen joins allow.
      id: `thread:${threadShortcutHref(thread)}`,
      title: threadShortcutLabel(thread),
      icon: SHORTCUT_ICON,
      params: { href: threadShortcutHref(thread) },
    })),
  ];
}

function attentionRankForThread(
  thread: EnvironmentThreadShell,
  nowIso: string,
): { readonly kind: AttentionShortcutKind; readonly rank: number } | null {
  const status = resolveThreadListV2Status(thread);
  const snoozed = effectiveSnoozed(thread, { now: nowIso });
  const raisedHand = threadRaisedHandWhileSnoozed(thread);
  const settled = thread.settledOverride === "settled" || thread.settledAt !== null;

  switch (status) {
    case "approval":
      return { kind: "approval", rank: 0 };
    case "input":
      return snoozed && !raisedHand ? null : { kind: "input", rank: 1 };
    case "request":
      return snoozed && !raisedHand ? null : { kind: "request", rank: 2 };
    case "failed":
      return !settled && (!snoozed || raisedHand) ? { kind: "failed", rank: 3 } : null;
    case "limited":
      return !settled && (!snoozed || raisedHand) ? { kind: "limited", rank: 4 } : null;
    case "working":
    case "waiting":
    case "ready":
      return null;
  }
}

function attentionActivityTimestamp(thread: EnvironmentThreadShell): string {
  return thread.pendingUserInputAt ?? thread.runtime?.updatedAt ?? thread.updatedAt;
}

export function selectIosShortcutThreads(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectTitleByKey: ReadonlyMap<string, string>;
  readonly recents: ReadonlyArray<RecentThreadShortcut>;
  readonly savedEnvironmentIds?: ReadonlySet<string> | null;
  readonly nowIso: string;
  readonly maxCount: number;
}): ThreadShortcutCandidate[] {
  if (input.maxCount <= 0) {
    return [];
  }

  const ineligibleKeys = new Set<string>();
  const eligibleThreads: EnvironmentThreadShell[] = [];
  const eligibleByKey = new Map<string, EnvironmentThreadShell>();

  for (const thread of input.threads) {
    const key = threadShortcutKey(thread.environmentId, thread.id);
    if (
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      !isListedThreadLineage(thread.lineage)
    ) {
      ineligibleKeys.add(key);
      continue;
    }
    if (input.savedEnvironmentIds != null && !input.savedEnvironmentIds.has(thread.environmentId)) {
      continue;
    }
    eligibleThreads.push(thread);
    eligibleByKey.set(key, thread);
  }

  const projectTitleFor = (thread: EnvironmentThreadShell): string | null => {
    const title = input.projectTitleByKey
      .get(scopedProjectKey(thread.environmentId, thread.projectId))
      ?.trim();
    return title && title.length > 0 ? title : null;
  };

  const attentionEntries = eligibleThreads
    .flatMap((thread) => {
      const attention = attentionRankForThread(thread, input.nowIso);
      if (attention === null) return [];
      return [
        {
          thread,
          kind: attention.kind,
          rank: attention.rank,
          activityTimestamp: attentionActivityTimestamp(thread),
        },
      ];
    })
    .sort(
      (left, right) =>
        left.rank - right.rank || right.activityTimestamp.localeCompare(left.activityTimestamp),
    );

  const selected: ThreadShortcutCandidate[] = [];
  const seen = new Set<string>();

  for (const entry of attentionEntries) {
    if (selected.length >= input.maxCount) return selected;
    const key = threadShortcutKey(entry.thread.environmentId, entry.thread.id);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({
      environmentId: entry.thread.environmentId,
      threadId: entry.thread.id,
      title: entry.thread.title,
      projectTitle: projectTitleFor(entry.thread),
      attentionKind: entry.kind,
    });
  }

  for (const recent of input.recents) {
    if (selected.length >= input.maxCount) return selected;
    if (input.savedEnvironmentIds != null && !input.savedEnvironmentIds.has(recent.environmentId)) {
      continue;
    }
    const key = threadShortcutKey(recent.environmentId, recent.threadId);
    if (seen.has(key) || ineligibleKeys.has(key)) continue;
    seen.add(key);
    const live = eligibleByKey.get(key);
    selected.push({
      environmentId: recent.environmentId,
      threadId: recent.threadId,
      title: live && live.title.trim().length > 0 ? live.title : recent.title,
      projectTitle: live ? projectTitleFor(live) : null,
      attentionKind: null,
    });
  }

  const activeFallbacks = eligibleThreads
    .filter(
      (thread) =>
        !seen.has(threadShortcutKey(thread.environmentId, thread.id)) &&
        thread.settledOverride !== "settled" &&
        thread.settledAt === null &&
        !effectiveSnoozed(thread, { now: input.nowIso }),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  for (const thread of activeFallbacks) {
    if (selected.length >= input.maxCount) return selected;
    const key = threadShortcutKey(thread.environmentId, thread.id);
    seen.add(key);
    selected.push({
      environmentId: thread.environmentId,
      threadId: thread.id,
      title: thread.title,
      projectTitle: projectTitleFor(thread),
      attentionKind: null,
    });
  }

  return selected;
}

function attentionPresentation(kind: AttentionShortcutKind): {
  readonly label: string;
  readonly icon: Action["icon"];
} {
  switch (kind) {
    case "approval":
      return { label: m(msg("Needs approval")), icon: "symbol:checkmark.shield.fill" };
    case "input":
    case "request":
      return { label: m(msg("Needs input")), icon: "symbol:exclamationmark.bubble.fill" };
    case "failed":
      return {
        label: m(msg("Failed", { $context: "agent work status" })),
        icon: "symbol:exclamationmark.triangle.fill",
      };
    case "limited":
      return { label: m(msg("Rate limited")), icon: "symbol:exclamationmark.triangle.fill" };
  }
}

export function buildIosShortcutActions(input: {
  readonly threads: ReadonlyArray<ThreadShortcutCandidate>;
  readonly featureShortcuts?: ReadonlyArray<FeatureShortcutDefinition>;
}): Action[] {
  const quickScratchAction: Action = {
    id: QUICK_SCRATCH_SHORTCUT_ID,
    title: m(msg("Quick task")),
    subtitle: m(msg("No project")),
    icon: "symbol:square.and.pencil",
    params: { href: QUICK_SCRATCH_SHORTCUT_HREF },
  };

  const featureSlotLimit = Math.max(0, MAX_IOS_SHORTCUTS - 2);
  const featureActions = (input.featureShortcuts ?? IOS_FEATURE_SHORTCUTS)
    .slice(0, featureSlotLimit)
    .map((feature): Action => {
      const subtitle = feature.subtitle?.();
      return {
        id: feature.id,
        title: feature.title(),
        ...(subtitle ? { subtitle } : {}),
        icon: feature.icon,
        params: { href: feature.href },
      };
    });

  const remainingSlots = Math.max(0, MAX_IOS_SHORTCUTS - 1 - featureActions.length);
  const threadActions = input.threads.slice(0, remainingSlots).map((candidate): Action => {
    const href = threadShortcutHref(candidate);
    const project = candidate.projectTitle?.trim();
    if (candidate.attentionKind !== null) {
      const attention = attentionPresentation(candidate.attentionKind);
      return {
        id: `thread:${href}`,
        title: threadShortcutLabel(candidate),
        subtitle: project ? `${attention.label} · ${project}` : attention.label,
        icon: attention.icon,
        params: { href },
      };
    }

    return {
      id: `thread:${href}`,
      title: threadShortcutLabel(candidate),
      subtitle: project || m(msg("Recent thread")),
      icon: "symbol:bubble.left.and.text.bubble.right",
      params: { href },
    };
  });

  return [quickScratchAction, ...featureActions, ...threadActions];
}

export function areShortcutActionsEqual(
  left: ReadonlyArray<Action> | null,
  right: ReadonlyArray<Action>,
): boolean {
  if (left === null || left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.id !== b.id ||
      a.title !== b.title ||
      (a.subtitle ?? null) !== (b.subtitle ?? null) ||
      (a.icon ?? null) !== (b.icon ?? null) ||
      (a.params?.href ?? null) !== (b.params?.href ?? null)
    ) {
      return false;
    }
  }

  return true;
}
