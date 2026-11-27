import type { NavigationState, PartialState } from "@react-navigation/native";
import type { DiscussEmailsScope } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { findLinkedRoute, findStackRoute } from "../../lib/appLinking";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { workspaceStateAtom } from "../../state/workspace";
import { stepPendingPromptLink } from "../prompt-links/prompt-link-model";
import { launchDiscussEmails } from "./discussEmails";

const NEW_TASK_ROUTE = "NewTaskProject";
const NEW_TASK_ROUTES = [NEW_TASK_ROUTE];
const DISCUSS_EMAILS_PATH = "new/discuss-emails";

export interface DiscussEmailsLinkOptions {
  readonly draftOnly: boolean;
  readonly scope: DiscussEmailsScope;
}

const discussEmailsShellsSettledAtom = Atom.make((get) => {
  const workspace = get(workspaceStateAtom);
  return !(
    workspace.isLoadingConnections ||
    workspace.hasPendingShellSnapshot ||
    workspace.connectingEnvironments.some(
      (environment) =>
        environment.connectionState === "connecting" || environment.connectionError === null,
    )
  );
}).pipe(Atom.withLabel("mobile:discuss-emails-shells-settled"));

let pendingDiscussEmails: DiscussEmailsLinkOptions | null = null;
let stopWaitingForShells: (() => void) | null = null;

export function parseDiscussEmailsPath(path: string): DiscussEmailsLinkOptions | null {
  const [withoutHash] = path.split("#");
  const [rawPathname = "", rawSearch = ""] = (withoutHash ?? "").split("?");
  const normalized = rawPathname.replace(/^\/+|\/+$/g, "");
  if (normalized !== DISCUSS_EMAILS_PATH) {
    return null;
  }

  const params = new URLSearchParams(rawSearch);
  const draftParam = params.get("draft")?.trim().toLowerCase();
  const scopeParam = params.get("scope")?.trim().toLowerCase();
  return {
    draftOnly: draftParam === "1" || draftParam === "true",
    scope: scopeParam === "all" ? "all" : "core",
  };
}

export function isDiscussEmailsPath(path: string): boolean {
  return parseDiscussEmailsPath(path) !== null;
}

export function takeDiscussEmailsLink(
  state: PartialState<NavigationState> | undefined,
  path: string,
): PartialState<NavigationState> | undefined {
  const parsed = parseDiscussEmailsPath(path);
  if (parsed === null || !findLinkedRoute(state, NEW_TASK_ROUTES)) {
    return state;
  }
  pendingDiscussEmails = parsed;
  return state;
}

function dropPendingDiscussEmails(): void {
  pendingDiscussEmails = null;
  stopWaitingForShells?.();
  stopWaitingForShells = null;
}

export function resolvePendingDiscussEmailsLink(state: NavigationState | undefined): void {
  if (pendingDiscussEmails === null) return;
  const step = stepPendingPromptLink(pendingDiscussEmails, {
    screenOnStack: findStackRoute(state, NEW_TASK_ROUTE)?.focused === true,
    ready: appAtomRegistry.get(discussEmailsShellsSettledAtom),
  });
  if (step.pending === null) {
    dropPendingDiscussEmails();
  } else {
    pendingDiscussEmails = step.pending;
  }
  if (step.resolve !== null) {
    void launchDiscussEmails({ ...step.resolve, fromNewTaskRoute: true });
  } else if (step.pending !== null) {
    stopWaitingForShells ??= appAtomRegistry.subscribe(
      discussEmailsShellsSettledAtom,
      (settled) => {
        if (settled) resolvePendingDiscussEmailsLink(rootNavigationRef.getRootState());
      },
    );
  }
}
