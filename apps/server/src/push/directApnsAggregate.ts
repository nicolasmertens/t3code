import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export interface DirectApnsNotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly deepLink: string;
  readonly phase?: RelayAgentActivityState["phase"];
  readonly updatedAt?: string;
}

export interface DirectApnsLiveActivityAlert {
  readonly title: string;
  readonly body: string;
}

const RUNNING_AGENT_ACTIVITY_ROW_TTL_MS = 2 * 60 * 60 * 1_000;
const WAITING_AGENT_ACTIVITY_ROW_TTL_MS = 24 * 60 * 60 * 1_000;
const TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS = 15 * 60 * 1_000;
const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;

export const MAX_SUMMARY_TEXT_LENGTH = 120;
const MAX_STATUS_TEXT_LENGTH = 40;
const MAX_DEEP_LINK_LENGTH = 512;
const MAX_ACTIVITY_ROWS = 5;

export function isTerminalPhase(state: Pick<RelayAgentActivityState, "phase">): boolean {
  return state.phase === "completed" || state.phase === "failed";
}

function agentActivityExpiresAt(
  state: Pick<RelayAgentActivityState, "phase" | "updatedAt">,
): number {
  const updatedAtMs = Option.match(DateTime.make(state.updatedAt), {
    onNone: () => Number.NaN,
    onSome: (dt) => dt.epochMilliseconds,
  });
  if (Number.isNaN(updatedAtMs)) {
    return Number.NaN;
  }
  const ttlMs =
    state.phase === "running" || state.phase === "starting"
      ? RUNNING_AGENT_ACTIVITY_ROW_TTL_MS
      : WAITING_AGENT_ACTIVITY_ROW_TTL_MS;
  return updatedAtMs + ttlMs;
}

function isExpiredAgentActivityState(state: RelayAgentActivityState, nowMs: number): boolean {
  const expiresAt = agentActivityExpiresAt(state);
  return !Number.isFinite(expiresAt) || nowMs > expiresAt;
}

export function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return (
    trimmed
      .slice(0, maxLength - 3)
      .replace(/[\uD800-\uDBFF]$/, "")
      .trimEnd() + "..."
  );
}

function sanitizeDeepLink(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return "/";
  }
  return truncateText(trimmed, MAX_DEEP_LINK_LENGTH);
}

function sanitizeAgentActivityAggregateRow(
  row: RelayAgentActivityAggregateRow,
): RelayAgentActivityAggregateRow {
  return {
    ...row,
    projectTitle: truncateText(row.projectTitle, MAX_SUMMARY_TEXT_LENGTH),
    threadTitle: truncateText(row.threadTitle, MAX_SUMMARY_TEXT_LENGTH),
    modelTitle: truncateText(row.modelTitle, MAX_SUMMARY_TEXT_LENGTH),
    status: truncateText(row.status, MAX_STATUS_TEXT_LENGTH),
    deepLink: sanitizeDeepLink(row.deepLink),
  };
}

function sanitizeAgentActivityAggregateState(
  aggregate: RelayAgentActivityAggregateState,
): RelayAgentActivityAggregateState {
  return {
    ...aggregate,
    title: truncateText(aggregate.title, MAX_SUMMARY_TEXT_LENGTH),
    subtitle: truncateText(aggregate.subtitle, MAX_SUMMARY_TEXT_LENGTH),
    activities: aggregate.activities
      .slice(0, MAX_ACTIVITY_ROWS)
      .map(sanitizeAgentActivityAggregateRow),
  };
}

function statusForPhase(phase: RelayAgentActivityState["phase"]): string {
  switch (phase) {
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "starting":
      return "Connecting";
    case "running":
      return "Working";
    case "stale":
      return "Waiting";
  }
}

function activityPhasePriority(phase: RelayAgentActivityState["phase"]): number {
  if (phase === "waiting_for_approval" || phase === "waiting_for_input") return 0;
  if (phase === "failed") return 1;
  if (phase === "starting" || phase === "running") return 2;
  return 3;
}

function aggregateRowForState(state: RelayAgentActivityState): RelayAgentActivityAggregateRow {
  return {
    environmentId: state.environmentId,
    threadId: state.threadId,
    projectTitle: state.projectTitle,
    threadTitle: state.threadTitle,
    modelTitle: state.modelTitle,
    phase: state.phase,
    status: statusForPhase(state.phase),
    updatedAt: state.updatedAt,
    deepLink: state.deepLink,
  };
}

function isRecentTerminalState(state: RelayAgentActivityState, nowMs: number): boolean {
  if (!isTerminalPhase(state)) {
    return false;
  }
  const updatedAtMs = Option.match(DateTime.make(state.updatedAt), {
    onNone: () => Number.NaN,
    onSome: (dt) => dt.epochMilliseconds,
  });
  if (Number.isNaN(updatedAtMs)) {
    return false;
  }
  return nowMs - updatedAtMs <= TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS;
}

