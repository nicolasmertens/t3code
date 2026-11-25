import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { MessageSquareDashedIcon, PlusIcon, ServerIcon } from "lucide-react";
import { useState } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useScratchProject } from "../hooks/useScratchProject";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { Spinner } from "./ui/spinner";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function NoProjectsHero() {
  const gt = useGT();
  const navigate = useNavigate();
  const contentArea = workspaceAreaProps("home", 1, gt("Home"));
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const scratchTargetEnvironmentId = scratchEnvironmentId(primaryEnvironmentId);
  const [startingLocal, setStartingLocal] = useState(false);

  const hasConnectedEnvironment = environments.some(
    (environment) => environment.connection.phase === "connected",
  );
  const showServerSetup = isReady && !hasConnectedEnvironment;
  const setLocalEnabled = window.desktopBridge?.setLocalEnvironmentEnabled;
  const canStartLocalServer = Boolean(setLocalEnabled && isLocalEnvironmentDisabled());

  const handleStartLocalServer = async () => {
    if (!setLocalEnabled || startingLocal) return;
    setStartingLocal(true);
    try {
      await setLocalEnabled(true);
    } catch {
      setStartingLocal(false);
    }
  };

  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <Empty size="hero" className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              {showServerSetup ? (
                <>
                  <EmptyTitle>
                    <T>No server connected</T>
                  </EmptyTitle>
                  <EmptyDescription>
                    {canStartLocalServer
                      ? gt(
                          "Connect to a remote server or start the local server on this computer to get started.",
                        )
                      : gt("Connect to a server to start your first thread.")}
                  </EmptyDescription>
                  <div className="mt-6 flex justify-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => void navigate({ to: "/settings/connections" })}
                    >
                      <ServerIcon className="size-4" />
                      <T>Connect to a server</T>
                    </Button>
                    {canStartLocalServer ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={startingLocal}
                        onClick={() => void handleStartLocalServer()}
                      >
                        {startingLocal ? (
                          <>
                            <Spinner size="sm" />
                            <T>Starting…</T>
                          </>
                        ) : (
                          <T>Start local server</T>
                        )}
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <EmptyTitle>
                    <T>What should we work on?</T>
                  </EmptyTitle>
                  <EmptyDescription>
                    {scratchTargetEnvironmentId === null
                      ? gt("Add a project to start your first thread.")
                      : gt("Add a project, or start without one.")}
                  </EmptyDescription>
                  <div className="mt-6 flex justify-center gap-2">
                    <Button size="sm" onClick={() => openCommandPalette({ open: "add-project" })}>
                      <PlusIcon className="size-4" />
                      <T>Add project</T>
                    </Button>
                    {scratchTargetEnvironmentId === null ? null : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void startScratchThread(scratchTargetEnvironmentId)}
                      >
                        <MessageSquareDashedIcon className="size-4" />
                        <T>Start without a project</T>
                      </Button>
                    )}
                  </div>
                </>
              )}
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
