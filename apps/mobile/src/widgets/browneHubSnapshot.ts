import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  effectiveSnoozed,
  threadRaisedHandWhileSnoozed,
} from "@t3tools/client-runtime/state/thread-settled";
import { isListedThreadLineage } from "@t3tools/contracts";
import type { WidgetConfigurationEnum, WidgetTimelineEntry } from "expo-widgets";
import { msg } from "gt-react-native";

import {
  resolveThreadListV2Status,
  type ThreadListV2Status,
} from "../features/threads/threadListV2";
import { m, type MessageResolver } from "../i18n/messages";
import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";
import type { WidgetTheme } from "./widgetTheme";

export const BROWNE_HUB_STALE_AFTER_MS = 15 * 60_000;
const MAX_URGENT_TOPICS = 6;
const MAX_RUNNING_TOPICS = 6;
const MAX_LATEST_TOPICS = 8;
const MAX_PROJECT_SUMMARIES = 8;
const MAX_PROJECT_TOPICS = 4;
const MAX_PROJECT_CONFIG_OPTIONS = 20;
const MAX_FLEET_ITEMS = 6;

export type BrowneHubTopicKind =
  | "approval"
  | "input"
  | "request"
  | "failed"
  | "limited"
  | "running"
  | "done";

export type BrowneHubTab = "latest" | "running" | "projects" | "fleet";

export interface BrowneHubTopic {
  readonly id: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectKey: string;
  readonly title: string;
  readonly projectTitle: string;
  readonly kind: BrowneHubTopicKind;
  readonly statusLabel: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

export interface BrowneHubProjectSummary {
  readonly key: string;
  readonly title: string;
  readonly environmentLabel: string;
  readonly urgentCount: number;
  readonly runningCount: number;
  readonly doneTodayCount: number;
  readonly topics: ReadonlyArray<BrowneHubTopic>;
}

export type BrowneHubFleetSeverity = "alert" | "mail" | "plan" | "ok";

export interface BrowneHubFleetItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly badge: string;
  readonly severity: BrowneHubFleetSeverity;
  readonly deepLink: string;
}

export interface BrowneHubStats {
  readonly urgentCount: number;
  readonly approvalCount: number;
  readonly inputCount: number;
  readonly failedCount: number;
  readonly runningCount: number;
  readonly doneTodayCount: number;
  readonly tightestQuotaPercent: number | null;
  readonly connectedEnvCount: number;
  readonly totalEnvCount: number;
  readonly hostsUpLabel: string | null;
  readonly degradedHostCount: number;
}

export interface BrowneHubText {
  readonly talk: string;
  readonly talkShort: string;
  readonly quickTask: string;
  readonly quickShort: string;
  readonly newTask: string;
  readonly newShort: string;
  readonly reviewOpen: string;
  readonly latest: string;
  readonly runningTab: string;
  readonly projectsTab: string;
  readonly fleetTab: string;
  readonly approval: string;
  readonly input: string;
  readonly failed: string;
  readonly limited: string;
  readonly runningBadge: string;
  readonly done: string;
  readonly allClear: string;
  readonly needYou: string;
  readonly urgent: string;
  readonly active: string;
  readonly outOfDate: string;
  readonly openToSync: string;
  readonly noTopics: string;
  readonly noRunning: string;
  readonly noFleet: string;
  readonly allProjects: string;
  readonly runningLabel: string;
  readonly doneTodayLabel: string;
  readonly quotaLabel: string;
  readonly hostsLabel: string;
  readonly urgentLabel: string;
  readonly syncedLabel: string;
  readonly staleHint: string;
}

