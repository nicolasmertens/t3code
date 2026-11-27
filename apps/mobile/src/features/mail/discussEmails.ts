import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  type DiscussEmailsScope,
  type EnvironmentId,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { findStackRoute } from "../../lib/appLinking";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { fleetPanelEnvironment } from "../../state/fleetPanel";
import { projectEnvironment } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { enqueueThreadOutboxMessage, type QueuedThreadMessage } from "../../state/thread-outbox";
import { environmentThreadShells } from "../../state/threads";
import {
  createNewTaskDraft,
  getStickyComposerModelSelectionSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { workspaceConnections } from "../../state/workspace";
import { selectWorkspaceDetail } from "../layout/workspace/workspace-detail-selection";
import {
  latestThreadEnvironmentIds,
  promptLinkScratchEnvironmentId,
} from "../prompt-links/prompt-link-model";
import { submittedThreadParams } from "../threads/thread-route-state";
import { resolveNewThreadRuntimeMode } from "../threads/thread-settings-options";

const NEW_TASK_ROUTE = "NewTaskProject";
const DEFAULT_DISCUSS_EMAILS_TITLE = "Discuss emails";

export const discussEmailsLaunchingAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:discuss-emails-launching"),
);

export function buildFallbackDiscussEmailsPrompt(scope: DiscussEmailsScope = "core"): string {
  const scopeNote =
    scope === "core"
      ? "Focus on Nick's core accounts (nicolas@mrtns.io, nicolas@nicolasmertens.com, nick@mrtns.us, nicolas@stylecom.be)."
      : "Check all configured accounts in Godwit (including mubotoys.com and peopleand.tech).";

  return [
    "Fetch Nick's most urgent and important emails right now so we can triage and discuss them.",
    "",
    scopeNote,
    "- Check live mail on `maxbook` via `/Applications/Godwit.app/Contents/MacOS/Godwit call` (`ListAccounts`, `SavedViews` -> `To handle` `ViewContents`, `ListThreads` unified inbox) plus recent `~/system-architecture/data/mail/triage/decisions.jsonl`, falling back to `~/dev/40-bin/postroom-search --json` if Godwit is closed, and open mail/waiting loops in `/srv/journal/planner/primary/now.json` on `journal`.",
    "- Open with a crisp, mobile-scannable briefing grouped into **Urgent / Act now**, **Needs your decision**, and **Follow-ups (incl. Victor candidates)**, then ask Nick which item(s) to open or draft.",
    "- Follow `~/.agents/skills/nick-email/SKILL.md`, `~/.grok/rules/mail-stalwart-client.md`, `~/.grok/rules/mail-from-aliases.md`, and `~/.grok/rules/mail-follow-up-owned.md`: read-only on launch, drafts only in chat + Godwit/Postroom Drafts, and never send email without Nick's explicit instruction in this thread.",
  ].join("\n");
}

function resolveScratchEnvironmentId(preferred?: EnvironmentId): EnvironmentId | null {
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

  if (preferred && scratchEnvironmentIds.includes(preferred)) {
    return preferred;
  }

  return promptLinkScratchEnvironmentId(
    latestThreadEnvironmentIds(appAtomRegistry.get(environmentThreadShells.threadShellsAtom)),
    scratchEnvironmentIds,
  );
}

function resolveInstantModelAndRuntime(
  environmentId: EnvironmentId,
  project: EnvironmentProject,
): {
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
} {
  const serverConfig = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  const modelOptions = buildModelOptions(serverConfig, null, undefined, project.id);
  const modelSelection = resolveNewTaskModelSelection({
    draftSelection: null,
    projectDefaultSelection: resolveDefaultableModelSelection(
      serverConfig,
      project.defaultModelSelection ?? null,
      project.id,
    ),
    stickySelection: resolveDefaultableModelSelection(
      serverConfig,
      getStickyComposerModelSelectionSnapshot(),
      project.id,
    ),
    modelOptions,
  });
  const runtimeMode = resolveNewThreadRuntimeMode(
    undefined,
    serverConfig?.settings?.defaultRuntimeMode ?? DEFAULT_RUNTIME_MODE,
    serverConfig?.managedPolicy,
  );
  return { modelSelection, runtimeMode };
}

async function openDraftWithPrompt(
  project: EnvironmentProject,
  title: string,
  prompt: string,
): Promise<boolean> {
  try {
    await waitForComposerDraftsLoaded();
  } catch {
    Dialog.alert(
      m(msg("Could not discuss emails")),
      m(msg("Saved drafts could not be loaded. Try again.")),
    );
    return false;
  }

  const draftId = createNewTaskDraft({
    environmentId: project.environmentId,
    projectId: project.id,
  });
  setComposerDraftText(draftId, prompt);
  rootNavigationRef.dispatch(
    selectWorkspaceDetail({
      name: "Thread",
      params: {
        draft: {
          environmentId: String(project.environmentId),
          projectId: String(project.id),
          draftId,
          title,
        },
      },
    }),
  );
  return true;
}

