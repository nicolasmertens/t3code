import { requireOptionalNativeModule } from "expo";
import type { WidgetConfigurationEnum } from "expo-widgets";

import {
  browneHubSnapshotFingerprint,
  browneHubTimeline,
  type BrowneHubSnapshot,
} from "./browneHubSnapshot";

const MAX_QUIET_INTERVAL_MS = 60_000;

let lastFingerprint: string | null = null;
let lastPublishedAtMs = 0;
let lastProjectOptionsJson: string | null = null;

export async function publishBrowneHub(
  snapshot: BrowneHubSnapshot,
  projectOptions: ReadonlyArray<WidgetConfigurationEnum>,
): Promise<void> {
  if (!requireOptionalNativeModule("ExpoWidgets")) return;
  const now = Date.now();
  const fingerprint = browneHubSnapshotFingerprint(snapshot);
  const optionsJson = JSON.stringify(projectOptions);

  const snapshotChanged =
    lastFingerprint !== fingerprint || now - lastPublishedAtMs >= MAX_QUIET_INTERVAL_MS;
  const optionsChanged = lastProjectOptionsJson !== optionsJson;
  if (!snapshotChanged && !optionsChanged) return;

  const { default: widget } = await import("./BrowneHubWidget");
  if (optionsChanged) {
    try {
      widget.setConfigurationParameterEnum("projectKey", [...projectOptions]);
      lastProjectOptionsJson = optionsJson;
    } catch (error: unknown) {
      console.warn("Could not update BrowneHub project options", error);
    }
  }
  if (snapshotChanged) {
    lastFingerprint = fingerprint;
    lastPublishedAtMs = now;
    widget.updateTimeline(browneHubTimeline(snapshot, now));
  }
}
