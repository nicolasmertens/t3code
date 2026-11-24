import type { EnvironmentId } from "@t3tools/contracts";
import {
  RelayAgentActivitySnapshotResponse,
  type RelayAgentActivityAggregateRow,
  type RelayAgentActivityAggregateState,
  type RelayAgentAwarenessPhase,
  type RelayDeviceRegistrationRequest,
  type RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

class DirectPushFetchError extends Schema.TaggedError<DirectPushFetchError>()(
  "DirectPushFetchError",
  {
    cause: Schema.Defect(),
  },
) {}

const DIRECT_PUSH_TIMEOUT_MS = 8_000;
const MAX_ACTIVITY_ROWS = 5;
const DIRECT_PUSH_APP_TITLE = "Browne";

export interface DirectPushTarget {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
  readonly bearerToken: string | null;
}

const decodeSnapshotJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentActivitySnapshotResponse),
);

let directPushTargets: ReadonlyArray<DirectPushTarget> = [];

export function setDirectPushTargets(targets: ReadonlyArray<DirectPushTarget>): void {
  directPushTargets = [...targets];
}

export function getDirectPushTargets(): ReadonlyArray<DirectPushTarget> {
  return directPushTargets;
}

export function __resetDirectPushTargetsForTest(): void {
  directPushTargets = [];
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeBaseUrl(httpBaseUrl: string): string {
  return httpBaseUrl.replace(/\/+$/, "");
}

function phasePriority(phase: RelayAgentAwarenessPhase): number {
  if (phase === "waiting_for_approval" || phase === "waiting_for_input") return 0;
  if (phase === "failed") return 1;
  if (phase === "starting" || phase === "running") return 2;
  return 3;
}

async function fetchDirectPushWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ readonly status: number; readonly body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const buildAuthHeaders = Effect.fn("directPushClient.buildAuthHeaders")(function* (input: {
  readonly target: DirectPushTarget;
  readonly method: "GET" | "POST" | "DELETE";
  readonly url: string;
}): Effect.fn.Return<Record<string, string> | null> {
  const auth = input.target.httpAuthorization;
  if (auth?._tag === "Bearer") {
    return { authorization: `Bearer ${auth.token}` };
  }
  if (auth?._tag === "Dpop") {
    const signerOption = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    if (Option.isNone(signerOption)) {
      return null;
    }
    const proof = yield* signerOption.value
      .createProof({
        method: input.method,
        url: input.url,
        accessToken: auth.accessToken,
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (proof === null) {
      return null;
    }
    return {
      authorization: `DPoP ${auth.accessToken}`,
      dpop: proof,
    };
  }
  if (input.target.bearerToken) {
    return { authorization: `Bearer ${input.target.bearerToken}` };
  }
  return null;
});

const sendDirectRequest = Effect.fn("directPushClient.sendDirectRequest")(function* (input: {
  readonly target: DirectPushTarget;
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly payload?: unknown;
}): Effect.fn.Return<{ readonly status: number; readonly body: string } | null> {
  const url = `${normalizeBaseUrl(input.target.httpBaseUrl)}${input.path}`;
  const authHeaders = yield* buildAuthHeaders({
    target: input.target,
    method: input.method,
    url,
  });
  if (authHeaders === null) {
    return null;
  }
  const body = input.payload === undefined ? undefined : serializeJson(input.payload);
  return yield* Effect.tryPromise({
    try: () =>
      fetchDirectPushWithTimeout(
        url,
        {
          method: input.method,
          headers: {
            ...authHeaders,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body }),
        },
        DIRECT_PUSH_TIMEOUT_MS,
      ),
    catch: (cause) => new DirectPushFetchError({ cause }),
  }).pipe(Effect.orElseSucceed(() => null));
});

export const registerDeviceDirect = Effect.fn("directPushClient.registerDeviceDirect")(function* (
  payload: RelayDeviceRegistrationRequest,
): Effect.fn.Return<boolean> {
  const targets = [...directPushTargets];
  if (targets.length === 0) {
    return false;
  }
  const outcomes = yield* Effect.forEach(
    targets,
    (target) =>
      sendDirectRequest({
        target,
        method: "POST",
        path: "/api/direct-push/devices",
        payload,
      }).pipe(Effect.map((response) => response !== null && response.status === 200)),
    { concurrency: "unbounded" },
  );
  return outcomes.some(Boolean);
});

export const unregisterDeviceDirect = Effect.fn("directPushClient.unregisterDeviceDirect")(
  function* (deviceId: string): Effect.fn.Return<void> {
    const targets = [...directPushTargets];
    if (targets.length === 0) {
      return;
    }
    yield* Effect.forEach(
      targets,
      (target) =>
        sendDirectRequest({
          target,
          method: "DELETE",
          path: `/api/direct-push/devices/${encodeURIComponent(deviceId)}`,
        }),
      { concurrency: "unbounded", discard: true },
    );
  },
);

export const registerLiveActivityDirect = Effect.fn("directPushClient.registerLiveActivityDirect")(
  function* (payload: RelayLiveActivityRegistrationRequest): Effect.fn.Return<boolean> {
    const targets = [...directPushTargets];
    if (targets.length === 0) {
      return false;
    }
    const outcomes = yield* Effect.forEach(
      targets,
      (target) =>
        sendDirectRequest({
          target,
          method: "POST",
          path: "/api/direct-push/live-activities",
          payload,
        }).pipe(Effect.map((response) => response !== null && response.status === 200)),
      { concurrency: "unbounded" },
    );
    return outcomes.some(Boolean);
  },
);

export function mergeDirectAgentActivityAggregates(
  aggregates: ReadonlyArray<RelayAgentActivityAggregateState | null>,
): RelayAgentActivitySnapshotResponse {
  const nonNull = aggregates.filter(
    (entry): entry is RelayAgentActivityAggregateState => entry !== null,
  );
  if (nonNull.length === 0) {
    return { aggregate: null };
  }
  if (nonNull.length === 1) {
    return { aggregate: nonNull[0]! };
  }

  const allRows: Array<RelayAgentActivityAggregateRow> = [];
  let activeCount = 0;
  let updatedAt = nonNull[0]!.updatedAt;
  for (const aggregate of nonNull) {
    activeCount += aggregate.activeCount;
    if (aggregate.updatedAt.localeCompare(updatedAt) > 0) {
      updatedAt = aggregate.updatedAt;
    }
    allRows.push(...aggregate.activities);
  }
  const mergedRows = [...allRows]
    .sort((left, right) => {
      const priorityDiff = phasePriority(left.phase) - phasePriority(right.phase);
      if (priorityDiff !== 0) return priorityDiff;
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, MAX_ACTIVITY_ROWS);

  const hasFailure = mergedRows.some((row) => row.phase === "failed");
  const subtitle =
    activeCount > 0
      ? "Agent work in progress"
      : hasFailure
        ? "Agent work failed"
        : "Agent work completed";

  return {
    aggregate: {
      title: DIRECT_PUSH_APP_TITLE,
      subtitle,
      activeCount,
      updatedAt,
      activities: mergedRows,
    },
  };
}

export const readAgentActivitySnapshotDirect = Effect.fn(
  "directPushClient.readAgentActivitySnapshotDirect",
)(function* (): Effect.fn.Return<RelayAgentActivitySnapshotResponse | null> {
  const targets = [...directPushTargets];
  if (targets.length === 0) {
    return null;
  }
  const responses = yield* Effect.forEach(
    targets,
    (target) =>
      sendDirectRequest({
        target,
        method: "GET",
        path: "/api/direct-push/agent-activity",
      }),
    { concurrency: "unbounded" },
  );

  const decodedAggregates: Array<RelayAgentActivityAggregateState | null> = [];
  let hadSuccessfulHost = false;
  for (const response of responses) {
    if (response === null || response.status !== 200) {
      continue;
    }
    const decoded = decodeSnapshotJson(response.body);
    if (Option.isNone(decoded)) {
      continue;
    }
    hadSuccessfulHost = true;
    decodedAggregates.push(decoded.value.aggregate);
  }

  if (!hadSuccessfulHost) {
    return null;
  }
  return mergeDirectAgentActivityAggregates(decodedAggregates);
});