export interface BrowneHubSnapshot {
  readonly version: 1;
  readonly updatedAt: string;
  readonly stale?: boolean;
  readonly theme?: WidgetTheme;
  readonly activeTab?: BrowneHubTab;
  readonly projectSlideIndex?: number;
  readonly stats: BrowneHubStats;
  readonly urgentTopics: ReadonlyArray<BrowneHubTopic>;
  readonly runningTopics: ReadonlyArray<BrowneHubTopic>;
  readonly latestTopics: ReadonlyArray<BrowneHubTopic>;
  readonly projects: ReadonlyArray<BrowneHubProjectSummary>;
  readonly fleetItems: ReadonlyArray<BrowneHubFleetItem>;
  readonly text: BrowneHubText;
}

export interface BrowneHubFleetSummary {
  readonly hostsUpLabel: string | null;
  readonly degradedHostCount: number;
  readonly items: ReadonlyArray<BrowneHubFleetItem>;
}

export interface BuildBrowneHubSnapshotInput {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentLabelsById: ReadonlyMap<string, string>;
  readonly savedEnvironmentIds?: ReadonlySet<string> | null;
  readonly connectedEnvCount: number;
  readonly totalEnvCount: number;
  readonly usageSnapshot?: SubscriptionUsageSnapshot | null;
  readonly fleetSummary?: BrowneHubFleetSummary | null;
  readonly theme?: WidgetTheme;
  readonly nowMs: number;
  readonly resolve?: MessageResolver;
}

export function browneHubProjectKey(environmentId: string, projectId: string): string {
  return `${environmentId}::${projectId}`;
}

