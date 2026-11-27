import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { RuntimeRequestId, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import {
  AlertTriangleIcon,
  AudioLinesIcon,
  CaptionsIcon,
  CheckIcon,
  ExternalLinkIcon,
  HandIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  MicIcon,
  MicOffIcon,
  MinusIcon,
  PhoneIcon,
  PhoneOffIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { type BrowserMicrophone, listBrowserMicrophones } from "../../speech/browserMicrophones";
import {
  talkToFleetController,
  useIsVoicePaneVisible,
  useTalkToFleetLevels,
  useTalkToFleetState,
} from "../../speech/talkToFleetClient";
import { isTalkToFleetWebActive, type TalkToFleetWebPhase } from "../../speech/talkToFleetState";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const WAVEFORM_BARS = [
  { id: "b0", weight: 0.45 },
  { id: "b1", weight: 0.72 },
  { id: "b2", weight: 0.9 },
  { id: "b3", weight: 1.0 },
  { id: "b4", weight: 0.85 },
  { id: "b5", weight: 1.0 },
  { id: "b6", weight: 0.78 },
  { id: "b7", weight: 0.62 },
  { id: "b8", weight: 0.42 },
] as const;

function resolvePhaseLabel(gt: ReturnType<typeof useGT>, phase: TalkToFleetWebPhase): string {
  switch (phase) {
    case "connecting":
      return gt("Connecting...");
    case "listening":
      return gt("Listening");
    case "thinking":
      return gt("Thinking...");
    case "speaking":
      return gt("Speaking");
    case "reconnecting":
      return gt("Reconnecting...");
    case "paused":
      return gt("Paused");
    case "ended":
      return gt("Ended");
    case "error":
      return gt("Error");
    case "idle":
      return gt("Ready");
  }
}

function WaveformBars({
  level,
  active,
  speaking,
  compact = false,
}: {
  level: number;
  active: boolean;
  speaking: boolean;
  compact?: boolean;
}) {
  const bars = compact ? WAVEFORM_BARS.slice(2, 7) : WAVEFORM_BARS;
  const effectiveLevel = active ? Math.max(0.14, level) : 0.08;
  return (
    <div
      aria-hidden="true"
      className={cn("flex items-center justify-center", compact ? "h-4 gap-0.5" : "h-9 gap-1")}
    >
      {bars.map((bar) => {
        const fraction = Math.min(1, Math.max(0.14, effectiveLevel * bar.weight));
        return (
          <span
            key={bar.id}
            style={{
              height: `${Math.round(fraction * 100)}%`,
            }}
            className={cn(
              "w-1 rounded-full transition-[height,background-color] duration-75",
              active ? (speaking ? "bg-primary" : "bg-foreground/80") : "bg-muted-foreground/40",
            )}
          />
        );
      })}
    </div>
  );
}

export function TalkToFleetPanel() {
  const gt = useGT();
  const navigate = useNavigate();
  const state = useTalkToFleetState();
  const levels = useTalkToFleetLevels();
  const voicePaneVisible = useIsVoicePaneVisible(state.scopedThreadId);
  const { environments } = useEnvironments();
  const connectedIds = useConnectedEnvironmentIds();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const respondApprovalCommand = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const [microphones, setMicrophones] = useState<ReadonlyArray<BrowserMicrophone>>([]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads browser audio input devices for the microphone selector
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
      void listBrowserMicrophones()
        .then((items) => {
          if (!cancelled) setMicrophones(items);
        })
        .catch(() => {});
    };
    refresh();
    const devices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    devices?.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      devices?.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  const active = isTalkToFleetWebActive(state.phase);
  if (active && state.scopedThreadId !== null && voicePaneVisible) {
    return null;
  }
  if (!state.panelOpen && !active) {
    return null;
  }

  const connectedEnvironments = environments.filter(
    (env) => env.connection.phase === "connected" || connectedIds.includes(env.environmentId),
  );
  const selectedConnected = state.selectedEnvironmentId
    ? connectedEnvironments.find((env) => env.environmentId === state.selectedEnvironmentId)
    : undefined;
  const primaryConnected = primaryEnvironmentId
    ? connectedEnvironments.find((env) => env.environmentId === primaryEnvironmentId)
    : undefined;
  const resolvedEnvironment =
    (state.environmentId
      ? environments.find((env) => env.environmentId === state.environmentId)
      : undefined) ??
    selectedConnected ??
    primaryConnected ??
    connectedEnvironments[0] ??
    null;
  const targetEnvironmentId = state.environmentId ?? resolvedEnvironment?.environmentId ?? null;
  const targetEnvironmentLabel = resolvedEnvironment?.label ?? gt("No environment");

  const level = Math.max(levels.input, levels.output);
  const phaseLabel = state.statusDetail ?? resolvePhaseLabel(gt, state.phase);
  const selectedMicValue = state.selectedMicrophoneId || "__default__";
  const selectedMicLabel = state.selectedMicrophoneId
    ? (microphones.find((mic) => mic.deviceId === state.selectedMicrophoneId)?.label ??
      gt("Saved mic"))
    : gt("Default mic");

  const returnToScopedThread = () => {
    if (!targetEnvironmentId || !state.scopedThreadId) return;
    const ref = scopeThreadRef(targetEnvironmentId, ThreadId.make(state.scopedThreadId));
    useRightPanelStore.getState().open(ref, "voice");
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(ref),
    });
  };

  if (active && (state.minimized || !state.panelOpen)) {
    return (
      <div className="fixed right-4 bottom-4 z-50 [-webkit-app-region:no-drag]">
        <div className="flex items-center gap-2 rounded-full border border-border bg-popover/95 px-3 py-1.5 shadow-lg backdrop-blur-md">
          <span
            className={cn(
              "size-2 rounded-full",
              state.phase === "reconnecting"
                ? "animate-pulse bg-warning"
                : state.phase === "speaking"
                  ? "animate-pulse bg-primary"
                  : "bg-success",
            )}
          />
          <span className="max-w-36 truncate text-xs font-medium text-foreground">
            {state.scopedThreadTitle || phaseLabel}
          </span>
          <WaveformBars
            level={level}
            active={active}
            speaking={state.phase === "speaking"}
            compact
          />
          {state.scopedThreadId && targetEnvironmentId ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Return to active thread voice sidechat")}
              onClick={returnToScopedThread}
            >
              <ExternalLinkIcon />
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-xs"
            variant={state.muted ? "destructive-outline" : "ghost"}
            aria-label={state.muted ? gt("Unmute microphone") : gt("Mute microphone")}
            onClick={() => talkToFleetController.toggleMute()}
          >
            {state.muted ? <MicOffIcon /> : <MicIcon />}
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Expand Talk to Fleet")}
            onClick={() => {
              if (!state.panelOpen) {
                talkToFleetController.openPanel();
              } else {
                talkToFleetController.toggleMinimize();
              }
            }}
          >
            <Maximize2Icon />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="destructive"
            aria-label={gt("End call")}
            onClick={() => talkToFleetController.stop()}
          >
            <PhoneOffIcon />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <aside
      aria-label={gt("Talk to Fleet")}
      className="fixed right-4 bottom-4 z-50 flex max-h-[min(36rem,calc(100dvh-2rem))] w-[23rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-popover/95 shadow-xl backdrop-blur-md [-webkit-app-region:no-drag]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <AudioLinesIcon className="size-4 shrink-0 text-primary" />
          <span className="truncate text-sm font-semibold text-foreground">
            {gt("Talk to Fleet")}
          </span>
          <Badge
            size="sm"
            variant={
              state.phase === "error"
                ? "error"
                : state.phase === "reconnecting"
                  ? "warning"
                  : active
                    ? "info"
                    : "secondary"
            }
          >
            {phaseLabel}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {active ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              aria-label={gt("Minimize Talk to Fleet")}
              onClick={() => talkToFleetController.toggleMinimize()}
            >
              <MinusIcon />
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Close Talk to Fleet")}
            onClick={() => talkToFleetController.closePanel()}
          >
            <XIcon />
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3.5 py-2">
        {connectedEnvironments.length > 1 && !active ? (
          <Select
            value={targetEnvironmentId ?? ""}
            onValueChange={(value) => {
              if (value) {
                talkToFleetController.setSelectedEnvironmentId(value as EnvironmentId);
              }
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Environment")} className="h-7 min-w-0 flex-1">
              <SelectValue>{targetEnvironmentLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {connectedEnvironments.map((env) => (
                <SelectItem key={env.environmentId} value={env.environmentId}>
                  {env.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {targetEnvironmentLabel}
          </span>
        )}
        <Select
          value={selectedMicValue}
          onValueChange={(value) => {
            const nextId = !value || value === "__default__" ? "" : value;
            void talkToFleetController.setMicrophoneId(nextId);
          }}
        >
          <SelectTrigger size="sm" aria-label={gt("Microphone")} className="h-7 w-32 shrink-0">
            <SelectValue>{selectedMicLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="__default__">{gt("Default mic")}</SelectItem>
            {microphones.map((mic) => (
              <SelectItem key={mic.deviceId} value={mic.deviceId}>
                {mic.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {state.degradedSources.length > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-warning-foreground">
            <AlertTriangleIcon className="size-3" />
            {gt("Stale: {sources}", { sources: state.degradedSources.join(", ") })}
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3">
        <div className="flex flex-col items-center justify-center rounded-xl border border-border/60 bg-background/60 px-3 py-3">
          <WaveformBars level={level} active={active} speaking={state.phase === "speaking"} />
          <div className="mt-1.5 flex items-center gap-2">
            <p className="text-center text-xs text-muted-foreground">
              {active
                ? state.muted
                  ? gt("Microphone muted")
                  : gt("Speak naturally anytime. Interrupt to steer.")
                : state.phase === "ended"
                  ? gt("Session ended")
                  : gt("Start a hands-free voice session with Fleet.")}
            </p>
            {active && state.phase === "speaking" ? (
              <Button
                type="button"
                size="micro"
                variant="outline"
                onClick={() => talkToFleetController.interruptAssistant()}
              >
                <HandIcon />
                {gt("Interrupt")}
              </Button>
            ) : null}
          </div>
        </div>

        {state.error ? (
          <div className="flex items-start justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
            <span className="min-w-0 flex-1">{state.error}</span>
            {targetEnvironmentId ? (
              <Button
                type="button"
                size="micro"
                variant="outline"
                onClick={() => void talkToFleetController.start(targetEnvironmentId)}
              >
                {gt("Retry")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {state.cards.length > 0 ? (
          <div className="flex flex-col gap-2">
            {state.cards.map((card) => {
              if (card.kind === "tool") {
                return (
                  <div
                    key={card.id}
                    className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 text-xs"
                  >
                    {card.status === "running" ? (
                      <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : card.status === "error" ? (
                      <AlertTriangleIcon className="size-3.5 shrink-0 text-destructive" />
                    ) : (
                      <CheckIcon className="size-3.5 shrink-0 text-success" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">{card.title}</p>
                      {card.detail ? (
                        <p className="truncate text-2xs text-destructive-foreground">
                          {card.detail}
                        </p>
                      ) : card.sourceAge ? (
                        <p className="truncate text-2xs text-muted-foreground">
                          {gt("Checked {age}", { age: card.sourceAge })}
                        </p>
                      ) : null}
                    </div>
                  </div>
                );
              }

              if (card.kind === "thread") {
                const threadEnvId = state.environmentId ?? targetEnvironmentId;
                return (
                  <button
                    key={card.id}
                    type="button"
                    disabled={!threadEnvId}
                    onClick={() => {
                      if (!threadEnvId) return;
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(
                          scopeThreadRef(threadEnvId, ThreadId.make(card.threadId)),
                        ),
                      });
                    }}
                    className="flex w-full cursor-pointer flex-col gap-1 rounded-xl border border-border bg-card px-3 py-2 text-left text-xs transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold text-foreground">{card.title}</span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-2xs uppercase text-muted-foreground">
                        {card.status}
                        <ExternalLinkIcon className="size-3" />
                      </span>
                    </div>
                    {card.summary ? (
                      <p className="line-clamp-2 text-2xs text-muted-foreground">{card.summary}</p>
                    ) : null}
                  </button>
                );
              }

              const isPending = card.status === "pending";
              const approvalEnvId = state.environmentId ?? targetEnvironmentId;
              return (
                <div
                  key={card.id}
                  className="flex flex-col gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs"
                >
                  <p className="truncate font-semibold text-foreground">{card.threadTitle}</p>
                  <p className="line-clamp-2 text-2xs text-muted-foreground">{card.summary}</p>
                  {isPending ? (
                    <div className="flex gap-2 pt-1">
                      <Button
                        type="button"
                        size="compact"
                        className="flex-1"
                        onClick={() => {
                          if (active) {
                            talkToFleetController.respondApproval(
                              card.threadId,
                              card.requestId,
                              "accept",
                            );
                          } else if (approvalEnvId) {
                            void respondApprovalCommand({
                              environmentId: approvalEnvId,
                              input: {
                                threadId: ThreadId.make(card.threadId),
                                requestId: RuntimeRequestId.make(card.requestId),
                                decision: "accept",
                              },
                            });
                          }
                        }}
                      >
                        {gt("Approve")}
                      </Button>
                      <Button
                        type="button"
                        size="compact"
                        variant="secondary"
                        className="flex-1"
                        onClick={() => {
                          if (active) {
                            talkToFleetController.respondApproval(
                              card.threadId,
                              card.requestId,
                              "decline",
                            );
                          } else if (approvalEnvId) {
                            void respondApprovalCommand({
                              environmentId: approvalEnvId,
                              input: {
                                threadId: ThreadId.make(card.threadId),
                                requestId: RuntimeRequestId.make(card.requestId),
                                decision: "decline",
                              },
                            });
                          }
                        }}
                      >
                        {gt("Decline")}
                      </Button>
                    </div>
                  ) : (
                    <span className="text-2xs font-medium text-muted-foreground">
                      {card.status === "approved" ? gt("Approved") : gt("Declined")}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}

        {state.showCaptions && state.transcript.length > 0 ? (
          <div className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-background/50 p-2.5">
            {state.transcript.slice(-6).map((item) => (
              <p
                key={item.id}
                className={cn(
                  "text-xs leading-relaxed",
                  item.speaker === "you" ? "text-muted-foreground" : "text-foreground",
                )}
              >
                <span className="mr-1.5 font-semibold">
                  {item.speaker === "you" ? gt("You:") : gt("Fleet:")}
                </span>
                {item.text}
              </p>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border/70 px-3.5 py-2.5">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant={state.muted ? "destructive-outline" : "outline"}
            disabled={!active}
            aria-label={state.muted ? gt("Unmute microphone") : gt("Mute microphone")}
            onClick={() => talkToFleetController.toggleMute()}
          >
            {state.muted ? <MicOffIcon /> : <MicIcon />}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant={state.showCaptions ? "secondary" : "outline"}
            aria-label={state.showCaptions ? gt("Hide captions") : gt("Show captions")}
            onClick={() => talkToFleetController.toggleCaptions()}
          >
            <CaptionsIcon />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            disabled={!targetEnvironmentId}
            aria-label={gt("Start new session")}
            onClick={() => talkToFleetController.newSession()}
          >
            <RotateCcwIcon />
          </Button>
        </div>

        {active ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => talkToFleetController.stop()}
          >
            <PhoneOffIcon />
            {gt("End call")}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={!targetEnvironmentId}
            onClick={() => {
              if (targetEnvironmentId) {
                void talkToFleetController.start(targetEnvironmentId);
              }
            }}
          >
            <PhoneIcon />
            {gt("Start call")}
          </Button>
        )}
      </div>
    </aside>
  );
}
