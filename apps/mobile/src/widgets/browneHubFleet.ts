import {
  FleetPanelContextResult,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  type EnvironmentId,
  type FleetPanelContextResult as FleetPanelContextResultType,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { fetch as expoFetch } from "expo/fetch";
import { msg } from "gt-react-native";

import { connectionAtomRuntime } from "../connection/runtime";
import { m, type MessageResolver } from "../i18n/messages";
import { appAtomRegistry } from "../state/atom-registry";
import type { BrowneHubFleetItem, BrowneHubFleetSummary } from "./browneHubSnapshot";

const FLEET_FETCH_TIMEOUT_MS = 8_000;
const FLEET_REFRESH_INTERVAL_MS = 3 * 60_000;
const FLEET_PANEL_CONTEXT_PATH = "/api/fleet-panel/context";
const MAX_SUMMARY_ITEMS = 6;

const decodeFleetPanelResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(FleetPanelContextResult),
);

interface CachedEnvironmentFleet {
  readonly fetchedAt: number;
  readonly payload: FleetPanelContextResultType | null;
}

const fleetCacheByEnvironmentId = new Map<EnvironmentId, CachedEnvironmentFleet>();
const inFlightByEnvironmentId = new Map<
  EnvironmentId,
  Promise<FleetPanelContextResultType | null>
>();

function normalizeBaseUrl(httpBaseUrl: string): string {
  return httpBaseUrl.replace(/\/+$/, "");
}

