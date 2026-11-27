import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useMessages } from "gt-react-native";
import * as Linking from "expo-linking";
import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";

import { environmentCatalog } from "../connection/catalog";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { environmentPresentations } from "../state/presentation";
import { environmentProjects } from "../state/projects";
import { environmentSession } from "../state/session";
import { environmentThreadShells } from "../state/threads";
import { getCachedBrowneHubFleetSummary, refreshBrowneHubFleetContexts } from "./browneHubFleet";
import {
  buildBrowneHubProjectOptions,
  buildBrowneHubSnapshot,
  type BrowneHubFleetSummary,
} from "./browneHubSnapshot";
import { publishBrowneHub } from "./publishBrowneHub";
import { buildSubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";
import { createWidgetTheme } from "./widgetTheme";

const PUBLISH_DEBOUNCE_MS = 350;
const FLEET_POLL_INTERVAL_MS = 3 * 60_000;

const connectedFleetTargetsAtom = Atom.make((get) => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const targets: Array<{
    readonly environmentId: EnvironmentId;
    readonly prepared: PreparedConnection;
  }> = [];
  for (const [environmentId, presentation] of presentations) {
    if (presentation.connection.phase !== "connected") continue;
    const prepared = Option.getOrNull(
      get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
    if (prepared !== null) {
      targets.push({ environmentId, prepared });
    }
  }
  return targets;
}).pipe(Atom.withLabel("mobile:browne-hub-fleet-targets"));

export function BrowneHubCoordinator() {
  const {
    themeMode,
    themeVariablesByAppearance,
    isReady: appearanceReady,
  } = useAppearancePreferences();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const presentationsWithProviders = useAtomValue(
    environmentPresentations.presentationsWithProvidersAtom,
  );
  const threads = useAtomValue(environmentThreadShells.threadShellsAtom);
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const fleetTargets = useAtomValue(connectedFleetTargetsAtom);
  const resolve = useMessages();

  const [fleetSummary, setFleetSummary] = useState<BrowneHubFleetSummary | null>(() =>
    getCachedBrowneHubFleetSummary(
      fleetTargets.map((target) => target.environmentId),
      resolve,
    ),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes optional Fleet/Mail summary asynchronously on connect, resume, and interval
  useEffect(() => {
    if (Platform.OS !== "ios" || !catalog.isReady || fleetTargets.length === 0) return;

    let cancelled = false;
    const refresh = () => {
      void refreshBrowneHubFleetContexts(fleetTargets, Date.now(), resolve)
        .then((next) => {
          if (!cancelled && next !== null) {
            setFleetSummary(next);
          }
        })
        .catch(() => {});
    };

    refresh();
    const timer = setInterval(refresh, FLEET_POLL_INTERVAL_MS);
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });

    return () => {
      cancelled = true;
      clearInterval(timer);
      appStateSubscription.remove();
    };
  }, [catalog.isReady, fleetTargets, resolve]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes debounced BrowneHub snapshot and dynamic project enum options to iOS WidgetKit
  useEffect(() => {
    if (Platform.OS !== "ios" || !catalog.isReady || !appearanceReady) return;

    const timer = setTimeout(() => {
      const savedEnvironmentIds = new Set<string>(catalog.entries.keys());
      const environmentLabelsById = new Map<string, string>();
      let connectedEnvCount = 0;
      for (const [environmentId, presentation] of presentations) {
        environmentLabelsById.set(environmentId, presentation.entry.target.label);
        if (presentation.connection.phase === "connected") {
          connectedEnvCount += 1;
        }
      }

      const usageSnapshot = buildSubscriptionUsageSnapshot(
        presentationsWithProviders,
        Linking.createURL("settings/usage", { queryParams: { tab: "limits" } }),
        6,
        resolve,
      );

      const snapshot = buildBrowneHubSnapshot({
        threads,
        projects,
        environmentLabelsById,
        savedEnvironmentIds,
        connectedEnvCount,
        totalEnvCount: catalog.entries.size,
        usageSnapshot,
        fleetSummary,
        theme: createWidgetTheme(themeMode, themeVariablesByAppearance),
        nowMs: Date.now(),
        resolve,
      });

      const projectOptions = buildBrowneHubProjectOptions(projects, environmentLabelsById, resolve);

      void publishBrowneHub(snapshot, projectOptions).catch((error: unknown) => {
        console.warn("Could not update BrowneHub widget", error);
      });
    }, PUBLISH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [
    catalog,
    appearanceReady,
    presentations,
    presentationsWithProviders,
    threads,
    projects,
    fleetSummary,
    themeMode,
    themeVariablesByAppearance,
    resolve,
  ]);

  return null;
}
