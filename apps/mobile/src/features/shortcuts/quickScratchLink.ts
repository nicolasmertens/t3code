import type { NavigationState, PartialState } from "@react-navigation/native";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { findLinkedRoute, findStackRoute } from "../../lib/appLinking";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { createNewTaskDraft, waitForComposerDraftsLoaded } from "../../state/use-composer-drafts";
import { workspaceConnections, workspaceStateAtom } from "../../state/workspace";
import { selectWorkspaceDetail } from "../layout/workspace/workspace-detail-selection";
import {
  latestThreadEnvironmentIds,
  promptLinkScratchEnvironmentId,
  stepPendingPromptLink,
} from "../prompt-links/prompt-link-model";

const NEW_TASK_ROUTE = "NewTaskProject";
const NEW_TASK_ROUTES = [NEW_TASK_ROUTE];
const QUICK_SCRATCH_PATH = "new/scratch";

const quickScratchShellsSettledAtom = Atom.make((get) => {
  const workspace = get(workspaceStateAtom);
  return !(
    workspace.isLoadingConnections ||
    workspace.hasPendingShellSnapshot ||
    workspace.connectingEnvironments.some(
      (environment) =>
        environment.connectionState === "connecting" || environment.connectionError === null,
    )
  );
}).pipe(Atom.withLabel("mobile:quick-scratch-shells-settled"));

let pendingQuickScratch = false;
let stopWaitingForShells: (() => void) | null = null;
let inFlight = false;

export function isQuickScratchPath(path: string): boolean {
  const normalized = path.split(/[?#]/)[0]?.replace(/^\/+|\/+$/g, "") ?? "";
  return normalized === QUICK_SCRATCH_PATH;
}

export function takeQuickScratchLink(
  state: PartialState<NavigationState> | undefined,
  path: string,
): PartialState<NavigationState> | undefined {
  if (!isQuickScratchPath(path) || !findLinkedRoute(state, NEW_TASK_ROUTES)) {
    return state;
  }
  pendingQuickScratch = true;
  return state;
}

function dropPendingQuickScratch(): void {
  pendingQuickScratch = false;
  stopWaitingForShells?.();
  stopWaitingForShells = null;
}

async function openQuickScratchDraft(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const scratchEnvironmentIds = appAtomRegistry
      .get(workspaceConnections.environmentsAtom)
      .filter(
        (environment) =>
          availableScratchWorkspaceRoot(
            environment.connectionState,
            serverConfigs.get(environment.environmentId),
          ) !== null,
      )
      .map((environment) => environment.environmentId);
    const environmentId = promptLinkScratchEnvironmentId(
      latestThreadEnvironmentIds(appAtomRegistry.get(environmentThreadShells.threadShellsAtom)),
      scratchEnvironmentIds,
    );
    if (environmentId === null) {
      Dialog.alert(
        m(msg("Could not start without a project")),
        m(msg("No connected environment offers threads without a project.")),
      );
      return;
    }

    const result = await runAtomCommand(
      appAtomRegistry,
      projectEnvironment.openScratch,
      { environmentId, input: {} },
      { reportFailure: false },
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          m(msg("Could not start without a project")),
          error instanceof Error
            ? (errorDisplayMessage(error, m) ?? error.message)
            : m(msg("The folder for threads without a project could not be created.")),
        );
      }
      return;
    }

    if (findStackRoute(rootNavigationRef.getRootState(), NEW_TASK_ROUTE)?.focused !== true) {
      return;
    }

    try {
      await waitForComposerDraftsLoaded();
    } catch {
      Dialog.alert(
        m(msg("Could not start without a project")),
        m(msg("Saved drafts could not be loaded. Try again.")),
      );
      return;
    }

    if (findStackRoute(rootNavigationRef.getRootState(), NEW_TASK_ROUTE)?.focused !== true) {
      return;
    }

    const project = result.value;
    const draftId = createNewTaskDraft({
      environmentId: project.environmentId,
      projectId: project.id,
    });
    rootNavigationRef.dispatch(
      selectWorkspaceDetail({
        name: "Thread",
        params: {
          draft: {
            environmentId: String(project.environmentId),
            projectId: String(project.id),
            draftId,
            title: project.title,
          },
        },
      }),
    );
  } finally {
    inFlight = false;
  }
}

export function resolvePendingQuickScratchLink(state: NavigationState | undefined): void {
  if (!pendingQuickScratch) return;
  const step = stepPendingPromptLink(true as const, {
    screenOnStack: findStackRoute(state, NEW_TASK_ROUTE)?.focused === true,
    ready: appAtomRegistry.get(quickScratchShellsSettledAtom),
  });
  if (step.pending === null) {
    dropPendingQuickScratch();
  }
  if (step.resolve !== null) {
    void openQuickScratchDraft();
  } else if (step.pending !== null) {
    stopWaitingForShells ??= appAtomRegistry.subscribe(quickScratchShellsSettledAtom, (settled) => {
      if (settled) resolvePendingQuickScratchLink(rootNavigationRef.getRootState());
    });
  }
}
