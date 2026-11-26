import { getEnvironmentTalkToFleetStreamUrl } from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  TALK_TO_FLEET_FRAME_CLIENT_AUDIO,
  TALK_TO_FLEET_FRAME_SERVER_AUDIO,
  TALK_TO_FLEET_OUTPUT_SAMPLE_RATE,
  TalkToFleetServerEvent,
  decodeTalkToFleetAudioFrame,
  encodeTalkToFleetAudioFrame,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";
import { useSyncExternalStore } from "react";

import { m } from "../i18n/messages";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import { chooseRecordingMicrophone } from "./browserMicrophones";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";
import {
  TALK_TO_FLEET_WEB_GIVE_UP_MS,
  TALK_TO_FLEET_WEB_RECONNECT_DELAYS_MS,
  type TalkToFleetWebState,
  createInitialTalkToFleetWebState,
  isTalkToFleetWebActive,
  reduceTalkToFleetWebEvent,
} from "./talkToFleetState";
import talkToFleetWorkletUrl from "./talkToFleetWorklet.ts?worker&url";

const STORAGE_CAPTIONS_KEY = "t3.talkToFleet.showCaptions";
const STORAGE_ENV_KEY = "t3.talkToFleet.selectedEnvironmentId";
const decodeServerEvent = Schema.decodeUnknownSync(Schema.fromJsonString(TalkToFleetServerEvent));

function readStorageString(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageString(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Storage access can throw under sandboxed frames or private browsing quotas.
  }
}

function readInitialCaptions(): boolean {
  const raw = readStorageString(STORAGE_CAPTIONS_KEY);
  return raw === null ? true : raw !== "0";
}

function readInitialEnvironmentId(): EnvironmentId | null {
  const raw = readStorageString(STORAGE_ENV_KEY);
  return raw && raw.trim().length > 0 ? (raw as EnvironmentId) : null;
}

function createPlaybackAudioContext(): AudioContext {
  try {
    return new AudioContext({
      sampleRate: TALK_TO_FLEET_OUTPUT_SAMPLE_RATE,
      latencyHint: "interactive",
    });
  } catch {
    return new AudioContext({ latencyHint: "interactive" });
  }
}

async function openVoiceMicrophone(microphoneId: string): Promise<MediaStream> {
  const voiceProcessing: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
  };
  const preferred: MediaStreamConstraints = {
    audio: microphoneId
      ? { ...voiceProcessing, deviceId: { exact: microphoneId } }
      : voiceProcessing,
  };
  try {
    return await navigator.mediaDevices.getUserMedia(preferred);
  } catch (error) {
    const name = typeof error === "object" && error !== null && "name" in error ? error.name : "";
    if (!microphoneId || (name !== "OverconstrainedError" && name !== "NotFoundError")) {
      throw error;
    }
    return navigator.mediaDevices.getUserMedia({ audio: voiceProcessing });
  }
}

