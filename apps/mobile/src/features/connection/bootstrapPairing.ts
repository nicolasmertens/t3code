import type { EnvironmentId } from "@t3tools/contracts";
import { AppState } from "react-native";

import { pairEnvironment } from "../../state/use-remote-environment-registry";

export const BOOTSTRAP_PAIR_FILE = "bootstrap-pair.json";
export const BOOTSTRAP_PAIR_RESULT_FILE = "bootstrap-pair-result.json";

export interface BootstrapPairResult {
  readonly ok: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly error: string | null;
  readonly completedAt: string;
}

let inFlight: Promise<void> | null = null;

async function writeBootstrapPairResult(payload: BootstrapPairResult): Promise<void> {
  const { File, Paths } = await import("expo-file-system");
  const resultFile = new File(Paths.document, BOOTSTRAP_PAIR_RESULT_FILE);
  resultFile.create({ intermediates: true, overwrite: true });
  await resultFile.write(JSON.stringify(payload, null, 2));
}

function parsePairingUrlPayload(raw: string): string | null {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const pairingUrl = (parsed as { readonly pairingUrl?: unknown }).pairingUrl;
  if (typeof pairingUrl !== "string") {
    return null;
  }
  const trimmed = pairingUrl.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Consumes a one-shot `Documents/bootstrap-pair.json` file pushed into the app container
 * via Xcode/devicectl, deletes it before pairing, and writes the outcome to
 * `Documents/bootstrap-pair-result.json`.
 */
export function consumeBootstrapPairing(): Promise<void> {
  if (inFlight !== null) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const { File, Paths } = await import("expo-file-system");
      const inputFile = new File(Paths.document, BOOTSTRAP_PAIR_FILE);
      if (!inputFile.exists) {
        return;
      }

      const raw = await inputFile.text();
      // Delete immediately so one-time credentials are never retried or left on disk.
      inputFile.delete();

      let pairingUrl: string | null;
      try {
        pairingUrl = parsePairingUrlPayload(raw);
      } catch (error) {
        await writeBootstrapPairResult({
          ok: false,
          environmentId: null,
          error:
            error instanceof Error
              ? error.message
              : // oxlint-disable-next-line t3code/no-untranslated-copy -- machine-readable diagnostic written to bootstrap-pair-result.json
                "Failed to parse bootstrap pairing payload.",
          completedAt: new Date().toISOString(),
        });
        return;
      }

      if (pairingUrl === null) {
        await writeBootstrapPairResult({
          ok: false,
          environmentId: null,
          // oxlint-disable-next-line t3code/no-untranslated-copy -- machine-readable diagnostic written to bootstrap-pair-result.json
          error: "Bootstrap pairing file is missing a non-empty pairingUrl.",
          completedAt: new Date().toISOString(),
        });
        return;
      }

      const outcome = await pairEnvironment(pairingUrl);
      await writeBootstrapPairResult({
        ok: outcome.ok,
        environmentId: outcome.environmentId ?? null,
        error: outcome.error,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      try {
        await writeBootstrapPairResult({
          ok: false,
          environmentId: null,
          error:
            error instanceof Error
              ? error.message
              : // oxlint-disable-next-line t3code/no-untranslated-copy -- machine-readable diagnostic written to bootstrap-pair-result.json
                "Bootstrap pairing failed.",
          completedAt: new Date().toISOString(),
        });
      } catch {
        // Ignore secondary write failures when document storage itself is unavailable.
      }
    }
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** Checks for a bootstrap pairing file on startup and whenever the app becomes active. */
export function installBootstrapPairing(): () => void {
  void consumeBootstrapPairing();
  const subscription = AppState.addEventListener("change", (nextState) => {
    if (nextState === "active") {
      void consumeBootstrapPairing();
    }
  });
  return () => {
    subscription.remove();
  };
}
