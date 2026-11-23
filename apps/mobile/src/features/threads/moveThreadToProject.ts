import { useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  selectMoveTargetProjects,
  type MoveTargetProject,
} from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, type ProjectId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { msg } from "gt-react-native";
import { useMemo } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";

export function useMoveThreadProjectTargets(
  thread: EnvironmentThreadShell,
): ReadonlyArray<MoveTargetProject> {
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const config = serverConfigs.get(thread.environmentId);
  const scratchWorkspaceRoot = config?.scratchWorkspaceRoot;
  const supported = config?.environment.capabilities.threadProjectMove === true;
  const { environmentId, projectId, lineage, delegatedFrom } = thread;
  return useMemo(
    () =>
      selectMoveTargetProjects({
        thread: { environmentId, projectId, lineage, delegatedFrom },
        projects,
        scratchWorkspaceRoot,
        supported,
      }),
    [projects, scratchWorkspaceRoot, supported, environmentId, projectId, lineage, delegatedFrom],
  );
}

export async function moveThreadToProject(
  thread: EnvironmentThreadShell,
  projectId: ProjectId,
): Promise<void> {
  const title = m(msg("Could not move thread to project"));
  if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
    Dialog.alert(title, m(msg("This connection cannot change threads.")));
    return;
  }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  const result = await runAtomCommand(
    appAtomRegistry,
    projectEnvironment.moveThread,
    {
      environmentId: thread.environmentId,
      input: { threadId: thread.id, projectId },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(title, errorDisplayMessage(error, m) ?? m(msg("Try again.")));
  }
}
