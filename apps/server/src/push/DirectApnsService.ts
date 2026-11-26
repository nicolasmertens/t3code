import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivitySnapshotResponse,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
  RelayDeviceRegistrationRequest,
  RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import {
  alertForActivityRows,
  isTerminalPhase,
  makeAggregateState,
  notificationForActivity,
  shouldDismissThreadNotification,
  threadNotificationTransition,
} from "./directApnsAggregate.ts";
import {
  createDirectApnsClient,
  isPermanentInvalidToken,
  makeLiveActivityRequest,
  makePushNotificationRequest,
  makeSilentDismissRequest,
  type DirectApnsClient,
  type DirectApnsDismissEntry,
  type DirectApnsEnvironment,
} from "./directApnsClient.ts";
import { loadDirectApnsConfig, type DirectApnsConfig } from "./directApnsConfig.ts";

const DEVICES_FILE_NAME = "direct-apns-devices.json";
const ACTIVE_NOTIFICATION_MAX_ENTRIES = 100;
const RECENT_DISMISSAL_MAX_ENTRIES = 25;
const ACTIVE_NOTIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const StoredPreferencesSchema = Schema.Struct({
  liveActivitiesEnabled: Schema.Boolean,
  notificationsEnabled: Schema.Boolean,
  notifyOnApproval: Schema.Boolean,
  notifyOnInput: Schema.Boolean,
  notifyOnCompletion: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
});

const StoredActiveNotificationSchema = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  phase: Schema.String,
  updatedAt: Schema.String,
  sentAt: Schema.String,
});
type StoredActiveNotification = typeof StoredActiveNotificationSchema.Type;

const StoredRecentDismissalSchema = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  dismissedAt: Schema.String,
});
type StoredRecentDismissal = typeof StoredRecentDismissalSchema.Type;

const StoredDirectApnsDeviceSchema = Schema.Struct({
  deviceId: Schema.String,
  label: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  iosMajorVersion: Schema.optional(Schema.Number),
  androidApiLevel: Schema.optional(Schema.Number),
  appVersion: Schema.optional(Schema.String),
  bundleId: Schema.optional(Schema.String),
  apsEnvironment: Schema.optional(Schema.Literals(["sandbox", "production"])),
  pushToken: Schema.optional(Schema.String),
  activityPushToken: Schema.optional(Schema.String),
  pushToStartToken: Schema.optional(Schema.String),
  activeNotifications: Schema.optional(Schema.Array(StoredActiveNotificationSchema)),
  recentDismissals: Schema.optional(Schema.Array(StoredRecentDismissalSchema)),
  preferences: StoredPreferencesSchema,
  updatedAt: Schema.String,
});

const StoredDevicesFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  devices: Schema.Array(StoredDirectApnsDeviceSchema),
});

const decodeDevicesFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredDevicesFileSchema),
);
const encodeDevicesFile = Schema.encodeEffect(Schema.fromJsonString(StoredDevicesFileSchema));

type StoredDirectApnsDevice = typeof StoredDirectApnsDeviceSchema.Type;

export class DirectApnsService extends Context.Service<
  DirectApnsService,
  {
    readonly isConfigured: boolean;
    readonly registerDevice: (
      request: RelayDeviceRegistrationRequest,
    ) => Effect.Effect<{ readonly ok: true }>;
    readonly unregisterDevice: (deviceId: string) => Effect.Effect<{ readonly ok: true }>;
    readonly registerLiveActivity: (
      request: RelayLiveActivityRegistrationRequest,
    ) => Effect.Effect<{ readonly ok: true }>;
    readonly getSnapshot: () => Effect.Effect<RelayAgentActivitySnapshotResponse>;
    readonly publishThreadState: (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<void>;
    readonly dismissThreadNotifications: (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly reason: "visited" | "handled";
    }) => Effect.Effect<void>;
  }
>()("t3/push/DirectApnsService") {}

