import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentShell, environmentShellSummaryAtom } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import {
  extractAgentNotificationDeepLink,
  extractNotificationPayloadData,
  threadDeepLinkOnScreen,
} from "./notificationPayload";

export interface PresentedAgentNotification {
  readonly date?: number | undefined;
  readonly request: {
    readonly identifier: string;
    readonly content?: {
      readonly data?: unknown;
      readonly threadIdentifier?: string | null;
    } | null;
  };
}

export type DismissCheckThreadShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "archivedAt"
  | "settledOverride"
  | "settledAt"
  | "snoozedAt"
  | "snoozedUntil"
  | "lastVisitedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "runtime"
  | "latestRun"
>;

const RECONCILE_DEBOUNCE_MS = 250;
const TIMESTAMP_SKEW_TOLERANCE_MS = 1_000;

let openThreadDeepLink: string | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let reconcileInFlight: Promise<void> | null = null;
let reconcileQueued = false;

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeNotificationDateMs(date: number | undefined): number | null {
  if (typeof date !== "number" || !Number.isFinite(date) || date <= 0) {
    return null;
  }
  // Expo iOS exposes `date` in Unix seconds, while some platforms/tests use milliseconds.
  return date < 1_000_000_000_000 ? date * 1_000 : date;
}

function decodeThreadRefFromDeepLink(
  deepLink: string | null,
): { readonly environmentId: string; readonly threadId: string } | null {
  if (deepLink === null) {
    return null;
  }
  const match = /^\/threads\/([^/]+)\/([^/]+)(?:\/|$)/.exec(deepLink);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  try {
    return {
      environmentId: decodeURIComponent(match[1]),
      threadId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

function parseThreadRefFromThreadIdentifier(
  threadIdentifier: string | null | undefined,
): { readonly environmentId: string; readonly threadId: string } | null {
  if (typeof threadIdentifier !== "string") {
    return null;
  }
  const slashIndex = threadIdentifier.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= threadIdentifier.length - 1) {
    return null;
  }
  const environmentId = threadIdentifier.slice(0, slashIndex);
  const threadId = threadIdentifier.slice(slashIndex + 1);
  if (threadId.includes("/")) {
    return null;
  }
  return { environmentId, threadId };
}

function shouldDismissForShellState(input: {
  readonly shell: DismissCheckThreadShell;
  readonly phase: string | null;
  readonly hasExactUpdatedAt: boolean;
  readonly notifiedAtMs: number | null;
  readonly nowMs: number;
}): boolean {
  const { shell, phase, hasExactUpdatedAt, notifiedAtMs, nowMs } = input;
  if (shell.archivedAt !== null) {
    return true;
  }
  if (shell.settledOverride === "settled") {
    return true;
  }
  const settledMs = parseTimestampMs(shell.settledAt);
  if (
    settledMs !== null &&
    (notifiedAtMs === null || settledMs >= notifiedAtMs - TIMESTAMP_SKEW_TOLERANCE_MS)
  ) {
    return true;
  }
  if (effectiveSnoozed(shell, { now: new Date(nowMs).toISOString() })) {
    return true;
  }
  const snoozedAtMs = parseTimestampMs(shell.snoozedAt);
  if (snoozedAtMs !== null && notifiedAtMs !== null) {
    if (snoozedAtMs >= notifiedAtMs - TIMESTAMP_SKEW_TOLERANCE_MS) {
      return true;
    }
    const snoozedUntilMs = parseTimestampMs(shell.snoozedUntil);
    if (snoozedUntilMs !== null && notifiedAtMs >= snoozedAtMs && notifiedAtMs <= snoozedUntilMs) {
      return true;
    }
  }

  const hasApproval = shell.hasPendingApprovals || shell.pendingSubagentRequest === "approval";
  const hasInput = shell.hasPendingUserInput || shell.pendingSubagentRequest === "user_input";
  if (phase === "waiting_for_approval" && !hasApproval) {
    return true;
  }
  if (phase === "waiting_for_input" && !hasInput) {
    return true;
  }

  const runtimeStatus = shell.runtime?.status ?? null;
  if (
    !hasApproval &&
    !hasInput &&
    (runtimeStatus === "preparing" ||
      runtimeStatus === "starting" ||
      runtimeStatus === "running" ||
      runtimeStatus === "interrupted" ||
      runtimeStatus === "cancelled" ||
      runtimeStatus === "rolled_back")
  ) {
    return true;
  }

  const lastVisitedMs = parseTimestampMs(shell.lastVisitedAt);
  if (lastVisitedMs !== null) {
    const completedAtMs = parseTimestampMs(shell.latestRun?.completedAt);
    const isAttentionPhase = phase === "waiting_for_approval" || phase === "waiting_for_input";
    let compareMs: number | null;
    if (isAttentionPhase) {
      compareMs = notifiedAtMs;
    } else if (completedAtMs !== null && notifiedAtMs !== null) {
      // APNs delivery or metadata updates can land slightly after run completion; if the user
      // visited after either the run completed or the notification timestamp, it is already read.
      compareMs = Math.min(completedAtMs, notifiedAtMs);
    } else if (hasExactUpdatedAt) {
      compareMs = notifiedAtMs;
    } else {
      compareMs = completedAtMs ?? notifiedAtMs;
    }
    if (compareMs !== null && lastVisitedMs >= compareMs - TIMESTAMP_SKEW_TOLERANCE_MS) {
      return true;
    }
  }

  return false;
}

export function deliveredNotificationIdentifiersToDismiss(input: {
  readonly deliveredNotifications: ReadonlyArray<PresentedAgentNotification>;
  readonly openDeepLink: string | null;
  readonly threadShellsByKey: ReadonlyMap<string, DismissCheckThreadShell>;
  readonly liveEnvironmentIds?: ReadonlySet<string>;
  readonly nowMs: number;
}): ReadonlyArray<string> {
  const identifiers: string[] = [];
  for (const notification of input.deliveredNotifications) {
    const identifier = notification.request.identifier;
    if (!identifier) {
      continue;
    }
    const deepLink = extractAgentNotificationDeepLink({ notification });
    if (input.openDeepLink !== null && deepLink !== null && deepLink === input.openDeepLink) {
      identifiers.push(identifier);
      continue;
    }

    const data = extractNotificationPayloadData(notification);
    const decoded = decodeThreadRefFromDeepLink(deepLink ?? threadDeepLinkOnScreen(deepLink ?? ""));
    const fromThreadIdentifier = parseThreadRefFromThreadIdentifier(
      notification.request.content?.threadIdentifier,
    );
    const environmentId =
      typeof data?.environmentId === "string" && data.environmentId.length > 0
        ? data.environmentId
        : (decoded?.environmentId ?? fromThreadIdentifier?.environmentId ?? null);
    const threadId =
      typeof data?.threadId === "string" && data.threadId.length > 0
        ? data.threadId
        : (decoded?.threadId ?? fromThreadIdentifier?.threadId ?? null);
    if (!environmentId || !threadId) {
      continue;
    }

    if (
      input.openDeepLink !== null &&
      `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}` ===
        input.openDeepLink
    ) {
      identifiers.push(identifier);
      continue;
    }

    const shell = input.threadShellsByKey.get(
      scopedThreadKey(environmentId as EnvironmentId, threadId as ThreadId),
    );
    if (!shell) {
      // Once an environment's live shell snapshot has synced, any missing thread was either
      // deleted or paginated into older settled history — both should clear stale banners.
      if (input.liveEnvironmentIds?.has(environmentId)) {
        identifiers.push(identifier);
      }
      continue;
    }

    const exactUpdatedAtMs = parseTimestampMs(data?.updatedAt);
    const notifiedAtMs = exactUpdatedAtMs ?? normalizeNotificationDateMs(notification.date);
    if (
      shouldDismissForShellState({
        shell,
        phase: typeof data?.phase === "string" ? data.phase : null,
        hasExactUpdatedAt: exactUpdatedAtMs !== null,
        notifiedAtMs,
        nowMs: input.nowMs,
      })
    ) {
      identifiers.push(identifier);
    }
  }
  return identifiers;
}

export async function dismissDeliveredNotificationsForDeepLink(deepLink: string): Promise<void> {
  if (typeof Notifications.getPresentedNotificationsAsync !== "function") {
    return;
  }
  try {
    const delivered = await Notifications.getPresentedNotificationsAsync();
    const matchingIds = deliveredNotificationIdentifiersToDismiss({
      deliveredNotifications: delivered,
      openDeepLink: deepLink,
      threadShellsByKey: new Map(),
      nowMs: Date.now(),
    });
    if (matchingIds.length === 0) {
      return;
    }
    await Promise.all(
      matchingIds.map((identifier) => Notifications.dismissNotificationAsync(identifier)),
    );
  } catch {
    // Best-effort cleanup; navigation and background sync must stay resilient.
  }
}

export function notifyOpenAgentThreadDeepLink(deepLink: string | null): void {
  openThreadDeepLink = deepLink;
  if (deepLink !== null) {
    void dismissDeliveredNotificationsForDeepLink(deepLink);
  }
}

function collectLiveEnvironmentIds(): ReadonlySet<string> {
  const liveIds = new Set<string>();
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const shellState = appAtomRegistry.get(environmentShell.stateValueAtom(environmentId));
    if (shellState.status === "live") {
      liveIds.add(environmentId);
    }
  }
  return liveIds;
}

async function runReconcileDeliveredAgentNotifications(): Promise<void> {
  if (typeof Notifications.getPresentedNotificationsAsync !== "function") {
    return;
  }
  try {
    const delivered = await Notifications.getPresentedNotificationsAsync();
    if (delivered.length === 0) {
      return;
    }
    const threadShellsByKey = new Map<string, DismissCheckThreadShell>();
    for (const shell of appAtomRegistry.get(environmentThreadShells.threadShellsAtom)) {
      threadShellsByKey.set(scopedThreadKey(shell.environmentId, shell.id), shell);
    }
    const liveEnvironmentIds = collectLiveEnvironmentIds();
    const identifiersToDismiss = deliveredNotificationIdentifiersToDismiss({
      deliveredNotifications: delivered,
      openDeepLink: openThreadDeepLink,
      threadShellsByKey,
      liveEnvironmentIds,
      nowMs: Date.now(),
    });
    if (identifiersToDismiss.length === 0) {
      return;
    }
    await Promise.all(
      identifiersToDismiss.map((identifier) => Notifications.dismissNotificationAsync(identifier)),
    );
  } catch {
    // Notification center reconciliation is best-effort.
  }
}

export function reconcileDeliveredAgentNotifications(): Promise<void> {
  if (reconcileInFlight !== null) {
    reconcileQueued = true;
    return reconcileInFlight;
  }
  const run = (async () => {
    do {
      reconcileQueued = false;
      await runReconcileDeliveredAgentNotifications();
    } while (reconcileQueued);
  })().finally(() => {
    reconcileInFlight = null;
  });
  reconcileInFlight = run;
  return run;
}

function scheduleReconcile(): void {
  if (reconcileTimer !== null) {
    clearTimeout(reconcileTimer);
  }
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void reconcileDeliveredAgentNotifications();
  }, RECONCILE_DEBOUNCE_MS);
}

/**
 * Reconciles presented Notification Center banners when Browne becomes active or when live
 * thread snapshots change (dismissing notifications handled on desktop or other routes).
 */
export function AgentNotificationDismissalCoordinator(): null {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes imperatively to AppState and atom thread shells to clear stale notifications without React re-renders
  useEffect(() => {
    void reconcileDeliveredAgentNotifications();
    const unsubscribeShells = appAtomRegistry.subscribe(
      environmentThreadShells.threadShellsAtom,
      scheduleReconcile,
    );
    const unsubscribeShellSummary = appAtomRegistry.subscribe(
      environmentShellSummaryAtom,
      scheduleReconcile,
    );
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        void reconcileDeliveredAgentNotifications();
      }
    });
    return () => {
      unsubscribeShells();
      unsubscribeShellSummary();
      appStateSubscription.remove();
      if (reconcileTimer !== null) {
        clearTimeout(reconcileTimer);
        reconcileTimer = null;
      }
    };
  }, []);

  return null;
}
