import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  RuntimeRequestId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
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
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { type BrowserMicrophone, listBrowserMicrophones } from "../../speech/browserMicrophones";
import {
  registerVisibleVoicePane,
  talkToFleetController,
  useTalkToFleetLevels,
  useTalkToFleetState,
} from "../../speech/talkToFleetClient";
import { isTalkToFleetWebActive, type TalkToFleetWebPhase } from "../../speech/talkToFleetState";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const WAVEFORM_BARS = [
  { id: "v0", weight: 0.45 },
  { id: "v1", weight: 0.72 },
  { id: "v2", weight: 0.9 },
  { id: "v3", weight: 1.0 },
  { id: "v4", weight: 0.84 },
  { id: "v5", weight: 1.0 },
  { id: "v6", weight: 0.76 },
  { id: "v7", weight: 0.58 },
] as const;

const SYSTEM_DEFAULT_MIC = "__default__";

export interface VoiceSidechatPaneProps {
  readonly threadRef: ScopedThreadRef;
  readonly threadTitle: string;
  readonly visible: boolean;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly onClose: () => void;
}

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

function VoiceSidechatWaveform({
  level,
  active,
  speaking,
}: {
  level: number;
  active: boolean;
  speaking: boolean;
}) {
  const effectiveLevel = active ? Math.max(0.16, level) : 0.1;
  return (
    <div aria-hidden="true" className="flex h-6 items-center gap-0.5">
      {WAVEFORM_BARS.map((bar) => {
        const fraction = Math.min(1, Math.max(0.16, effectiveLevel * bar.weight));
        return (
          <span
            key={bar.id}
            style={{ height: `${Math.round(fraction * 100)}%` }}
            className={cn(
              "w-1 rounded-full transition-[height,background-color] duration-75",
              active ? (speaking ? "bg-primary" : "bg-foreground/75") : "bg-muted-foreground/35",
            )}
          />
        );
      })}
    </div>
  );
}