function pruneActiveNotifications(
  entries: ReadonlyArray<StoredActiveNotification> | undefined,
  nowMs: number,
): ReadonlyArray<StoredActiveNotification> {
  if (!entries || entries.length === 0) return [];
  const cutoffMs = nowMs - ACTIVE_NOTIFICATION_TTL_MS;
  return entries
    .filter((entry) => {
      const sentMs = Date.parse(entry.sentAt);
      return Number.isFinite(sentMs) && sentMs >= cutoffMs;
    })
    .slice(-ACTIVE_NOTIFICATION_MAX_ENTRIES);
}

function pruneRecentDismissals(
  entries: ReadonlyArray<StoredRecentDismissal> | undefined,
  nowMs: number,
): ReadonlyArray<StoredRecentDismissal> {
  if (!entries || entries.length === 0) return [];
  const cutoffMs = nowMs - ACTIVE_NOTIFICATION_TTL_MS;
  return entries
    .filter((entry) => {
      const dismissedMs = Date.parse(entry.dismissedAt);
      return Number.isFinite(dismissedMs) && dismissedMs >= cutoffMs;
    })
    .slice(-RECENT_DISMISSAL_MAX_ENTRIES);
}

function removeThreadNotification(
  entries: ReadonlyArray<StoredActiveNotification> | undefined,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  nowMs: number,
): {
  readonly matched: boolean;
  readonly remaining: ReadonlyArray<StoredActiveNotification>;
} {
  const pruned = pruneActiveNotifications(entries, nowMs);
  const remaining = pruned.filter(
    (entry) => !(entry.environmentId === environmentId && entry.threadId === threadId),
  );
  return {
    matched:
      entries?.some(
        (entry) => entry.environmentId === environmentId && entry.threadId === threadId,
      ) ?? false,
    remaining,
  };
}

function upsertThreadNotification(
  entries: ReadonlyArray<StoredActiveNotification> | undefined,
  nextEntry: StoredActiveNotification,
  nowMs: number,
): ReadonlyArray<StoredActiveNotification> {
  const { remaining } = removeThreadNotification(
    entries,
    nextEntry.environmentId,
    nextEntry.threadId,
    nowMs,
  );
  return [...remaining, nextEntry].slice(-ACTIVE_NOTIFICATION_MAX_ENTRIES);
}

function removeRecentDismissal(
  entries: ReadonlyArray<StoredRecentDismissal> | undefined,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  nowMs: number,
): ReadonlyArray<StoredRecentDismissal> {
  return pruneRecentDismissals(entries, nowMs).filter(
    (entry) => !(entry.environmentId === environmentId && entry.threadId === threadId),
  );
}

function upsertRecentDismissal(
  entries: ReadonlyArray<StoredRecentDismissal> | undefined,
  nextEntry: StoredRecentDismissal,
  nowMs: number,
): ReadonlyArray<StoredRecentDismissal> {
  const remaining = removeRecentDismissal(
    entries,
    nextEntry.environmentId,
    nextEntry.threadId,
    nowMs,
  );
  return [...remaining, nextEntry].slice(-RECENT_DISMISSAL_MAX_ENTRIES);
}

function hasRecentDismissal(
  entries: ReadonlyArray<StoredRecentDismissal> | undefined,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  nowMs: number,
): boolean {
  return pruneRecentDismissals(entries, nowMs).some(
    (entry) => entry.environmentId === environmentId && entry.threadId === threadId,
  );
}

function hasRecordedNotification(
  device: StoredDirectApnsDevice,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  phase: string,
  updatedAt: string,
): boolean {
  return (
    device.activeNotifications?.some(
      (entry) =>
        entry.environmentId === environmentId &&
        entry.threadId === threadId &&
        entry.phase === phase &&
        entry.updatedAt === updatedAt,
    ) ?? false
  );
}

function isAttentionOrTerminalState(state: RelayAgentActivityState | undefined): boolean {
  if (!state) return false;
  return (
    state.phase === "waiting_for_approval" ||
    state.phase === "waiting_for_input" ||
    state.phase === "completed" ||
    state.phase === "failed"
  );
}

