import {
  type EnvironmentId,
  type FleetPanelActionInput,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useGT } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import type { ComposerThreadTarget } from "../../../composerDraftStore";
import { useThreadActions } from "../../../hooks/useThreadActions";
import { appendToComposerPrompt, fleetPanelEnvironment } from "../../../state/fleetPanel";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { ThreadDetailsControl } from "../ThreadDetailsControl";
import { ThreadDetailsSection } from "../ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../threadDetailsPanelStyles";
import type { ThreadDetailsVisibility } from "../threadDetailsItems";
import { BrowneEngineSection } from "./BrowneEngineSection";
import { FleetPulseSection } from "./FleetPulseSection";
import { LibrarianSection } from "./LibrarianSection";
import { MailBridgeSection } from "./MailBridgeSection";
import { OpenBotSection } from "./OpenBotSection";
import { PlanAnchorSection } from "./PlanAnchorSection";
import { RvbTraySection } from "./RvbTraySection";

export interface ThreadFleetPanelsProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly projectName?: string | undefined;
  readonly threadTitle?: string | undefined;
  readonly gitCwd: string | null;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly visible: ThreadDetailsVisibility;
  readonly onComposerFocusRequest: () => void;
}

export function ThreadFleetPanels(props: ThreadFleetPanelsProps) {
  const gt = useGT();
  const [mailQuery, setMailQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const { settleThread } = useThreadActions();

  const anyVisible =
    props.visible.fleetPulse ||
    props.visible.planAnchor ||
    props.visible.mailBridge ||
    props.visible.librarian ||
    props.visible.openbots ||
    props.visible.browneEngine ||
    props.visible.rvbTray;

  const query = useEnvironmentQuery(
    anyVisible
      ? fleetPanelEnvironment.context({
          environmentId: props.environmentId,
          input: {
            threadId: props.threadId,
            projectId: props.projectId,
            ...(props.projectName ? { projectName: props.projectName } : {}),
            ...(props.threadTitle ? { threadTitle: props.threadTitle } : {}),
            ...(props.gitCwd ? { workspaceRoot: props.gitCwd } : {}),
            ...(mailQuery.trim() ? { query: mailQuery.trim() } : {}),
          },
        })
      : null,
  );

  const runFleetAction = useAtomCommand(fleetPanelEnvironment.action, {
    label: "fleet-panel:action",
  });

  if (!anyVisible || !query.data) {
    return null;
  }

  if (query.data.status !== "ready") {
    return (
      <div data-thread-fleet-panels="">
        <ThreadDetailsSection
          headingId="thread-details-fleet-status-heading"
          title={gt("Browne Fleet")}
          separated
          actions={
            <ThreadDetailsControl
              size="icon-xs"
              variant="ghost"
              part="icon"
              onClick={query.refresh}
              aria-label={gt("Refresh Fleet panel")}
            >
              <RefreshCwIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            </ThreadDetailsControl>
          }
        >
          <div className="px-2 pb-1 text-2xs text-muted-foreground">{query.data.note}</div>
        </ThreadDetailsSection>
      </div>
    );
  }

  const ctx = query.data.data;
  const activeThreadRef = scopeThreadRef(props.environmentId, props.threadId);

  const injectPrompt = (text: string) => {
    appendToComposerPrompt(props.composerDraftTarget, text);
    props.onComposerFocusRequest();
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: gt("Added to composer prompt"),
      }),
    );
  };

  const dispatchAction = async (
    input: FleetPanelActionInput,
    options?: { readonly refreshAfter?: boolean },
  ) => {
    setBusy(true);
    try {
      const res = await runFleetAction({
        environmentId: props.environmentId,
        input,
      });
      if (res._tag === "Success") {
        const payload = res.value;
        if (payload.injectText) {
          appendToComposerPrompt(props.composerDraftTarget, payload.injectText);
          props.onComposerFocusRequest();
        }
        if (payload.copyText) {
          void navigator.clipboard?.writeText(payload.copyText).catch(() => undefined);
        }
        toastManager.add(
          stackedThreadToast({
            type: payload.ok ? "info" : "warning",
            title: payload.message,
          }),
        );
        if (options?.refreshAfter !== false) {
          query.refresh();
        }
        return payload.ok;
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-thread-fleet-panels="" className="flex flex-col">
      {props.visible.fleetPulse ? (
        <FleetPulseSection
          data={ctx.fleet}
          busy={busy}
          onInjectText={injectPrompt}
          onAttachScreen={() =>
            void dispatchAction({ kind: "attachFleet", target: "screen" }, { refreshAfter: false })
          }
          onAttachPath={(target, filePath) =>
            void dispatchAction(
              { kind: "attachFleet", target, path: filePath },
              { refreshAfter: false },
            )
          }
        />
      ) : null}

      {props.visible.planAnchor ? (
        <PlanAnchorSection
          data={ctx.plan}
          busy={busy}
          onInjectText={injectPrompt}
          onLogWaiting={async ({ title, owner }) => {
            await dispatchAction({
              kind: "logWaiting",
              threadId: props.threadId,
              title,
              ...(owner ? { owner } : {}),
            });
          }}
        />
      ) : null}

      {props.visible.mailBridge ? (
        <MailBridgeSection
          data={ctx.mail}
          busy={busy}
          onSearch={(nextQuery) => {
            setMailQuery(nextQuery);
            query.refresh();
          }}
          onFetchAndInject={(searchQuery, messageId) =>
            void dispatchAction(
              { kind: "fetchMailBody", query: searchQuery, messageId },
              { refreshAfter: false },
            )
          }
          onOpenGodwit={() => void dispatchAction({ kind: "openGodwit" }, { refreshAfter: false })}
        />
      ) : null}

      {props.visible.librarian ? (
        <LibrarianSection
          data={ctx.librarian}
          busy={busy}
          onInjectText={injectPrompt}
          onCommitFact={async (fact, factKind) => {
            await dispatchAction({
              kind: "commitLibrarian",
              threadId: props.threadId,
              fact,
              factKind,
            });
          }}
        />
      ) : null}

      {props.visible.openbots ? (
        <OpenBotSection
          data={ctx.openbots}
          busy={busy}
          onToggleFreeze={(frozen) => void dispatchAction({ kind: "toggleBotFreeze", frozen })}
          onHandoffBot={async (botId, botName, goal) => {
            await dispatchAction(
              {
                kind: "handoffBot",
                threadId: props.threadId,
                botId,
                botName,
                goal,
              },
              { refreshAfter: false },
            );
          }}
        />
      ) : null}

      {props.visible.browneEngine ? (
        <BrowneEngineSection
          data={ctx.browne}
          busy={busy}
          onLaunchCli={(model) =>
            void dispatchAction(
              {
                kind: "launchRealCli",
                model,
                ...(props.threadTitle ? { threadTitle: props.threadTitle } : {}),
                ...(props.gitCwd ? { cwd: props.gitCwd } : {}),
              },
              { refreshAfter: false },
            )
          }
          onRollShackle={() =>
            void dispatchAction(
              { kind: "rollShackleHint", threadId: props.threadId },
              { refreshAfter: false },
            )
          }
        />
      ) : null}

      {props.visible.rvbTray ? (
        <RvbTraySection
          data={ctx.tray}
          busy={busy}
          defaultSummary={props.threadTitle ?? props.projectName ?? gt("Thread decision")}
          onDecideItem={(itemId, decision) =>
            void dispatchAction({
              kind: "decideTrayItem",
              threadId: props.threadId,
              itemId,
              decision,
            })
          }
          onCopyText={(text) => {
            void navigator.clipboard?.writeText(text).catch(() => undefined);
            toastManager.add(
              stackedThreadToast({
                type: "info",
                title: gt("Copied to clipboard"),
              }),
            );
          }}
          onLockAndSettle={async (summary) => {
            const locked = await dispatchAction({
              kind: "lockDecisionAndSettle",
              threadId: props.threadId,
              summary,
            });
            if (locked) {
              await settleThread(activeThreadRef);
            }
          }}
        />
      ) : null}
    </div>
  );
}