const buildFleetAuthHeaders = Effect.fn("browneHubFleet.buildAuthHeaders")(function* (input: {
  readonly prepared: PreparedConnection;
  readonly url: string;
}): Effect.fn.Return<Record<string, string> | null> {
  const auth = input.prepared.httpAuthorization;
  if (auth === null) {
    return {};
  }
  if (auth._tag === "Bearer") {
    return { authorization: `Bearer ${auth.token}` };
  }
  if (auth._tag === "Dpop") {
    const signerOption = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    if (Option.isNone(signerOption)) {
      return null;
    }
    const proof = yield* signerOption.value
      .createProof({
        method: "POST",
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
  return null;
});

async function fetchFleetContextForPrepared(
  prepared: PreparedConnection,
): Promise<FleetPanelContextResultType | null> {
  const url = `${normalizeBaseUrl(prepared.httpBaseUrl)}${FLEET_PANEL_CONTEXT_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FLEET_FETCH_TIMEOUT_MS);
  try {
    const headers = await Effect.runPromise(
      AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
        Effect.flatMap((context) =>
          buildFleetAuthHeaders({ prepared, url }).pipe(Effect.provide(context)),
        ),
        Effect.orElseSucceed(() => null),
      ),
    );
    if (headers === null) return null;

    const response = await expoFetch(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      ...(prepared.httpAuthorization === null ? { credentials: "include" as const } : {}),
      headers: {
        ...headers,
        [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        threadId: "__browne_widget__",
        forceRefresh: false,
      }),
    });
    if (response.status !== 200) {
      return null;
    }
    const raw = await response.text();
    const decoded = decodeFleetPanelResult(raw);
    return Option.isSome(decoded) ? decoded.value : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function summarizeFleetPanelContexts(
  payloads: ReadonlyArray<FleetPanelContextResultType>,
  resolve: MessageResolver = m,
): BrowneHubFleetSummary | null {
  if (payloads.length === 0) return null;

  let totalHosts = 0;
  let upHosts = 0;
  let degradedHostCount = 0;
  const items: BrowneHubFleetItem[] = [];
  const seenIds = new Set<string>();

  const pushUnique = (item: BrowneHubFleetItem) => {
    if (items.length >= MAX_SUMMARY_ITEMS || seenIds.has(item.id)) return;
    seenIds.add(item.id);
    items.push(item);
  };

  for (const payload of payloads) {
    const hosts = payload.fleet.hosts;
    totalHosts += hosts.length;
    for (const host of hosts) {
      if (host.ok) {
        upHosts += 1;
      } else {
        degradedHostCount += 1;
        pushUnique({
          id: `host-down:${host.alias}`,
          title: resolve(msg("{host} offline", { host: host.alias })),
          subtitle: host.detail?.trim() || host.role,
          badge: resolve(msg("Host", { $context: "short fleet host status badge" })),
          severity: "alert",
          deepLink: "browne://new/scratch",
        });
      }
    }

    for (const sensor of payload.fleet.degradedSensors) {
      degradedHostCount += 1;
      pushUnique({
        id: `sensor:${sensor.host}:${sensor.name}`,
        title: `${sensor.host}: ${sensor.name}`,
        subtitle: sensor.detail,
        badge: resolve(msg("Alert", { $context: "short degraded sensor badge" })),
        severity: "alert",
        deepLink: "browne://new/scratch",
      });
    }

    for (const trayItem of payload.tray.items) {
      if (trayItem.decision !== "pending") continue;
      pushUnique({
        id: `tray:${trayItem.id}`,
        title: trayItem.title,
        subtitle: trayItem.detail,
        badge: resolve(msg("Tray", { $context: "short fleet tray badge" })),
        severity: "alert",
        deepLink: "browne://talk-to-fleet",
      });
    }

    for (const message of payload.mail.messages) {
      pushUnique({
        id: `mail:${message.id}`,
        title: message.subject || resolve(msg("Mail message")),
        subtitle: message.from,
        badge: resolve(msg("Mail")),
        severity: "mail",
        deepLink: "browne://talk-to-fleet",
      });
    }

    for (const task of [...payload.plan.waitingItems, ...payload.plan.matchedTasks]) {
      pushUnique({
        id: `plan:${task.id}`,
        title: task.title,
        subtitle: task.deadline ? `${task.source} · ${task.deadline}` : task.source,
        badge: resolve(msg("Plan", { $context: "short fleet plan badge" })),
        severity: "plan",
        deepLink: "browne://talk-to-fleet",
      });
    }
  }

  return {
    hostsUpLabel: totalHosts > 0 ? `${upHosts}/${totalHosts}` : null,
    degradedHostCount,
    items,
  };
}

export async function refreshBrowneHubFleetContexts(
  targets: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly prepared: PreparedConnection;
  }>,
  nowMs: number,
  resolve: MessageResolver = m,
): Promise<BrowneHubFleetSummary | null> {
  const results = await Promise.all(
    targets.map(async ({ environmentId, prepared }) => {
      const cached = fleetCacheByEnvironmentId.get(environmentId);
      if (cached && nowMs - cached.fetchedAt < FLEET_REFRESH_INTERVAL_MS) {
        return cached.payload;
      }
      let inflight = inFlightByEnvironmentId.get(environmentId);
      if (!inflight) {
        inflight = fetchFleetContextForPrepared(prepared)
          .then((payload) => {
            fleetCacheByEnvironmentId.set(environmentId, { fetchedAt: Date.now(), payload });
            return payload;
          })
          .finally(() => {
            inFlightByEnvironmentId.delete(environmentId);
          });
        inFlightByEnvironmentId.set(environmentId, inflight);
      }
      return inflight;
    }),
  );

  const nonNull = results.filter((entry): entry is FleetPanelContextResultType => entry !== null);
  return summarizeFleetPanelContexts(nonNull, resolve);
}

export function getCachedBrowneHubFleetSummary(
  environmentIds: ReadonlyArray<EnvironmentId>,
  resolve: MessageResolver = m,
): BrowneHubFleetSummary | null {
  const nonNull: FleetPanelContextResultType[] = [];
  for (const environmentId of environmentIds) {
    const cached = fleetCacheByEnvironmentId.get(environmentId)?.payload;
    if (cached) nonNull.push(cached);
  }
  return summarizeFleetPanelContexts(nonNull, resolve);
}