async function enqueueAndOpenDiscussEmailsThread(input: {
  readonly project: EnvironmentProject;
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}): Promise<boolean> {
  const metadata = makeTurnCommandMetadata();
  const message: QueuedThreadMessage = {
    environmentId: input.project.environmentId,
    threadId: ThreadId.make(metadata.threadId),
    messageId: MessageId.make(metadata.messageId),
    commandId: CommandId.make(metadata.commandId),
    text: input.prompt,
    attachments: [],
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    creation: {
      projectId: input.project.id,
      projectTitle: input.project.title,
      projectCwd: input.project.workspaceRoot,
      title: input.title,
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
    },
    createdAt: metadata.createdAt,
  };
  await enqueueThreadOutboxMessage(message);
  rootNavigationRef.dispatch(
    selectWorkspaceDetail({
      name: "Thread",
      params: submittedThreadParams(String(input.project.environmentId), String(message.threadId)),
    }),
  );
  return true;
}

async function startThreadWithPrompt(input: {
  readonly project: EnvironmentProject;
  readonly title: string;
  readonly prompt: string;
  readonly draftOnly: boolean;
}): Promise<boolean> {
  await waitForComposerDraftsLoaded().catch(() => undefined);
  const { modelSelection, runtimeMode } = resolveInstantModelAndRuntime(
    input.project.environmentId,
    input.project,
  );
  if (input.draftOnly || modelSelection === null) {
    return openDraftWithPrompt(input.project, input.title, input.prompt);
  }
  return enqueueAndOpenDiscussEmailsThread({
    project: input.project,
    title: input.title,
    prompt: input.prompt,
    modelSelection,
    runtimeMode,
  });
}

export async function launchDiscussEmails(options?: {
  readonly environmentId?: EnvironmentId;
  readonly draftOnly?: boolean;
  readonly scope?: DiscussEmailsScope;
  readonly fromNewTaskRoute?: boolean;
}): Promise<boolean> {
  if (appAtomRegistry.get(discussEmailsLaunchingAtom)) {
    return false;
  }

  const scope: DiscussEmailsScope = options?.scope === "all" ? "all" : "core";
  const draftOnly = options?.draftOnly === true;

  appAtomRegistry.set(discussEmailsLaunchingAtom, true);
  try {
    const environmentId = resolveScratchEnvironmentId(options?.environmentId);
    if (environmentId === null) {
      Dialog.alert(
        m(msg("Could not discuss emails")),
        m(msg("No connected environment offers threads without a project.")),
      );
      return false;
    }

    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      Dialog.alert(
        m(msg("Could not discuss emails")),
        m(msg("This device does not have permission to start threads on that machine.")),
      );
      return false;
    }

    const [scratchResult, preparedResult] = await Promise.all([
      runAtomCommand(
        appAtomRegistry,
        projectEnvironment.openScratch,
        { environmentId, input: {} },
        { reportFailure: false },
      ),
      runAtomCommand(
        appAtomRegistry,
        fleetPanelEnvironment.prepareDiscussEmails,
        { environmentId, input: { scope } },
        { reportFailure: false },
      ),
      waitForComposerDraftsLoaded().catch(() => undefined),
    ]);

    if (
      options?.fromNewTaskRoute &&
      findStackRoute(rootNavigationRef.getRootState(), NEW_TASK_ROUTE)?.focused !== true
    ) {
      return false;
    }

    if (scratchResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(scratchResult)) {
        const error = squashAtomCommandFailure(scratchResult);
        Dialog.alert(
          m(msg("Could not discuss emails")),
          error instanceof Error
            ? (errorDisplayMessage(error, m) ?? error.message)
            : m(msg("The folder for threads without a project could not be created.")),
        );
      }
      return false;
    }

    const project = scratchResult.value;

    if (preparedResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(preparedResult)) {
        const error = squashAtomCommandFailure(preparedResult);
        const detail =
          error instanceof Error
            ? (errorDisplayMessage(error, m) ?? error.message)
            : m(msg("Could not preload your email digest from the server."));
        Dialog.alert(m(msg("Could not preload emails")), detail, [
          { text: m(msg("Cancel")), style: "cancel" },
          {
            text: m(msg("Start anyway")),
            onPress: () => {
              void startThreadWithPrompt({
                project,
                title: DEFAULT_DISCUSS_EMAILS_TITLE,
                prompt: buildFallbackDiscussEmailsPrompt(scope),
                draftOnly,
              });
            },
          },
        ]);
      }
      return false;
    }

    return await startThreadWithPrompt({
      project,
      title: preparedResult.value.title || DEFAULT_DISCUSS_EMAILS_TITLE,
      prompt: preparedResult.value.prompt,
      draftOnly,
    });
  } finally {
    appAtomRegistry.set(discussEmailsLaunchingAtom, false);
  }
}