const DEFAULT_PREFERENCES: RelayAgentAwarenessPreferences = {
  liveActivitiesEnabled: true,
  notificationsEnabled: false,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

interface DirectApnsServiceOptions {
  readonly config?: DirectApnsConfig | null;
  readonly client?: DirectApnsClient | null;
}

export const make = Effect.fn("DirectApnsService.make")(function* (
  options: DirectApnsServiceOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;

  const config =
    options.config !== undefined ? options.config : yield* loadDirectApnsConfig(process.env);
  const client =
    options.client !== undefined
      ? options.client
      : config !== null
        ? createDirectApnsClient(config)
        : null;

  if (client !== null) {
    yield* Effect.addFinalizer(() => Effect.sync(() => client.close()));
  }

  const devicesPath = path.join(serverConfig.stateDir, DEVICES_FILE_NAME);
  const deviceLock = Semaphore.makeUnsafe(1);
  const publishLock = Semaphore.makeUnsafe(1);
  const devices = new Map<string, StoredDirectApnsDevice>();
  const threadStates = new Map<ThreadId, RelayAgentActivityState>();

  const loadPersistedDevices = Effect.gen(function* () {
    const exists = yield* fs.exists(devicesPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return;
    const raw = yield* fs.readFileString(devicesPath).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to read direct-apns devices store", {
          devicesPath,
          cause,
        }).pipe(Effect.as("")),
      ),
    );
    if (!raw.trim()) return;
    const decoded = yield* decodeDevicesFile(raw).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Ignoring invalid direct-apns devices store", {
          devicesPath,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (decoded === null) return;
    for (const device of decoded.devices) {
      devices.set(device.deviceId, device);
    }
  });

  yield* loadPersistedDevices;

  if (config !== null) {
    yield* Effect.logInfo("Direct APNs push configured", {
      keyId: config.keyId,
      teamId: config.teamId,
      bundleId: config.bundleId,
      registeredDevices: devices.size,
    });
  }

  const persistDevices = Effect.fn("DirectApnsService.persistDevices")(
    function* () {
      const encoded = yield* encodeDevicesFile({
        version: 1,
        devices: [...devices.values()],
      });
      const nowMs = yield* Clock.currentTimeMillis;
      const tempPath = `${devicesPath}.tmp.${process.pid}.${nowMs}`;
      yield* fs.writeFileString(tempPath, encoded);
      yield* fs.chmod(tempPath, 0o600);
      yield* fs.rename(tempPath, devicesPath);
    },
    Effect.catch((cause) =>
      Effect.logWarning("Failed to persist direct-apns devices store", {
        devicesPath,
        cause,
      }),
    ),
  );

  const snapshotRegisteredIosDevices = () =>
    [...devices.values()].filter((device) => device.platform === "ios");

  const clearEndedActivityTokens = Effect.fn("DirectApnsService.clearEndedActivityTokens")(
    function* (
      tokensToClear: ReadonlyArray<{ readonly deviceId: string; readonly token: string }>,
    ) {
      if (tokensToClear.length === 0) return;
      yield* deviceLock.withPermit(
        Effect.gen(function* () {
          let changed = false;
          for (const entry of tokensToClear) {
            const current = devices.get(entry.deviceId);
            if (!current || current.activityPushToken !== entry.token) continue;
            const { activityPushToken: _dropped, ...rest } = current;
            devices.set(entry.deviceId, rest);
            changed = true;
          }
          if (changed) {
            yield* persistDevices();
          }
        }),
      );
    },
  );

  const pruneInvalidTokens = Effect.fn("DirectApnsService.pruneInvalidTokens")(function* (
    invalidPush: ReadonlyArray<{ readonly deviceId: string; readonly token: string }>,
    invalidActivity: ReadonlyArray<{ readonly deviceId: string; readonly token: string }>,
  ) {
    if (invalidPush.length === 0 && invalidActivity.length === 0) return;
    yield* deviceLock.withPermit(
      Effect.gen(function* () {
        let changed = false;
        for (const entry of invalidPush) {
          const current = devices.get(entry.deviceId);
          if (!current || current.pushToken !== entry.token) continue;
          const { pushToken: _dropped, ...rest } = current;
          devices.set(entry.deviceId, rest);
          changed = true;
        }
        for (const entry of invalidActivity) {
          const current = devices.get(entry.deviceId);
          if (!current || current.activityPushToken !== entry.token) continue;
          const { activityPushToken: _dropped, ...rest } = current;
          devices.set(entry.deviceId, rest);
          changed = true;
        }
        if (changed) {
          yield* persistDevices();
        }
      }),
    );
  });

  const registerDevice = Effect.fn("DirectApnsService.registerDevice")(function* (
    request: RelayDeviceRegistrationRequest,
  ): Effect.fn.Return<{ readonly ok: true }> {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    let activityToEnd: {
      readonly token: string;
      readonly bundleId: string;
      readonly apsEnvironment: DirectApnsEnvironment;
    } | null = null;

    yield* deviceLock.withPermit(
      Effect.gen(function* () {
        const existing = devices.get(request.deviceId);
        const pushToken = request.pushToken ?? existing?.pushToken;
        const pushToStartToken = request.pushToStartToken ?? existing?.pushToStartToken;
        const shouldKeepActivity =
          request.preferences.liveActivitiesEnabled && existing?.activityPushToken !== undefined;
        if (!request.preferences.liveActivitiesEnabled && existing?.activityPushToken) {
          activityToEnd = {
            token: existing.activityPushToken,
            bundleId:
              request.bundleId ??
              existing.bundleId ??
              config?.bundleId ??
              "com.nicolasmertens.browne",
            apsEnvironment: request.apsEnvironment ?? existing.apsEnvironment ?? "production",
          };
        }
        const record: StoredDirectApnsDevice = {
          deviceId: request.deviceId,
          label: request.label,
          platform: request.platform,
          ...(request.iosMajorVersion !== undefined
            ? { iosMajorVersion: request.iosMajorVersion }
            : {}),
          ...(request.androidApiLevel !== undefined
            ? { androidApiLevel: request.androidApiLevel }
            : {}),
          ...(request.appVersion !== undefined ? { appVersion: request.appVersion } : {}),
          ...(request.bundleId !== undefined
            ? { bundleId: request.bundleId }
            : existing?.bundleId !== undefined
              ? { bundleId: existing.bundleId }
              : {}),
          ...(request.apsEnvironment !== undefined
            ? { apsEnvironment: request.apsEnvironment }
            : existing?.apsEnvironment !== undefined
              ? { apsEnvironment: existing.apsEnvironment }
              : {}),
          ...(pushToken !== undefined ? { pushToken } : {}),
          ...(shouldKeepActivity && existing?.activityPushToken
            ? { activityPushToken: existing.activityPushToken }
            : {}),
          ...(pushToStartToken !== undefined ? { pushToStartToken } : {}),
          ...(existing?.activeNotifications !== undefined
            ? { activeNotifications: existing.activeNotifications }
            : {}),
          ...(existing?.recentDismissals !== undefined
            ? { recentDismissals: existing.recentDismissals }
            : {}),
          preferences: request.preferences,
          updatedAt: nowIso,
        };
        devices.set(request.deviceId, record);
        yield* persistDevices();
      }),
    );

    if (client !== null && activityToEnd !== null) {
      const target = activityToEnd as {
        readonly token: string;
        readonly bundleId: string;
        readonly apsEnvironment: DirectApnsEnvironment;
      };
      const nowEpochSeconds = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
      yield* client.sendLiveActivity({
        environment: target.apsEnvironment,
        bundleId: target.bundleId,
        request: makeLiveActivityRequest({
          token: target.token,
          nowEpochSeconds,
          event: "end",
          state: null,
        }),
      });
    }

    return { ok: true as const };
  });

  const unregisterDevice = Effect.fn("DirectApnsService.unregisterDevice")(function* (
    deviceId: string,
  ): Effect.fn.Return<{ readonly ok: true }> {
    yield* deviceLock.withPermit(
      Effect.gen(function* () {
        if (devices.delete(deviceId)) {
          yield* persistDevices();
        }
      }),
    );
    return { ok: true as const };
  });

  const registerLiveActivity = Effect.fn("DirectApnsService.registerLiveActivity")(function* (
    request: RelayLiveActivityRegistrationRequest,
  ): Effect.fn.Return<{ readonly ok: true }> {
    const now = yield* DateTime.now;
    const nowMs = now.epochMilliseconds;
    const nowIso = DateTime.formatIso(now);

    const target = yield* deviceLock.withPermit(
      Effect.gen(function* () {
        const existing = devices.get(request.deviceId);
        const updated: StoredDirectApnsDevice = existing
          ? {
              ...existing,
              activityPushToken: request.activityPushToken,
              updatedAt: nowIso,
            }
          : {
              deviceId: request.deviceId,
              label: "iOS device",
              platform: "ios",
              iosMajorVersion: 18,
              ...(config?.bundleId ? { bundleId: config.bundleId } : {}),
              apsEnvironment: "production",
              activityPushToken: request.activityPushToken,
              preferences: DEFAULT_PREFERENCES,
              updatedAt: nowIso,
            };
        devices.set(request.deviceId, updated);
        yield* persistDevices();
        return updated;
      }),
    );

    if (client !== null && config !== null && target.preferences.liveActivitiesEnabled) {
      const aggregate = yield* publishLock.withPermit(
        Effect.sync(() =>
          makeAggregateState({
            activeStates: [...threadStates.values()],
            terminalState: null,
            nowMs,
            appTitle: config.appTitle,
          }),
        ),
      );
      if (aggregate !== null && aggregate.activeCount > 0) {
        const result = yield* client.sendLiveActivity({
          environment: target.apsEnvironment ?? "production",
          bundleId: target.bundleId ?? config.bundleId,
          request: makeLiveActivityRequest({
            token: request.activityPushToken,
            nowEpochSeconds: Math.floor(nowMs / 1_000),
            event: "update",
            state: aggregate,
          }),
        });
        if (!result.ok) {
          yield* Effect.logWarning("Direct APNs Live Activity replay failed", {
            deviceId: target.deviceId,
            status: result.status,
            reason: result.reason,
          });
          if (isPermanentInvalidToken(result)) {
            yield* pruneInvalidTokens(
              [],
              [{ deviceId: target.deviceId, token: request.activityPushToken }],
            );
          }
        }
      }
    }

    return { ok: true as const };
  });

  const getSnapshot = Effect.fn("DirectApnsService.getSnapshot")(
    function* (): Effect.fn.Return<RelayAgentActivitySnapshotResponse> {
      const nowMs = (yield* DateTime.now).epochMilliseconds;
      const aggregate = yield* publishLock.withPermit(
        Effect.sync(() =>
          makeAggregateState({
            activeStates: [...threadStates.values()],
            terminalState: null,
            nowMs,
            ...(config?.appTitle ? { appTitle: config.appTitle } : {}),
          }),
        ),
      );
      return { aggregate };
    },
  );

  const sendDismissForTargets = Effect.fn("DirectApnsService.sendDismissForTargets")(
    function* (input: {
      readonly targets: ReadonlyArray<{
        readonly deviceId: string;
        readonly token: string;
        readonly bundleId: string;
        readonly apsEnvironment: DirectApnsEnvironment;
        readonly dismissals: ReadonlyArray<DirectApnsDismissEntry>;
      }>;
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly reason: "visited" | "handled";
      readonly dismissedAt: string;
    }) {
      if (client === null || input.targets.length === 0) return;
      const invalidPushTokens: Array<{ readonly deviceId: string; readonly token: string }> = [];
      yield* Effect.forEach(
        input.targets,
        (target) =>
          Effect.gen(function* () {
            const res = yield* client.sendSilentDismissNotification({
              environment: target.apsEnvironment,
              bundleId: target.bundleId,
              request: makeSilentDismissRequest({
                token: target.token,
                environmentId: input.environmentId,
                threadId: input.threadId,
                reason: input.reason,
                dismissedAt: input.dismissedAt,
                dismissals: target.dismissals,
              }),
            });
            if (!res.ok) {
              yield* Effect.logWarning("Direct APNs silent dismiss failed", {
                deviceId: target.deviceId,
                environmentId: input.environmentId,
                threadId: input.threadId,
                reason: input.reason,
                status: res.status,
                reasonText: res.reason,
              });
              if (isPermanentInvalidToken(res)) {
                invalidPushTokens.push({ deviceId: target.deviceId, token: target.token });
              }
            }
          }),
        { concurrency: "unbounded" },
      );
      yield* pruneInvalidTokens(invalidPushTokens, []);
    },
  );

  const collectAndClearDismissTargets = Effect.fn(
    "DirectApnsService.collectAndClearDismissTargets",
  )(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly nowMs: number;
    readonly nowIso: string;
    readonly allowUnrecordedOnce: boolean;
  }) {
    const dismissTargets: Array<{
      readonly deviceId: string;
      readonly token: string;
      readonly bundleId: string;
      readonly apsEnvironment: DirectApnsEnvironment;
      readonly dismissals: ReadonlyArray<DirectApnsDismissEntry>;
    }> = [];
    yield* deviceLock.withPermit(
      Effect.gen(function* () {
        if (config === null) return;
        let changed = false;
        for (const device of devices.values()) {
          if (device.platform !== "ios") continue;
          const { matched, remaining } = removeThreadNotification(
            device.activeNotifications,
            input.environmentId,
            input.threadId,
            input.nowMs,
          );
          const alreadyDismissed = hasRecentDismissal(
            device.recentDismissals,
            input.environmentId,
            input.threadId,
            input.nowMs,
          );
          const shouldSend =
            matched ||
            (input.allowUnrecordedOnce &&
              !alreadyDismissed &&
              device.preferences.notificationsEnabled);
          if (!shouldSend) continue;

          const nextDismissals = upsertRecentDismissal(
            device.recentDismissals,
            {
              environmentId: input.environmentId,
              threadId: input.threadId,
              dismissedAt: input.nowIso,
            },
            input.nowMs,
          );
          if (device.pushToken) {
            dismissTargets.push({
              deviceId: device.deviceId,
              token: device.pushToken,
              bundleId: device.bundleId ?? config.bundleId,
              apsEnvironment: device.apsEnvironment ?? "production",
              dismissals: nextDismissals,
            });
          }
          const {
            activeNotifications: _droppedActive,
            recentDismissals: _droppedDismissals,
            ...rest
          } = device;
          devices.set(device.deviceId, {
            ...rest,
            ...(remaining.length > 0 ? { activeNotifications: remaining } : {}),
            ...(nextDismissals.length > 0 ? { recentDismissals: nextDismissals } : {}),
          });
          changed = true;
        }
        if (changed) {
          yield* persistDevices();
        }
      }),
    );
    return dismissTargets;
  });

  const dismissThreadNotifications: DirectApnsService["Service"]["dismissThreadNotifications"] =
    Effect.fn("DirectApnsService.dismissThreadNotifications")(function* (input) {
      if (config === null || client === null) {
        return;
      }
      yield* publishLock.withPermit(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const nowMs = now.epochMilliseconds;
          const nowIso = DateTime.formatIso(now);
          const currentState = threadStates.get(input.threadId);
          // Allow one unrecorded dismiss for explicit handled events (settled/snoozed/archived/deleted)
          // or visits to threads currently tracked in an attention/terminal phase, clearing pre-upgrade
          // banners without spamming APNs during active streaming visits.
          const allowUnrecordedOnce =
            input.reason === "handled" || isAttentionOrTerminalState(currentState);
          const targets = yield* collectAndClearDismissTargets({
            environmentId: input.environmentId,
            threadId: input.threadId,
            nowMs,
            nowIso,
            allowUnrecordedOnce,
          });
          yield* sendDismissForTargets({
            targets,
            environmentId: input.environmentId,
            threadId: input.threadId,
            reason: input.reason,
            dismissedAt: nowIso,
          });
        }),
      );
    });

  const publishThreadState: DirectApnsService["Service"]["publishThreadState"] = Effect.fn(
    "DirectApnsService.publishThreadState",
  )(function* (input) {
    if (config === null || client === null) {
      return;
    }

    yield* publishLock.withPermit(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowMs = now.epochMilliseconds;
        const nowIso = DateTime.formatIso(now);
        const nowEpochSeconds = Math.floor(nowMs / 1_000);

        const previousState = threadStates.get(input.threadId) ?? null;
        if (input.state === null) {
          threadStates.delete(input.threadId);
        } else {
          threadStates.set(input.threadId, input.state);
        }

        const terminalState =
          input.state !== null && isTerminalPhase(input.state) ? input.state : null;
        const nextAggregate = makeAggregateState({
          activeStates: [...threadStates.values()],
          terminalState,
          nowMs,
          appTitle: config.appTitle,
        });

        const shouldDismiss = shouldDismissThreadNotification({
          previousState,
          nextState: input.state,
        });
        const dismissTargets = shouldDismiss
          ? yield* collectAndClearDismissTargets({
              environmentId: input.environmentId,
              threadId: input.threadId,
              nowMs,
              nowIso,
              // Only send unrecorded dismisses on transitions away from attention/terminal phases;
              // starting a fresh thread from null -> running should not fire a silent dismiss.
              allowUnrecordedOnce: isAttentionOrTerminalState(previousState ?? undefined),
            })
          : [];

        const targets = yield* deviceLock.withPermit(Effect.sync(snapshotRegisteredIosDevices));
        if (targets.length === 0 && dismissTargets.length === 0) {
          return;
        }

        const endedTokens: Array<{ readonly deviceId: string; readonly token: string }> = [];
        const invalidPushTokens: Array<{ readonly deviceId: string; readonly token: string }> = [];
        const invalidActivityTokens: Array<{ readonly deviceId: string; readonly token: string }> =
          [];
        const recordedNotifications: Array<{
          readonly deviceId: string;
          readonly entry: StoredActiveNotification;
        }> = [];

        yield* Effect.forEach(
          targets,
          (device) =>
            Effect.gen(function* () {
              const bundleId = device.bundleId ?? config.bundleId;
              const apsEnvironment: DirectApnsEnvironment = device.apsEnvironment ?? "production";

              const candidateRow = threadNotificationTransition({
                previousState,
                nextState: input.state,
                preferences: device.preferences,
                nowMs,
              });
              const notificationRow: RelayAgentActivityAggregateRow | null =
                candidateRow !== null &&
                !hasRecordedNotification(
                  device,
                  input.environmentId,
                  input.threadId,
                  candidateRow.phase,
                  candidateRow.updatedAt,
                )
                  ? candidateRow
                  : null;

              let sentStandardPush = false;
              if (
                notificationRow !== null &&
                device.pushToken &&
                device.preferences.notificationsEnabled
              ) {
                const res = yield* client.sendPushNotification({
                  environment: apsEnvironment,
                  bundleId,
                  request: makePushNotificationRequest({
                    token: device.pushToken,
                    notification: notificationForActivity(notificationRow),
                  }),
                });
                if (res.ok) {
                  sentStandardPush = true;
                  recordedNotifications.push({
                    deviceId: device.deviceId,
                    entry: {
                      environmentId: input.environmentId,
                      threadId: input.threadId,
                      phase: notificationRow.phase,
                      updatedAt: notificationRow.updatedAt,
                      sentAt: nowIso,
                    },
                  });
                } else {
                  yield* Effect.logWarning("Direct APNs push notification failed", {
                    deviceId: device.deviceId,
                    status: res.status,
                    reason: res.reason,
                  });
                  if (isPermanentInvalidToken(res)) {
                    invalidPushTokens.push({
                      deviceId: device.deviceId,
                      token: device.pushToken,
                    });
                  }
                }
              }

              if (device.activityPushToken && device.preferences.liveActivitiesEnabled) {
                const liveActivityAlert = sentStandardPush
                  ? null
                  : alertForActivityRows(notificationRow ? [notificationRow] : []);
                if (nextAggregate === null || nextAggregate.activeCount === 0) {
                  const res = yield* client.sendLiveActivity({
                    environment: apsEnvironment,
                    bundleId,
                    request: makeLiveActivityRequest({
                      token: device.activityPushToken,
                      nowEpochSeconds,
                      event: "end",
                      state: nextAggregate,
                      alert: liveActivityAlert,
                    }),
                  });
                  if (!res.ok) {
                    yield* Effect.logWarning("Direct APNs Live Activity end failed", {
                      deviceId: device.deviceId,
                      status: res.status,
                      reason: res.reason,
                    });
                  }
                  endedTokens.push({
                    deviceId: device.deviceId,
                    token: device.activityPushToken,
                  });
                } else {
                  const res = yield* client.sendLiveActivity({
                    environment: apsEnvironment,
                    bundleId,
                    request: makeLiveActivityRequest({
                      token: device.activityPushToken,
                      nowEpochSeconds,
                      event: "update",
                      state: nextAggregate,
                      alert: liveActivityAlert,
                    }),
                  });
                  if (!res.ok) {
                    yield* Effect.logWarning("Direct APNs Live Activity update failed", {
                      deviceId: device.deviceId,
                      status: res.status,
                      reason: res.reason,
                    });
                    if (isPermanentInvalidToken(res)) {
                      invalidActivityTokens.push({
                        deviceId: device.deviceId,
                        token: device.activityPushToken,
                      });
                    }
                  }
                }
              }
            }),
          { concurrency: "unbounded" },
        );

        yield* sendDismissForTargets({
          targets: dismissTargets,
          environmentId: input.environmentId,
          threadId: input.threadId,
          reason: "handled",
          dismissedAt: nowIso,
        });

        if (recordedNotifications.length > 0) {
          yield* deviceLock.withPermit(
            Effect.gen(function* () {
              let changed = false;
              for (const recorded of recordedNotifications) {
                const current = devices.get(recorded.deviceId);
                if (!current) continue;
                const nextRecentDismissals = removeRecentDismissal(
                  current.recentDismissals,
                  recorded.entry.environmentId,
                  recorded.entry.threadId,
                  nowMs,
                );
                const { recentDismissals: _droppedDismissals, ...rest } = current;
                devices.set(recorded.deviceId, {
                  ...rest,
                  activeNotifications: upsertThreadNotification(
                    current.activeNotifications,
                    recorded.entry,
                    nowMs,
                  ),
                  ...(nextRecentDismissals.length > 0
                    ? { recentDismissals: nextRecentDismissals }
                    : {}),
                });
                changed = true;
              }
              if (changed) {
                yield* persistDevices();
              }
            }),
          );
        }

        yield* clearEndedActivityTokens(endedTokens);
        yield* pruneInvalidTokens(invalidPushTokens, invalidActivityTokens);
      }),
    );
  });

  return DirectApnsService.of({
    isConfigured: config !== null && client !== null,
    registerDevice,
    unregisterDevice,
    registerLiveActivity,
    getSnapshot,
    publishThreadState,
    dismissThreadNotifications,
  });
});

export const layer = Layer.effect(DirectApnsService, make());