function createTalkToFleetController() {
  let state: TalkToFleetWebState = createInitialTalkToFleetWebState({
    showCaptions: readInitialCaptions(),
    selectedEnvironmentId: readInitialEnvironmentId(),
  });
  const listeners = new Set<() => void>();

  let socket: WebSocket | null = null;
  let captureStream: MediaStream | null = null;
  let captureContext: AudioContext | null = null;
  let captureSource: MediaStreamAudioSourceNode | null = null;
  let captureWorklet: AudioWorkletNode | null = null;
  let captureSilenceGain: GainNode | null = null;
  let playbackContext: AudioContext | null = null;
  const activePlaybackSources = new Set<AudioBufferSourceNode>();
  let nextPlayTime = 0;
  let clientSpeakingReported = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let disconnectedAtMs: number | null = null;
  let intentionalStop = false;
  let activeRunSequence = 0;

  const setState = (next: TalkToFleetWebState) => {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const sendControl = (payload: Record<string, unknown>) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  const reportSpeaking = (speaking: boolean) => {
    if (clientSpeakingReported === speaking) return;
    clientSpeakingReported = speaking;
    sendControl({ type: "playback_state", speaking, route: "Speaker" });
  };

  const flushPlayback = () => {
    for (const source of activePlaybackSources) {
      try {
        source.onended = null;
        source.stop(0);
      } catch {
        // Source may already have stopped.
      }
      try {
        source.disconnect();
      } catch {
        // Ignore disconnect errors on already-released nodes.
      }
    }
    activePlaybackSources.clear();
    nextPlayTime = 0;
    reportSpeaking(false);
    if (state.outputLevel !== 0) {
      setState({ ...state, outputLevel: 0 });
    }
  };

  const teardownSocketOnly = () => {
    clearReconnectTimer();
    const ws = socket;
    socket = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "client_close");
      }
    }
  };

  const teardownAudio = () => {
    flushPlayback();
    if (captureWorklet) {
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
        captureWorklet.port.postMessage("stop");
        captureWorklet.port.onmessage = null;
        captureWorklet.port.close();
        captureWorklet.disconnect();
      } catch {
        // Ignore already-stopped worklets.
      }
      captureWorklet = null;
    }
    if (captureSilenceGain) {
      try {
        captureSilenceGain.disconnect();
      } catch {
        // Ignore.
      }
      captureSilenceGain = null;
    }
    if (captureSource) {
      try {
        captureSource.disconnect();
      } catch {
        // Ignore.
      }
      captureSource = null;
    }
    if (captureStream) {
      for (const track of captureStream.getTracks()) {
        track.stop();
      }
      captureStream = null;
    }
    if (captureContext) {
      const ctx = captureContext;
      captureContext = null;
      void ctx.close().catch(() => {});
    }
    if (playbackContext) {
      const ctx = playbackContext;
      playbackContext = null;
      void ctx.close().catch(() => {});
    }
    if (state.inputLevel !== 0 || state.outputLevel !== 0) {
      setState({ ...state, inputLevel: 0, outputLevel: 0 });
    }
  };

  const handleServerAudioBytes = (bytes: Uint8Array) => {
    const frame = decodeTalkToFleetAudioFrame(bytes);
    if (!frame || frame.kind !== TALK_TO_FLEET_FRAME_SERVER_AUDIO) return;
    if (frame.turnId < state.activeTurnId) return;

    const sampleCount = Math.floor(frame.pcm.byteLength / 2);
    if (sampleCount <= 0) return;

    const ctx = playbackContext;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }

    const view = new DataView(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength);
    const floats = new Float32Array(sampleCount);
    let energy = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const s = view.getInt16(i * 2, true) / 32_768;
      floats[i] = s;
      energy += s * s;
    }
    const rmsLevel = Math.min(1, Math.sqrt(energy / sampleCount) * 4);

    const buffer = ctx.createBuffer(1, sampleCount, TALK_TO_FLEET_OUTPUT_SAMPLE_RATE);
    buffer.copyToChannel(floats, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    // Leave a 40 ms jitter buffer when starting playback from idle or after an underrun.
    const startTime = nextPlayTime <= now + 0.005 ? now + 0.04 : nextPlayTime;
    nextPlayTime = startTime + buffer.duration;

    activePlaybackSources.add(source);
    reportSpeaking(true);
    setState({ ...state, outputLevel: rmsLevel });

    source.onended = () => {
      activePlaybackSources.delete(source);
      if (activePlaybackSources.size === 0) {
        nextPlayTime = 0;
        reportSpeaking(false);
        if (state.outputLevel !== 0) {
          setState({ ...state, outputLevel: 0 });
        }
      }
    };
    source.start(startTime);
  };

  const scheduleReconnect = () => {
    if (intentionalStop || !state.sessionId || !state.environmentId) return;
    const now = Date.now();
    if (disconnectedAtMs === null) {
      disconnectedAtMs = now;
    }
    if (now - disconnectedAtMs >= TALK_TO_FLEET_WEB_GIVE_UP_MS) {
      teardownSocketOnly();
      teardownAudio();
      setState({
        ...state,
        phase: "error",
        sessionId: null,
        error: m(msg("Could not reconnect to Talk to Fleet.")),
      });
      return;
    }

    const delay =
      TALK_TO_FLEET_WEB_RECONNECT_DELAYS_MS[
        Math.min(reconnectAttempt, TALK_TO_FLEET_WEB_RECONNECT_DELAYS_MS.length - 1)
      ]!;
    reconnectAttempt += 1;
    setState({ ...state, phase: "reconnecting", statusDetail: m(msg("Reconnecting...")) });
    clearReconnectTimer();

    const envId = state.environmentId;
    const sequence = activeRunSequence;
    const resumeSessionId = state.sessionId;
    const resumeSeq = state.lastEventSeq;
    const scopedThreadId = state.scopedThreadId ?? undefined;

    reconnectTimer = setTimeout(() => {
      if (intentionalStop || sequence !== activeRunSequence || !resumeSessionId) return;
      void openSocket(
        envId,
        {
          type: "config",
          sessionId: resumeSessionId,
          lastEventSeq: resumeSeq,
          greet: false,
          ...(scopedThreadId ? { threadId: scopedThreadId } : {}),
        },
        sequence,
        scopedThreadId,
      ).catch(() => {
        scheduleReconnect();
      });
    }, delay);
  };

  const openSocket = async (
    environmentId: EnvironmentId,
    configPayload: Record<string, unknown>,
    sequence: number,
    threadId?: string,
  ) => {
    const prepared = readPreparedConnection(environmentId);
    if (!prepared || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      throw new Error(m(msg("Environment disconnected before Talk to Fleet could connect.")));
    }

    const wsUrl = await runEnvironmentSpeech(
      getEnvironmentTalkToFleetStreamUrl(prepared, threadId ? { threadId } : undefined),
    );
    if (sequence !== activeRunSequence || intentionalStop) return;

    teardownSocketOnly();
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    socket = ws;

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      ws.onopen = () => {
        if (sequence !== activeRunSequence || intentionalStop) {
          ws.close(1000, "superseded");
          resolve();
          return;
        }
        opened = true;
        reconnectAttempt = 0;
        disconnectedAtMs = null;
        ws.send(JSON.stringify(configPayload));
        resolve();
      };
      ws.onerror = () => {
        if (!opened) {
          reject(new Error(m(msg("Could not connect to Talk to Fleet."))));
        }
      };
      ws.onmessage = (event) => {
        if (sequence !== activeRunSequence || intentionalStop) return;
        if (typeof event.data === "string") {
          try {
            const parsed = decodeServerEvent(event.data);
            if (parsed.type === "interrupt") {
              flushPlayback();
            }
            const next = reduceTalkToFleetWebEvent(state, parsed);
            setState(next);
            if (
              parsed.type === "session_ended" ||
              (parsed.type === "error" && !parsed.recoverable)
            ) {
              intentionalStop = true;
              teardownSocketOnly();
              teardownAudio();
            }
          } catch {
            // Ignore malformed control frames.
          }
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          handleServerAudioBytes(new Uint8Array(event.data));
        } else if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then((buf) => {
            if (sequence === activeRunSequence && !intentionalStop) {
              handleServerAudioBytes(new Uint8Array(buf));
            }
          });
        }
      };
      ws.onclose = () => {
        if (socket === ws) {
          socket = null;
        }
        if (!opened || sequence !== activeRunSequence) return;
        if (!intentionalStop && state.sessionId) {
          scheduleReconnect();
        } else {
          teardownAudio();
          if (state.phase !== "error" && state.phase !== "ended" && state.phase !== "idle") {
            setState({ ...state, phase: "ended", sessionId: null, statusDetail: null });
          }
        }
      };
    });
  };

  const setupCapturePipeline = async (sequence: number) => {
    const micId = await chooseRecordingMicrophone().catch(() => "");
    if (sequence !== activeRunSequence || intentionalStop) return;

    const stream = await openVoiceMicrophone(micId);
    if (sequence !== activeRunSequence || intentionalStop) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    captureStream = stream;

    const ctx = new AudioContext({ latencyHint: "interactive" });
    captureContext = ctx;
    await ctx.audioWorklet.addModule(talkToFleetWorkletUrl);
    if (sequence !== activeRunSequence || intentionalStop) return;

    const worklet = new AudioWorkletNode(ctx, "t3-talk-to-fleet-capture", { channelCount: 1 });
    captureWorklet = worklet;

    worklet.port.onmessage = ({
      data,
    }: MessageEvent<
      | { readonly type: "pcm"; readonly pcm: Int16Array }
      | { readonly type: "level"; readonly level: number }
      | { readonly type: "stopped" }
    >) => {
      if (sequence !== activeRunSequence || intentionalStop) return;
      if (data.type === "level") {
        if (state.inputLevel !== data.level) {
          setState({ ...state, inputLevel: data.level });
        }
        return;
      }
      if (data.type === "pcm" && !state.muted && socket?.readyState === WebSocket.OPEN) {
        const bytes = new Uint8Array(data.pcm.buffer, data.pcm.byteOffset, data.pcm.byteLength);
        const frame = encodeTalkToFleetAudioFrame(
          TALK_TO_FLEET_FRAME_CLIENT_AUDIO,
          state.activeTurnId,
          bytes,
        );
        socket.send(frame as Uint8Array<ArrayBuffer>);
      }
    };

    for (const track of stream.getTracks()) {
      track.addEventListener(
        "ended",
        () => {
          if (
            sequence === activeRunSequence &&
            !intentionalStop &&
            isTalkToFleetWebActive(state.phase)
          ) {
            setState({
              ...state,
              error: m(msg("Microphone disconnected during Talk to Fleet.")),
            });
          }
        },
        { once: true },
      );
    }

    const source = ctx.createMediaStreamSource(stream);
    captureSource = source;
    const silence = ctx.createGain();
    silence.gain.value = 0;
    captureSilenceGain = silence;

    source.connect(worklet);
    worklet.connect(silence);
    silence.connect(ctx.destination);
    await ctx.resume();
    if (state.muted) {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      worklet.port.postMessage("mute");
    }
  };

  const start = async (environmentId: EnvironmentId, options?: { readonly threadId?: string }) => {
    if (isTalkToFleetWebActive(state.phase) && !options?.threadId) {
      return;
    }

    const prepared = readPreparedConnection(environmentId);
    if (!prepared || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      setState({
        ...state,
        panelOpen: true,
        minimized: false,
        phase: "error",
        error: m(msg("Connect to an environment with agent access to use Talk to Fleet.")),
      });
      return;
    }

    const sequence = ++activeRunSequence;
    intentionalStop = false;
    clearReconnectTimer();
    reconnectAttempt = 0;
    disconnectedAtMs = null;

    teardownSocketOnly();
    teardownAudio();

    // Create playback context synchronously under the user click gesture before async hops.
    playbackContext = createPlaybackAudioContext();
    void playbackContext.resume().catch(() => {});

    setState({
      ...createInitialTalkToFleetWebState({
        showCaptions: state.showCaptions,
        selectedEnvironmentId: environmentId,
      }),
      panelOpen: true,
      minimized: false,
      phase: "connecting",
      environmentId,
      scopedThreadId: options?.threadId ?? null,
    });
    writeStorageString(STORAGE_ENV_KEY, environmentId);

    try {
      await Promise.all([
        setupCapturePipeline(sequence),
        openSocket(
          environmentId,
          {
            type: "config",
            ...(options?.threadId ? { threadId: options.threadId } : {}),
            greet: true,
          },
          sequence,
          options?.threadId,
        ),
      ]);
    } catch (error) {
      if (sequence !== activeRunSequence) return;
      teardownSocketOnly();
      teardownAudio();
      setState({
        ...state,
        phase: "error",
        sessionId: null,
        error: error instanceof Error ? error.message : m(msg("Failed to start Talk to Fleet.")),
      });
    }
  };

  const stop = () => {
    intentionalStop = true;
    activeRunSequence += 1;
    clearReconnectTimer();
    sendControl({ type: "hangup" });
    teardownSocketOnly();
    teardownAudio();
    setState({
      ...state,
      phase: "ended",
      sessionId: null,
      statusDetail: null,
      error: null,
      inputLevel: 0,
      outputLevel: 0,
    });
  };

  const newSession = () => {
    if (!isTalkToFleetWebActive(state.phase)) {
      if (state.environmentId) {
        void start(
          state.environmentId,
          state.scopedThreadId ? { threadId: state.scopedThreadId } : undefined,
        );
      }
      return;
    }
    flushPlayback();
    setState({
      ...state,
      transcript: [],
      cards: [],
      error: null,
      statusDetail: m(msg("Starting fresh session...")),
    });
    sendControl({ type: "new_session" });
  };

  const toggleMute = () => {
    const nextMuted = !state.muted;
    if (captureWorklet) {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      captureWorklet.port.postMessage(nextMuted ? "mute" : "unmute");
    }
    setState({
      ...state,
      muted: nextMuted,
      ...(nextMuted ? { inputLevel: 0 } : {}),
    });
  };

  const toggleCaptions = () => {
    const nextCaptions = !state.showCaptions;
    writeStorageString(STORAGE_CAPTIONS_KEY, nextCaptions ? "1" : "0");
    setState({ ...state, showCaptions: nextCaptions });
  };

  const openPanel = (environmentId?: EnvironmentId | null) => {
    const nextSelected = environmentId ?? state.selectedEnvironmentId;
    if (nextSelected) {
      writeStorageString(STORAGE_ENV_KEY, nextSelected);
    }
    setState({
      ...state,
      panelOpen: true,
      minimized: false,
      selectedEnvironmentId: nextSelected,
    });
  };

  const closePanel = () => {
    if (isTalkToFleetWebActive(state.phase)) {
      stop();
    }
    setState({
      ...state,
      panelOpen: false,
      minimized: false,
      phase: "idle",
      error: null,
      statusDetail: null,
    });
  };

  const toggleMinimize = () => {
    setState({ ...state, minimized: !state.minimized });
  };

  const setSelectedEnvironmentId = (environmentId: EnvironmentId | null) => {
    writeStorageString(STORAGE_ENV_KEY, environmentId);
    setState({ ...state, selectedEnvironmentId: environmentId });
  };

  const respondApproval = (threadId: string, requestId: string, decision: "accept" | "decline") => {
    sendControl({
      type: "approve",
      threadId,
      requestId,
      decision,
    });
  };

  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => {
      if (isTalkToFleetWebActive(state.phase)) {
        sendControl({ type: "hangup" });
      }
      teardownSocketOnly();
      teardownAudio();
    });
  }

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    openPanel,
    closePanel,
    toggleMinimize,
    setSelectedEnvironmentId,
    start,
    stop,
    newSession,
    toggleMute,
    toggleCaptions,
    respondApproval,
  };
}

export const talkToFleetController = createTalkToFleetController();

export function useTalkToFleetState(): TalkToFleetWebState {
  return useSyncExternalStore(talkToFleetController.subscribe, talkToFleetController.getSnapshot);
}

const getTalkToFleetActiveSnapshot = (): boolean =>
  isTalkToFleetWebActive(talkToFleetController.getSnapshot().phase);

export function useTalkToFleetActive(): boolean {
  return useSyncExternalStore(talkToFleetController.subscribe, getTalkToFleetActiveSnapshot);
}
