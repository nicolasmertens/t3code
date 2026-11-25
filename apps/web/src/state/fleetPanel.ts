import {
  type FleetPanelActionInput,
  type FleetPanelContextInput,
  type FleetPanelContextResult,
} from "@t3tools/contracts";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import {
  createEnvironmentCommand,
  createEnvironmentQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";
import { type ComposerThreadTarget, useComposerDraftStore } from "../composerDraftStore";

const FLEET_PANEL_TIMEOUT_MS = 12_000;

export type FleetPanelContextQueryState =
  | { readonly status: "ready"; readonly data: FleetPanelContextResult }
  | { readonly status: "unsupported"; readonly note: string }
  | { readonly status: "unavailable"; readonly note: string };

function errorStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    readonly status?: unknown;
    readonly response?: { readonly status?: unknown };
  };
  if (typeof candidate.status === "number") return candidate.status;
  if (candidate.response && typeof candidate.response.status === "number") {
    return candidate.response.status;
  }
  return null;
}

export const fleetPanelEnvironment = {
  context: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "fleet-panel:context",
    staleTimeMs: 20_000,
    idleTtlMs: 60_000,
    execute: (input: FleetPanelContextInput) =>
      executeConnectedEnvironmentHttpRequest({
        group: "fleetPanel",
        method: "POST",
        url: (urls) => urls.context(),
        timeoutMs: FLEET_PANEL_TIMEOUT_MS,
        request: ({ client, headers }) => client.context({ headers, payload: input }),
      }).pipe(
        Effect.map((data): FleetPanelContextQueryState => ({ status: "ready", data })),
        Effect.catch((error): Effect.Effect<FleetPanelContextQueryState> => {
          const code = errorStatusCode(error);
          if (code === 404 || code === 405 || code === 501) {
            return Effect.succeed<FleetPanelContextQueryState>({
              status: "unsupported",
              note: "Fleet Panel endpoint not yet active on this server.",
            });
          }
          return Effect.succeed<FleetPanelContextQueryState>({
            status: "unavailable",
            note: error instanceof Error ? error.message : String(error),
          });
        }),
      ),
  }),
  action: createEnvironmentCommand(connectionAtomRuntime, {
    label: "fleet-panel:action",
    execute: (input: FleetPanelActionInput) =>
      executeConnectedEnvironmentHttpRequest({
        group: "fleetPanel",
        method: "POST",
        url: (urls) => urls.action(),
        timeoutMs: FLEET_PANEL_TIMEOUT_MS,
        request: ({ client, headers }) => client.action({ headers, payload: input }),
      }),
  }),
};

export function appendToComposerPrompt(target: ComposerThreadTarget, addition: string): void {
  const trimmed = addition.trim();
  if (trimmed.length === 0) return;
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(target)?.prompt ?? "";
  const separator = current.trim().length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  store.setPrompt(target, `${current}${separator}${trimmed}`);
}
