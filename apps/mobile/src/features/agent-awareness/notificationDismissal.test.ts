import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const dismissedIds = vi.hoisted(() => [] as string[]);
const presentedNotificationsMock = vi.hoisted(() => ({
  current: [] as Array<{
    readonly date?: number | undefined;
    readonly request: {
      readonly identifier: string;
      readonly content?: {
        readonly data?: unknown;
        readonly threadIdentifier?: string | null;
      } | null;
    };
  }>,
}));

vi.mock("react-native", () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock("expo-notifications", () => ({
  getPresentedNotificationsAsync: vi.fn(() => Promise.resolve(presentedNotificationsMock.current)),
  dismissNotificationAsync: vi.fn((id: string) => {
    dismissedIds.push(id);
    return Promise.resolve();
  }),
}));

vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: vi.fn(() => []),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { catalogValueAtom: Symbol("catalogValueAtom") },
}));

vi.mock("../../state/shell", () => ({
  environmentShell: { stateValueAtom: vi.fn(() => Symbol("shellStateAtom")) },
  environmentShellSummaryAtom: Symbol("environmentShellSummaryAtom"),
}));

vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellsAtom: Symbol("threadShellsAtom") },
}));

import {
  deliveredNotificationIdentifiersToDismiss,
  dismissDeliveredNotificationsForDeepLink,
  type DismissCheckThreadShell,
  type PresentedAgentNotification,
} from "./notificationDismissal";

const ENV_1 = EnvironmentId.make("env-1");
const ENV_2 = EnvironmentId.make("env-2");
const THREAD_1 = ThreadId.make("thread-1");
const THREAD_2 = ThreadId.make("thread-2");
const NOW_MS = Date.parse("2026-11-25T12:00:00.000Z");

const baseRuntime: DismissCheckThreadShell["runtime"] = {
  status: "completed",
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-11-25T11:55:00.000Z",
};

const baseLatestRun: NonNullable<DismissCheckThreadShell["latestRun"]> = {
  runId: RunId.make("run-1"),
  status: "completed",
  requestedAt: "2026-11-25T11:54:00.000Z",
  startedAt: "2026-11-25T11:54:01.000Z",
  completedAt: "2026-11-25T11:55:00.000Z",
  assistantMessageId: null,
};

function makeShell(overrides: Partial<DismissCheckThreadShell> = {}): DismissCheckThreadShell {
  return {
    environmentId: ENV_1,
    id: THREAD_1,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedAt: null,
    snoozedUntil: null,
    lastVisitedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    runtime: baseRuntime,
    latestRun: baseLatestRun,
    ...overrides,
  };
}

function makePresented(
  identifier: string,
  data: Record<string, unknown>,
  options: {
    readonly date?: number;
    readonly threadIdentifier?: string | null;
  } = {},
): PresentedAgentNotification {
  return {
    date: options.date ?? Date.parse("2026-11-25T11:55:00.000Z") / 1_000,
    request: {
      identifier,
      content: {
        data,
        ...(options.threadIdentifier !== undefined
          ? { threadIdentifier: options.threadIdentifier }
          : {}),
      },
    },
  };
}