export function makeAggregateState(input: {
  readonly activeStates: ReadonlyArray<RelayAgentActivityState>;
  readonly terminalState: RelayAgentActivityState | null;
  readonly nowMs: number;
  readonly appTitle?: string;
}): RelayAgentActivityAggregateState | null {
  const title = input.appTitle ?? "Browne";
  const activeStates = input.activeStates.filter(
    (state) => !isTerminalPhase(state) && !isExpiredAgentActivityState(state, input.nowMs),
  );
  if (activeStates.length === 0) {
    if (input.terminalState !== null) {
      return sanitizeAgentActivityAggregateState({
        title,
        subtitle:
          input.terminalState.phase === "failed" ? "Agent work failed" : "Agent work completed",
        activeCount: 0,
        updatedAt: input.terminalState.updatedAt,
        activities: [aggregateRowForState(input.terminalState)],
      });
    }
    const recentTerminal = input.activeStates
      .filter((state) => isRecentTerminalState(state, input.nowMs))
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const newest = recentTerminal[0];
    if (!newest) {
      return null;
    }
    return sanitizeAgentActivityAggregateState({
      title,
      subtitle: newest.phase === "failed" ? "Agent work failed" : "Agent work completed",
      activeCount: 0,
      updatedAt: newest.updatedAt,
      activities: recentTerminal.slice(0, MAX_ACTIVITY_ROWS).map(aggregateRowForState),
    });
  }
  const recentTerminalStates = input.activeStates
    .filter((state) => isRecentTerminalState(state, input.nowMs))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const displayedStates = [
    ...activeStates
      .toSorted((a, b) => activityPhasePriority(a.phase) - activityPhasePriority(b.phase))
      .slice(0, MAX_ACTIVITY_ROWS),
    ...recentTerminalStates,
  ].slice(0, MAX_ACTIVITY_ROWS);
  const updatedAt = [...activeStates, ...recentTerminalStates].reduce((latest, state) =>
    state.updatedAt.localeCompare(latest.updatedAt) > 0 ? state : latest,
  ).updatedAt;
  return sanitizeAgentActivityAggregateState({
    title,
    subtitle: "Agent work in progress",
    activeCount: activeStates.length,
    updatedAt,
    activities: displayedStates.map(aggregateRowForState),
  });
}

function isFreshTerminalNotification(updatedAt: string, nowMs: number): boolean {
  const timestamp = Option.getOrNull(DateTime.make(updatedAt));
  return (
    timestamp !== null && nowMs - timestamp.epochMilliseconds <= TERMINAL_NOTIFICATION_FRESHNESS_MS
  );
}

function isAttentionPhase(phase: string): boolean {
  return phase === "waiting_for_approval" || phase === "waiting_for_input";
}

function alertAllowedForPhase(
  preferences: RelayAgentAwarenessPreferences | null,
  phase: string,
): boolean {
  if (preferences === null) return true;
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    default:
      return false;
  }
}

export function threadNotificationTransition(input: {
  readonly previousState: RelayAgentActivityState | null;
  readonly nextState: RelayAgentActivityState | null;
  readonly preferences: RelayAgentAwarenessPreferences | null;
  readonly nowMs: number;
}): RelayAgentActivityAggregateRow | null {
  const { previousState, nextState } = input;
  if (nextState === null) return null;
  if (!alertAllowedForPhase(input.preferences, nextState.phase)) return null;

  if (isAttentionPhase(nextState.phase)) {
    const shouldAlert =
      previousState !== null
        ? previousState.phase !== nextState.phase
        : isFreshTerminalNotification(nextState.updatedAt, input.nowMs);
    return shouldAlert ? aggregateRowForState(nextState) : null;
  }

  if (nextState.phase === "completed" || nextState.phase === "failed") {
    const wasTerminal = previousState?.phase === "completed" || previousState?.phase === "failed";
    if (!wasTerminal && isFreshTerminalNotification(nextState.updatedAt, input.nowMs)) {
      return aggregateRowForState(nextState);
    }
  }
  return null;
}

export function shouldDismissThreadNotification(input: {
  readonly previousState: RelayAgentActivityState | null;
  readonly nextState: RelayAgentActivityState | null;
}): boolean {
  if (input.nextState === null) return true;
  if (input.nextState.phase === "running" || input.nextState.phase === "starting") return true;
  return false;
}

export function alertForActivityRows(
  rows: ReadonlyArray<RelayAgentActivityAggregateRow>,
): DirectApnsLiveActivityAlert | null {
  const first = rows[0];
  if (!first) return null;
  if (rows.length === 1) {
    return { title: first.threadTitle, body: `${first.status}: ${first.projectTitle}` };
  }
  return {
    title: `${rows.length} agents ${isAttentionPhase(first.phase) ? "need attention" : "finished"}`,
    body: rows.map((row) => row.threadTitle).join(", "),
  };
}

export function notificationForActivity(
  row: RelayAgentActivityAggregateRow,
): DirectApnsNotificationPayload {
  const activity = sanitizeAgentActivityAggregateRow(row);
  return {
    title: truncateText(activity.threadTitle, MAX_SUMMARY_TEXT_LENGTH),
    body: truncateText(`${activity.status}: ${activity.projectTitle}`, MAX_SUMMARY_TEXT_LENGTH),
    environmentId: activity.environmentId,
    threadId: activity.threadId,
    deepLink: sanitizeDeepLink(activity.deepLink),
    phase: activity.phase,
    updatedAt: activity.updatedAt,
  };
}