export function VoiceSidechatPane({
  threadRef,
  threadTitle,
  visible,
  composerDraftTarget,
  onClose,
}: VoiceSidechatPaneProps) {
  const gt = useGT();
  const navigate = useNavigate();
  const state = useTalkToFleetState();
  const levels = useTalkToFleetLevels();
  const { environments } = useEnvironments();
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const respondApprovalCommand = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const [microphones, setMicrophones] = useState<ReadonlyArray<BrowserMicrophone>>([]);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks mounted visible voice pane so the floating overlay yields cleanly
  useEffect(() => {
    if (!visible) return;
    return registerVisibleVoicePane(threadRef.threadId);
  }, [threadRef.threadId, visible]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads browser audio input devices and reacts to hardware hot-plug events
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
  const isCallOnThisThread =
    active &&
    state.environmentId === threadRef.environmentId &&
    state.scopedThreadId === threadRef.threadId;
  const isCallElsewhere = active && !isCallOnThisThread;
  const belongsToThisThread =
    isCallOnThisThread ||
    (!active &&
      (state.scopedThreadId === threadRef.threadId ||
        (state.scopedThreadId === null && state.transcript.length === 0)));

  const visibleTranscript = belongsToThisThread ? state.transcript : [];
  const visibleCards = belongsToThisThread ? state.cards : [];
  const visibleError = belongsToThisThread ? state.error : null;
  const visibleDegraded = belongsToThisThread ? state.degradedSources : [];

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps latest live transcript captions scrolled into view
  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (!el || visibleTranscript.length === 0) return;
    el.scrollTop = el.scrollHeight;
  }, [visibleTranscript.length]);

  const effectivePhase: TalkToFleetWebPhase = belongsToThisThread ? state.phase : "idle";
  const phaseLabel =
    belongsToThisThread && state.statusDetail
      ? state.statusDetail
      : resolvePhaseLabel(gt, effectivePhase);
  const liveLevel = isCallOnThisThread ? Math.max(levels.input, levels.output) : 0;

  const startForThisThread = () => {
    void talkToFleetController.start(threadRef.environmentId, {
      threadId: threadRef.threadId,
      threadTitle,
      mode: "thread",
      openFloatingPanel: false,
    });
  };

  const handleAddToChat = () => {
    if (visibleTranscript.length === 0) return;
    const summaryLines = visibleTranscript.slice(-12).map((item) => {
      const speaker = item.speaker === "you" ? gt("You") : gt("Voice");
      return `- **${speaker}:** ${item.text.trim()}`;
    });
    const note = `${gt("Voice sidechat notes ({title}):", { title: threadTitle })}\n${summaryLines.join("\n")}`;
    const draftStore = useComposerDraftStore.getState();
    const existing = draftStore.getComposerDraft(composerDraftTarget)?.prompt ?? "";
    const trimmedExisting = existing.trimEnd();
    const nextPrompt = trimmedExisting.length > 0 ? `${trimmedExisting}\n\n${note}` : note;
    draftStore.setPrompt(composerDraftTarget, nextPrompt);
    toastManager.add({
      type: "success",
      title: gt("Added voice notes to composer"),
    });
  };

  const selectedMicValue = state.selectedMicrophoneId || SYSTEM_DEFAULT_MIC;
  const selectedMicLabel = state.selectedMicrophoneId
    ? (microphones.find((mic) => mic.deviceId === state.selectedMicrophoneId)?.label ??
      gt("Saved microphone"))
    : gt("Default microphone");

  const otherTargetLabel =
    state.scopedThreadTitle ||
    (state.scopedThreadId
      ? gt("another thread")
      : ((state.environmentId
          ? environments.find((env) => env.environmentId === state.environmentId)?.label
          : null) ?? gt("Talk to Fleet")));

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              isCallOnThisThread
                ? state.phase === "reconnecting"
                  ? "animate-pulse bg-warning"
                  : state.phase === "speaking"
                    ? "animate-pulse bg-primary"
                    : "bg-success"
                : visibleError
                  ? "bg-destructive"
                  : "bg-muted-foreground/40",
            )}
          />
          <AudioLinesIcon className="size-3.5 shrink-0 text-primary" />
          <span className="truncate text-xs font-medium text-foreground">{threadTitle}</span>
          <Badge
            size="sm"
            variant={
              visibleError
                ? "error"
                : isCallOnThisThread && state.phase === "reconnecting"
                  ? "warning"
                  : isCallOnThisThread
                    ? "info"
                    : "secondary"
            }
          >
            {phaseLabel}
          </Badge>
          {visibleDegraded.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs text-warning-foreground">
                    <AlertTriangleIcon className="size-3" />
                  </span>
                }
              />
              <TooltipPopup>
                {gt("Stale sources: {sources}", { sources: visibleDegraded.join(", ") })}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={visibleTranscript.length === 0}
            onClick={handleAddToChat}
          >
            <PlusIcon />
            {gt("Add to chat")}
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={!canOperate}
                  aria-label={gt("Start new voice session")}
                  onClick={() => {
                    if (isCallOnThisThread) {
                      talkToFleetController.newSession();
                    } else {
                      startForThisThread();
                    }
                  }}
                >
                  <RotateCcwIcon />
                </Button>
              }
            />
            <TooltipPopup>{gt("Start new voice session")}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={gt("Close voice sidechat")}
                  onClick={onClose}
                >
                  <XIcon />
                </Button>
              }
            />
            <TooltipPopup>{gt("Close")}</TooltipPopup>
          </Tooltip>
        </div>
      </div>

      {isCallElsewhere ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-accent/35 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 text-foreground">
            {gt("Voice session active on {target}", { target: otherTargetLabel })}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {state.scopedThreadId && state.environmentId ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => {
                  if (!state.scopedThreadId || !state.environmentId) return;
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(
                      scopeThreadRef(state.environmentId, ThreadId.make(state.scopedThreadId)),
                    ),
                  });
                }}
              >
                <ExternalLinkIcon />
                {gt("Jump")}
              </Button>
            ) : null}
            <Button type="button" size="xs" disabled={!canOperate} onClick={startForThisThread}>
              {gt("Switch here")}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/25 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <VoiceSidechatWaveform
            level={liveLevel}
            active={isCallOnThisThread}
            speaking={isCallOnThisThread && state.phase === "speaking"}
          />
          {isCallOnThisThread && state.phase === "speaking" ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => talkToFleetController.interruptAssistant()}
            >
              <HandIcon />
              {gt("Interrupt")}
            </Button>
          ) : (
            <span className="truncate text-2xs text-muted-foreground">
              {isCallOnThisThread
                ? state.muted
                  ? gt("Microphone muted")
                  : gt("Speak naturally anytime. Interrupt to steer.")
                : gt("Talk hands-free with your main session and fleet.")}
            </span>
          )}
        </div>

        <Select
          value={selectedMicValue}
          onValueChange={(value) => {
            const nextId = !value || value === SYSTEM_DEFAULT_MIC ? "" : value;
            void talkToFleetController.setMicrophoneId(nextId);
          }}
        >
          <SelectTrigger size="sm" aria-label={gt("Microphone")} className="h-7 w-36 shrink-0">
            <SelectValue>{selectedMicLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value={SYSTEM_DEFAULT_MIC}>{gt("Default microphone")}</SelectItem>
            {microphones.map((mic) => (
              <SelectItem key={mic.deviceId} value={mic.deviceId}>
                {mic.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <div
        ref={transcriptScrollRef}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
      >
        {visibleError ? (
          <div className="flex items-start justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
            <span className="min-w-0 flex-1">{visibleError}</span>
            <Button
              type="button"
              size="micro"
              variant="outline"
              disabled={!canOperate}
              onClick={startForThisThread}
            >
              {gt("Retry")}
            </Button>
          </div>
        ) : null}

        {visibleCards.length > 0 ? (
          <div className="flex flex-col gap-2">
            {visibleCards.map((card) => {
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
                const targetEnvId = state.environmentId ?? threadRef.environmentId;
                return (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => {
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(
                          scopeThreadRef(targetEnvId, ThreadId.make(card.threadId)),
                        ),
                      });
                    }}
                    className="flex w-full cursor-pointer flex-col gap-1 rounded-xl border border-border bg-card px-3 py-2 text-left text-xs transition-colors hover:bg-accent/50"
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
              const approvalEnvId = state.environmentId ?? threadRef.environmentId;
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
                          if (isCallOnThisThread) {
                            talkToFleetController.respondApproval(
                              card.threadId,
                              card.requestId,
                              "accept",
                            );
                          } else {
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
                          if (isCallOnThisThread) {
                            talkToFleetController.respondApproval(
                              card.threadId,
                              card.requestId,
                              "decline",
                            );
                          } else {
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

        {state.showCaptions && visibleTranscript.length > 0 ? (
          <div className="flex flex-col gap-2">
            {visibleTranscript.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "rounded-xl px-3 py-2 text-xs leading-relaxed",
                  item.speaker === "you"
                    ? "self-end bg-secondary text-foreground"
                    : "self-start border border-border/70 bg-card text-foreground",
                )}
              >
                <p className="mb-0.5 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {item.speaker === "you" ? gt("You") : gt("Fleet")}
                </p>
                <p className="whitespace-pre-wrap">{item.text}</p>
              </div>
            ))}
          </div>
        ) : visibleCards.length === 0 && !visibleError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
            <AudioLinesIcon className="size-7 text-muted-foreground/50" />
            <p className="text-xs font-medium text-foreground">
              {gt("Main-session Voice sidechat")}
            </p>
            <p className="max-w-xs text-2xs leading-relaxed text-muted-foreground">
              {gt(
                "Ask questions, review progress, approve requests, or steer this thread by voice.",
              )}
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="icon-sm"
            variant={state.muted ? "destructive-outline" : "outline"}
            disabled={!isCallOnThisThread}
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
        </div>

        {isCallOnThisThread ? (
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
          <Button type="button" size="sm" disabled={!canOperate} onClick={startForThisThread}>
            <PhoneIcon />
            {gt("Start voice")}
          </Button>
        )}
      </div>
    </div>
  );
}