export function browneHubThreadDeepLink(environmentId: string, threadId: string): string {
  return `browne://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

export function browneHubText(resolve: MessageResolver = m): BrowneHubText {
  return {
    talk: resolve(msg("Talk to Fleet")),
    talkShort: resolve(msg("Talk", { $context: "short widget action for live voice" })),
    quickTask: resolve(msg("Quick task")),
    quickShort: resolve(msg("Quick", { $context: "short widget action for scratch thread" })),
    newTask: resolve(msg("New task")),
    newShort: resolve(msg("New", { $context: "short widget action for new project thread" })),
    reviewOpen: resolve(msg("Open & Review")),
    latest: resolve(msg("Latest")),
    runningTab: resolve(msg("Running", { $context: "widget tab for running agents" })),
    projectsTab: resolve(msg("Projects")),
    fleetTab: resolve(msg("Fleet")),
    approval: resolve(msg("Approve")),
    input: resolve(msg("Input", { $context: "agent waits for user input" })),
    failed: resolve(msg("Failed", { $context: "agent work status" })),
    limited: resolve(msg("Limit", { $context: "rate limited agent badge" })),
    runningBadge: resolve(msg("Running", { $context: "agent work status badge" })),
    done: resolve(msg("Done", { $context: "agent work status" })),
    allClear: resolve(msg("All clear")),
    needYou: resolve(msg("need you")),
    urgent: resolve(msg("URGENT")),
    active: resolve(msg("active")),
    outOfDate: resolve(msg("Out of date")),
    openToSync: resolve(msg("Open Browne to sync agents")),
    noTopics: resolve(msg("No recent topics yet")),
    noRunning: resolve(msg("No active agents")),
    noFleet: resolve(msg("No Fleet alerts")),
    allProjects: resolve(msg("All projects")),
    runningLabel: resolve(msg("Running", { $context: "widget stat label" })),
    doneTodayLabel: resolve(msg("Done today")),
    quotaLabel: resolve(msg("Quota left")),
    hostsLabel: resolve(msg("Hosts", { $context: "widget stat label for fleet hosts" })),
    urgentLabel: resolve(msg("Urgent")),
    syncedLabel: resolve(msg("Synced")),
    staleHint: resolve(msg("Open Browne to refresh")),
  };
}

function localMidnightMs(nowMs: number): number {
  const date = new Date(nowMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function urgentRankForStatus(
  status: ThreadListV2Status,
  thread: EnvironmentThreadShell,
  nowIso: string,
): { readonly kind: BrowneHubTopicKind; readonly rank: number } | null {
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

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

function isActivelyRunningStatus(
  status: ThreadListV2Status,
  thread: EnvironmentThreadShell,
): boolean {
  if (status === "working") return true;
  if (thread.pendingBackgroundTasks.length > 0) return true;
  if (
    thread.latestRun !== null &&
    thread.latestRun.completedAt === null &&
    ACTIVE_RUN_STATUSES.has(thread.latestRun.status)
  ) {
    return true;
  }
  if (status === "waiting") {
    return (
      thread.blockedOnThreadWait === true ||
      (thread.runtime !== null &&
        thread.runtime.status !== "idle" &&
        thread.runtime.status !== "completed" &&
        thread.runtime.status !== "failed")
    );
  }
  return false;
}

function statusBadgeLabel(kind: BrowneHubTopicKind, text: BrowneHubText): string {
  switch (kind) {
    case "approval":
      return text.approval;
    case "input":
    case "request":
      return text.input;
    case "failed":
      return text.failed;
    case "limited":
      return text.limited;
    case "running":
      return text.runningBadge;
    case "done":
      return text.done;
  }
}

function threadActivityIso(thread: EnvironmentThreadShell): string {
  return (
    thread.pendingUserInputAt ??
    thread.runtime?.updatedAt ??
    thread.latestRun?.completedAt ??
    thread.updatedAt
  );
}

function parseTimestamp(isoDate: string | null | undefined): number {
  if (!isoDate) return 0;
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function topicTitle(thread: Pick<EnvironmentThreadShell, "title">, fallback: string): string {
  const trimmed = (thread.title ?? "").trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function extractTightestQuotaPercent(
  usageSnapshot?: SubscriptionUsageSnapshot | null,
): number | null {
  if (!usageSnapshot) return null;
  let tightest: number | null = null;
  for (const provider of usageSnapshot.providers) {
    for (const window of provider.windows) {
      if (typeof window.remaining !== "number" || !Number.isFinite(window.remaining)) continue;
      if (tightest === null || window.remaining < tightest) {
        tightest = window.remaining;
      }
    }
  }
  return tightest;
}

export function buildBrowneHubProjectOptions(
  projects: ReadonlyArray<EnvironmentProject>,
  environmentLabelsById: ReadonlyMap<string, string>,
  resolve: MessageResolver = m,
): WidgetConfigurationEnum[] {
  const seen = new Set<string>();
  const projectEntries = projects
    .filter((project) => project.archivedAt == null)
    .sort((left, right) => {
      const scratchDiff = Number(Boolean(left.isScratch)) - Number(Boolean(right.isScratch));
      if (scratchDiff !== 0) return scratchDiff;
      return left.title.localeCompare(right.title);
    })
    .flatMap((project): WidgetConfigurationEnum[] => {
      const value = browneHubProjectKey(project.environmentId, project.id);
      if (seen.has(value)) return [];
      seen.add(value);
      const name = project.title.trim() || resolve(msg("Untitled project"));
      const envLabel = environmentLabelsById.get(project.environmentId)?.trim();
      return [
        {
          name,
          value,
          ...(envLabel ? { subtitle: envLabel } : {}),
        },
      ];
    })
    .slice(0, MAX_PROJECT_CONFIG_OPTIONS);

  return [{ name: resolve(msg("All projects")), value: "all" }, ...projectEntries];
}

export function buildBrowneHubSnapshot(input: BuildBrowneHubSnapshotInput): BrowneHubSnapshot {
  const resolve = input.resolve ?? m;
  const text = browneHubText(resolve);
  const nowIso = new Date(input.nowMs).toISOString();
  const midnightMs = localMidnightMs(input.nowMs);
  const untitledThread = resolve(
    msg("Thread", { $context: "fallback name for an untitled thread" }),
  );
  const untitledProject = resolve(msg("Project", { $context: "fallback project label" }));

  const projectsByKey = new Map<string, EnvironmentProject>();
  for (const project of input.projects) {
    if (project.archivedAt != null) continue;
    projectsByKey.set(browneHubProjectKey(project.environmentId, project.id), project);
  }

  const eligibleThreads = input.threads.filter((thread) => {
    if (
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      !isListedThreadLineage(thread.lineage)
    ) {
      return false;
    }
    if (input.savedEnvironmentIds != null && !input.savedEnvironmentIds.has(thread.environmentId)) {
      return false;
    }
    return true;
  });

  interface ClassifiedThread {
    readonly thread: EnvironmentThreadShell;
    readonly projectKey: string;
    readonly topic: BrowneHubTopic;
    readonly urgentRank: number | null;
    readonly isRunning: boolean;
    readonly isDoneToday: boolean;
    readonly activityMs: number;
  }

  let approvalCount = 0;
  let inputCount = 0;
  let failedCount = 0;
  let runningCount = 0;
  let doneTodayCount = 0;

  const classified: ClassifiedThread[] = eligibleThreads.map((thread) => {
    const projectKey = browneHubProjectKey(thread.environmentId, thread.projectId);
    const projectTitle = projectsByKey.get(projectKey)?.title.trim() || untitledProject;
    const status = resolveThreadListV2Status(thread);
    const urgent = urgentRankForStatus(status, thread, nowIso);
    const running = urgent === null && isActivelyRunningStatus(status, thread);

    const kind: BrowneHubTopicKind = urgent ? urgent.kind : running ? "running" : "done";

    if (kind === "approval") approvalCount += 1;
    else if (kind === "input" || kind === "request") inputCount += 1;
    else if (kind === "failed" || kind === "limited") failedCount += 1;
    else if (kind === "running") runningCount += 1;

    const completedAtMs = parseTimestamp(
      thread.latestRun?.completedAt ??
        thread.settledAt ??
        thread.runtime?.updatedAt ??
        thread.updatedAt,
    );
    const isDoneToday = kind === "done" && completedAtMs >= midnightMs;
    if (isDoneToday) doneTodayCount += 1;

    const updatedAt = threadActivityIso(thread);
    const topic: BrowneHubTopic = {
      id: `${thread.environmentId}:${thread.id}`,
      environmentId: thread.environmentId,
      threadId: thread.id,
      projectKey,
      title: topicTitle(thread, untitledThread),
      projectTitle,
      kind,
      statusLabel: statusBadgeLabel(kind, text),
      updatedAt,
      deepLink: browneHubThreadDeepLink(thread.environmentId, thread.id),
    };

    return {
      thread,
      projectKey,
      topic,
      urgentRank: urgent?.rank ?? null,
      isRunning: running,
      isDoneToday,
      activityMs: parseTimestamp(updatedAt),
    };
  });

  const urgentEntries = classified
    .filter(
      (entry): entry is ClassifiedThread & { readonly urgentRank: number } =>
        entry.urgentRank !== null,
    )
    .sort(
      (left, right) => left.urgentRank - right.urgentRank || right.activityMs - left.activityMs,
    );

  const urgentTopics = urgentEntries.slice(0, MAX_URGENT_TOPICS).map((entry) => entry.topic);

  const runningTopics = classified
    .filter((entry) => entry.isRunning)
    .sort((left, right) => right.activityMs - left.activityMs)
    .slice(0, MAX_RUNNING_TOPICS)
    .map((entry) => entry.topic);

  const latestTopics = [...classified]
    .sort((left, right) => right.activityMs - left.activityMs)
    .slice(0, MAX_LATEST_TOPICS)
    .map((entry) => entry.topic);

  const projectGroups = new Map<
    string,
    {
      readonly key: string;
      readonly project: EnvironmentProject;
      urgentCount: number;
      runningCount: number;
      doneTodayCount: number;
      latestActivityMs: number;
      entries: ClassifiedThread[];
    }
  >();

  for (const entry of classified) {
    const project = projectsByKey.get(entry.projectKey);
    if (!project) continue;
    let group = projectGroups.get(entry.projectKey);
    if (!group) {
      group = {
        key: entry.projectKey,
        project,
        urgentCount: 0,
        runningCount: 0,
        doneTodayCount: 0,
        latestActivityMs: 0,
        entries: [],
      };
      projectGroups.set(entry.projectKey, group);
    }
    if (entry.urgentRank !== null) group.urgentCount += 1;
    if (entry.isRunning) group.runningCount += 1;
    if (entry.isDoneToday) group.doneTodayCount += 1;
    if (entry.activityMs > group.latestActivityMs) group.latestActivityMs = entry.activityMs;
    group.entries.push(entry);
  }

  const projects: BrowneHubProjectSummary[] = [...projectGroups.values()]
    .sort(
      (left, right) =>
        right.urgentCount - left.urgentCount ||
        right.runningCount - left.runningCount ||
        right.latestActivityMs - left.latestActivityMs,
    )
    .slice(0, MAX_PROJECT_SUMMARIES)
    .map((group) => {
      const sortedEntries = [...group.entries].sort((left, right) => {
        if (left.urgentRank !== null && right.urgentRank === null) return -1;
        if (left.urgentRank === null && right.urgentRank !== null) return 1;
        if (
          left.urgentRank !== null &&
          right.urgentRank !== null &&
          left.urgentRank !== right.urgentRank
        ) {
          return left.urgentRank - right.urgentRank;
        }
        if (left.isRunning !== right.isRunning) return left.isRunning ? -1 : 1;
        return right.activityMs - left.activityMs;
      });
      return {
        key: group.key,
        title: group.project.title.trim() || untitledProject,
        environmentLabel:
          input.environmentLabelsById.get(group.project.environmentId)?.trim() || "",
        urgentCount: group.urgentCount,
        runningCount: group.runningCount,
        doneTodayCount: group.doneTodayCount,
        topics: sortedEntries.slice(0, MAX_PROJECT_TOPICS).map((entry) => entry.topic),
      };
    });

  const fleetItems = (input.fleetSummary?.items ?? []).slice(0, MAX_FLEET_ITEMS);

  return {
    version: 1,
    updatedAt: nowIso,
    stale: false,
    ...(input.theme ? { theme: input.theme } : {}),
    activeTab: "latest",
    projectSlideIndex: 0,
    stats: {
      urgentCount: urgentEntries.length,
      approvalCount,
      inputCount,
      failedCount,
      runningCount,
      doneTodayCount,
      tightestQuotaPercent: extractTightestQuotaPercent(input.usageSnapshot),
      connectedEnvCount: input.connectedEnvCount,
      totalEnvCount: input.totalEnvCount,
      hostsUpLabel: input.fleetSummary?.hostsUpLabel ?? null,
      degradedHostCount: input.fleetSummary?.degradedHostCount ?? 0,
    },
    urgentTopics,
    runningTopics,
    latestTopics,
    projects,
    fleetItems,
    text,
  };
}

export function browneHubTimeline(
  snapshot: BrowneHubSnapshot,
  nowMs: number,
): WidgetTimelineEntry<BrowneHubSnapshot>[] {
  const fresh: WidgetTimelineEntry<BrowneHubSnapshot> = {
    date: new Date(nowMs),
    props: { ...snapshot, stale: false },
  };
  if (snapshot.stats.runningCount === 0 && snapshot.stats.urgentCount === 0) {
    return [fresh];
  }
  const stale: WidgetTimelineEntry<BrowneHubSnapshot> = {
    date: new Date(nowMs + BROWNE_HUB_STALE_AFTER_MS),
    props: { ...snapshot, stale: true },
  };
  return [fresh, stale];
}

export function browneHubSnapshotFingerprint(snapshot: BrowneHubSnapshot): string {
  const { updatedAt: _updatedAt, ...rest } = snapshot;
  return JSON.stringify(rest);
}