describe("deliveredNotificationIdentifiersToDismiss", () => {
  beforeEach(() => {
    dismissedIds.length = 0;
    presentedNotificationsMock.current = [];
  });

  it("dismissDeliveredNotificationsForDeepLink dismisses only matching presented notifications", async () => {
    presentedNotificationsMock.current = [
      makePresented("match-1", {
        environmentId: ENV_1,
        threadId: THREAD_1,
        deepLink: `/threads/${ENV_1}/${THREAD_1}`,
      }),
      makePresented("other-2", {
        environmentId: ENV_1,
        threadId: THREAD_2,
        deepLink: `/threads/${ENV_1}/${THREAD_2}`,
      }),
    ];
    await dismissDeliveredNotificationsForDeepLink(`/threads/${ENV_1}/${THREAD_1}`);
    expect(dismissedIds).toEqual(["match-1"]);
  });

  it("dismisses notifications for a thread opened via any route or matched via threadIdentifier", () => {
    const delivered = [
      makePresented("n1", {
        environmentId: ENV_1,
        threadId: THREAD_1,
        deepLink: `/threads/${ENV_1}/${THREAD_1}`,
      }),
      makePresented("n1-tid", {}, { threadIdentifier: `${ENV_1}/${THREAD_1}` }),
      makePresented("n2", {
        environmentId: ENV_1,
        threadId: THREAD_2,
        deepLink: `/threads/${ENV_1}/${THREAD_2}`,
      }),
    ];

    expect(
      deliveredNotificationIdentifiersToDismiss({
        deliveredNotifications: delivered,
        openDeepLink: `/threads/${ENV_1}/${THREAD_1}`,
        threadShellsByKey: new Map(),
        nowMs: NOW_MS,
      }),
    ).toEqual(["n1", "n1-tid"]);
  });

  it("dismisses notifications handled elsewhere (archived, settled, snoozed, visited, running, interrupted, answered, or deleted on live env)", () => {
    const shells = new Map<string, DismissCheckThreadShell>([
      [
        `${ENV_1}:${THREAD_1}`,
        makeShell({
          id: THREAD_1,
          archivedAt: "2026-11-25T11:56:00.000Z",
        }),
      ],
      [
        `${ENV_1}:settled-thread`,
        makeShell({
          id: ThreadId.make("settled-thread"),
          settledOverride: "settled",
          settledAt: "2026-11-25T11:56:00.000Z",
        }),
      ],
      [
        `${ENV_1}:snoozed-thread`,
        makeShell({
          id: ThreadId.make("snoozed-thread"),
          snoozedAt: "2026-11-25T11:56:00.000Z",
          snoozedUntil: "2026-11-25T13:00:00.000Z",
        }),
      ],
      [
        `${ENV_1}:visited-thread`,
        makeShell({
          id: ThreadId.make("visited-thread"),
          lastVisitedAt: "2026-11-25T11:55:01.000Z",
          latestRun: {
            ...baseLatestRun,
            status: "completed",
            completedAt: "2026-11-25T11:55:00.000Z",
          },
        }),
      ],
      [
        `${ENV_1}:running-thread`,
        makeShell({
          id: ThreadId.make("running-thread"),
          runtime: { ...baseRuntime, status: "running" },
        }),
      ],
      [
        `${ENV_1}:interrupted-thread`,
        makeShell({
          id: ThreadId.make("interrupted-thread"),
          runtime: { ...baseRuntime, status: "interrupted" },
        }),
      ],
      [
        `${ENV_1}:answered-thread`,
        makeShell({
          id: ThreadId.make("answered-thread"),
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          runtime: { ...baseRuntime, status: "waiting" },
        }),
      ],
      [
        `${ENV_1}:still-pending`,
        makeShell({
          id: ThreadId.make("still-pending"),
          hasPendingApprovals: true,
          runtime: { ...baseRuntime, status: "waiting" },
          lastVisitedAt: "2026-11-25T11:50:00.000Z",
        }),
      ],
    ]);

    const delivered = [
      makePresented("archived", { environmentId: ENV_1, threadId: THREAD_1 }),
      makePresented("settled", {
        environmentId: ENV_1,
        threadId: "settled-thread",
        updatedAt: "2026-11-25T11:55:00.000Z",
      }),
      makePresented("snoozed", {
        environmentId: ENV_1,
        threadId: "snoozed-thread",
        updatedAt: "2026-11-25T11:55:00.000Z",
      }),
      // APNs delivery landed 3s after completion while user visited 1s after completion.
      makePresented(
        "visited-with-apns-lag",
        {
          environmentId: ENV_1,
          threadId: "visited-thread",
          phase: "completed",
          updatedAt: "2026-11-25T11:55:03.000Z",
        },
        { date: Date.parse("2026-11-25T11:55:03.000Z") / 1_000 },
      ),
      makePresented("running", {
        environmentId: ENV_1,
        threadId: "running-thread",
        phase: "completed",
        updatedAt: "2026-11-25T11:55:00.000Z",
      }),
      makePresented("interrupted", {
        environmentId: ENV_1,
        threadId: "interrupted-thread",
        phase: "completed",
        updatedAt: "2026-11-25T11:55:00.000Z",
      }),
      makePresented("answered", {
        environmentId: ENV_1,
        threadId: "answered-thread",
        phase: "waiting_for_approval",
        updatedAt: "2026-11-25T11:55:00.000Z",
      }),
      makePresented("keep-pending", {
        environmentId: ENV_1,
        threadId: "still-pending",
        phase: "waiting_for_approval",
        updatedAt: "2026-11-25T11:55:00.000Z",
      }),
      makePresented("deleted-on-live-env", {
        environmentId: ENV_1,
        threadId: "deleted-or-older-settled",
      }),
      makePresented("unloaded-on-offline-env", {
        environmentId: ENV_2,
        threadId: "not-yet-loaded",
      }),
    ];

    expect(
      deliveredNotificationIdentifiersToDismiss({
        deliveredNotifications: delivered,
        openDeepLink: null,
        threadShellsByKey: shells,
        liveEnvironmentIds: new Set([ENV_1]),
        nowMs: NOW_MS,
      }),
    ).toEqual([
      "archived",
      "settled",
      "snoozed",
      "visited-with-apns-lag",
      "running",
      "interrupted",
      "answered",
      "deleted-on-live-env",
    ]);
  });
});
