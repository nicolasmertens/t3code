import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentSession } from "../../state/session";
import { savedConnectionsByIdAtom } from "../../state/use-remote-environment-registry";
import { setDirectPushTargets, type DirectPushTarget } from "./directPushClient";
import {
  activateDirectPushAgentAwareness,
  deactivateDirectPushAgentAwareness,
  releaseDirectPushAgentAwareness,
} from "./remoteRegistration";

const directPushTargetsAtom = Atom.make((get) => {
  const savedConnectionsById = get(savedConnectionsByIdAtom);
  const targets: Array<DirectPushTarget> = [];
  for (const connection of Object.values(savedConnectionsById).sort((left, right) =>
    left.environmentId.localeCompare(right.environmentId),
  )) {
    const prepared = Option.getOrNull(
      get(environmentSession.preparedConnectionValueAtom(connection.environmentId)),
    );
    const httpBaseUrl = (prepared?.httpBaseUrl ?? connection.httpBaseUrl).trim();
    if (httpBaseUrl.length === 0) {
      continue;
    }
    const httpAuthorization =
      prepared?.httpAuthorization ??
      (connection.authenticationMethod === "dpop" && connection.dpopAccessToken
        ? {
            _tag: "Dpop" as const,
            accessToken: connection.dpopAccessToken,
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          }
        : connection.bearerToken
          ? { _tag: "Bearer" as const, token: connection.bearerToken }
          : null);
    if (httpAuthorization === null && !connection.bearerToken) {
      continue;
    }
    targets.push({
      environmentId: connection.environmentId,
      httpBaseUrl,
      httpAuthorization,
      bearerToken: connection.bearerToken,
    });
  }
  return targets;
}).pipe(Atom.withLabel("mobile:direct-push-targets"));

export function DirectPushCoordinator() {
  const targets = useAtomValue(directPushTargetsAtom);
  const identity = targets
    .map((target) => `${target.environmentId}@${target.httpBaseUrl}`)
    .join(",");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- syncs imperative direct-push target registry and agent-awareness listener lifecycle with connected environments
  useEffect(() => {
    setDirectPushTargets(targets);
    if (targets.length > 0) {
      activateDirectPushAgentAwareness(identity);
      return;
    }
    deactivateDirectPushAgentAwareness();
  }, [targets, identity]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases imperative direct-push registration listeners on coordinator unmount
  useEffect(() => {
    return () => {
      releaseDirectPushAgentAwareness();
    };
  }, []);

  return null;
}
