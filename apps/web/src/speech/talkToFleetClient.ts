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
import talkToFleetPlaybackWorkletUrl from "./talkToFleetPlaybackWorklet.ts?worker&url";
import {
  TALK_TO_FLEET_WEB_GIVE_UP_MS,
  TALK_TO_FLEET_WEB_RECONNECT_DELAYS_MS,
  type TalkToFleetWebState,
  createInitialTalkToFleetWebState,
  isTalkToFleetWebActive,
  reduceTalkToFleetWebEvent,
} from "./talkToFleetState";
import talkToFleetWorkletUrl from "./talkToFleetWorklet.ts?worker&url";
import { cancelAllActiveVoiceInputSessions } from "./voiceInputSession";

const STORAGE_CAPTIONS_KEY = "t3.talkToFleet.showCaptions";
const STORAGE_ENV_KEY = "t3.talkToFleet.selectedEnvironmentId";
const STORAGE_MIC_KEY = "t3.talkToFleet.microphoneId";
const decodeServerEvent = Schema.decodeUnknownSync(Schema.fromJsonString(TalkToFleetServerEvent));

export interface TalkToFleetAudioLevels {
  readonly input: number;
  readonly output: number;
}

export interface StartTalkToFleetWebOptions {
  readonly threadId?: string | undefined;
  readonly threadTitle?: string | null | undefined;
  readonly mode?: "thread" | "fleet" | undefined;
  readonly openFloatingPanel?: boolean | undefined;
}

const ZERO_LEVELS: TalkToFleetAudioLevels = { input: 0, output: 0 };

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
    if (value === null || value === "") {
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

function readInitialMicrophoneId(): string {
  return readStorageString(STORAGE_MIC_KEY) ?? "";
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
    autoGainControl: true,
    channelCount: 1,
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
    selectedMicrophoneId: readInitialMicrophoneId(),
  });
  const listeners = new Set<() => void>();
  let levels: TalkToFleetAudioLevels = ZERO_LEVELS;
  const levelListeners = new Set<() => void>();

  let socket: WebSocket | null = null;
  let captureStream: MediaStream | null = null;
  let captureContext: AudioContext | null = null;
  let captureSource: MediaStreamAudioSourceNode | null = null;
  let captureWorklet: AudioWorkletNode | null = null;
  let captureSilenceGain: GainNode | null = null;
  let playbackContext: AudioContext | null = null;
  let playbackWorklet: AudioWorkletNode | null = null;
  let playbackDestination: MediaStreamAudioDestinationNode | null = null;
  let playbackAudioEl: HTMLAudioElement | null = null;
  let pendingPlaybackChunks: Int16Array[] = [];
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

  const publishLevels = (next: TalkToFleetAudioLevels) => {
    if (levels.input === next.input && levels.output === next.output) {
      return;
    }
    levels = next;
    for (const listener of levelListeners) {
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

  const postPcmToPlaybackWorklet = (worklet: AudioWorkletNode, pcm: Int16Array) => {
    worklet.port.postMessage({ type: "pcm", pcm }, [pcm.buffer]);
  };

  const flushPlayback = () => {
    pendingPlaybackChunks = [];
    if (playbackWorklet) {
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
        playbackWorklet.port.postMessage({ type: "flush" });
      } catch {
        // Ignore already-closed playback worklets.
      }
    }
    reportSpeaking(false);
    publishLevels({ ...levels, output: 0 });
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

  const teardownCapture = () => {
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
    publishLevels({ ...levels, input: 0 });
  };

  const teardownPlayback = () => {
    flushPlayback();
    if (playbackWorklet) {
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
        playbackWorklet.port.postMessage("stop");
        playbackWorklet.port.onmessage = null;
        playbackWorklet.port.close();
        playbackWorklet.disconnect();
      } catch {
        // Ignore.
      }
      playbackWorklet = null;
    }
    if (playbackAudioEl) {
      try {
        playbackAudioEl.pause();
        playbackAudioEl.srcObject = null;
      } catch {
        // Ignore.
      }
      playbackAudioEl = null;
    }
    if (playbackDestination) {
      try {
        playbackDestination.disconnect();
      } catch {
        // Ignore.
      }
      playbackDestination = null;
    }
    if (playbackContext) {
      const ctx = playbackContext;
      playbackContext = null;
      void ctx.close().catch(() => {});
    }
    publishLevels({ ...levels, output: 0 });
  };

  const teardownAudio = () => {
    teardownCapture();
    teardownPlayback();
    publishLevels(ZERO_LEVELS);
  };

  const handleServerAudioBytes = (bytes: Uint8Array) => {
    const frame = decodeTalkToFleetAudioFrame(bytes);
    if (!frame || frame.kind !== TALK_TO_FLEET_FRAME_SERVER_AUDIO) return;
    if (frame.turnId < state.activeTurnId) return;

    const sampleCount = Math.floor(frame.pcm.byteLength / 2);
    if (sampleCount <= 0) return;

    const view = new DataView(frame.pcm.buffer, frame.pcm.byteOffset, sampleCount * 2);
    const pcm = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      pcm[i] = view.getInt16(i * 2, true);
    }

    if (playbackWorklet) {
      if (playbackContext?.state === "suspended") {
        void playbackContext.resume().catch(() => {});
      }
      postPcmToPlaybackWorklet(playbackWorklet, pcm);
      return;
    }

    pendingPlaybackChunks.push(pcm);
    if (pendingPlaybackChunks.length > 250) {
      pendingPlaybackChunks.shift();
    }
  };

  const setupPlaybackPipeline = async (sequence: number) => {
    const ctx = playbackContext;
    if (!ctx) return;

    await ctx.audioWorklet.addModule(talkToFleetPlaybackWorkletUrl);
    if (sequence !== activeRunSequence || intentionalStop || playbackContext !== ctx) {
      return;
    }

    const worklet = new AudioWorkletNode(ctx, "t3-talk-to-fleet-playback", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    playbackWorklet = worklet;

    worklet.port.onmessage = ({
      data,
    }: MessageEvent<{
      readonly type: "state";
      readonly speaking: boolean;
      readonly level: number;
    }>) => {
      if (sequence !== activeRunSequence || intentionalStop) return;
      if (data?.type !== "state") return;
      reportSpeaking(data.speaking);
      publishLevels({ ...levels, output: data.level });
    };

    // Pipe assistant audio through a MediaStreamAudioDestinationNode -> <audio> so Chromium's
    // WebRTC AEC3 cancels speaker playback out of the microphone capture stream on macOS.
    let routedViaMediaStream = false;
    if (typeof ctx.createMediaStreamDestination === "function" && typeof Audio === "function") {
      try {
        const destination = ctx.createMediaStreamDestination();
        playbackDestination = destination;
        worklet.connect(destination);
        const audioEl = new Audio();
        audioEl.autoplay = true;
        audioEl.setAttribute("playsinline", "");
        audioEl.srcObject = destination.stream;
        playbackAudioEl = audioEl;
        routedViaMediaStream = await audioEl
          .play()
          .then(() => true)
          .catch(() => false);
        if (!routedViaMediaStream || sequence !== activeRunSequence || intentionalStop) {
          try {
            worklet.disconnect(destination);
          } catch {
            // Ignore.
          }
          audioEl.pause();
          audioEl.srcObject = null;
          playbackAudioEl = null;
          playbackDestination = null;
        }
      } catch {
        playbackDestination = null;
        playbackAudioEl = null;
        routedViaMediaStream = false;
      }
    }

    if (sequence !== activeRunSequence || intentionalStop) {
      worklet.disconnect();
      return;
    }

    if (!routedViaMediaStream) {
      worklet.connect(ctx.destination);
    }

    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }

    const queued = pendingPlaybackChunks;
    pendingPlaybackChunks = [];
    for (const chunk of queued) {
      postPcmToPlaybackWorklet(worklet, chunk);
    }
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
    const mode = state.mode;

    reconnectTimer = setTimeout(() => {
      if (intentionalStop || sequence !== activeRunSequence || !resumeSessionId) return;
      void openSocket(
        envId,
        {
          type: "config",
          sessionId: resumeSessionId,
          lastEventSeq: resumeSeq,
          greet: false,
          mode,
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

  const setupCapturePipeline = async (sequence: number, microphoneOverride?: string) => {
    const chosenMic =
      microphoneOverride !== undefined
        ? microphoneOverride
        : state.selectedMicrophoneId || (await chooseRecordingMicrophone().catch(() => ""));
    if (sequence !== activeRunSequence || intentionalStop) return;

    const stream = await openVoiceMicrophone(chosenMic);
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
        publishLevels({ ...levels, input: data.level });
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

  const start = async (environmentId: EnvironmentId, options?: StartTalkToFleetWebOptions) => {
    const requestedThreadId = options?.threadId ?? null;
    if (
      isTalkToFleetWebActive(state.phase) &&
      state.environmentId === environmentId &&
      state.scopedThreadId === requestedThreadId
    ) {
      return;
    }

    const prepared = readPreparedConnection(environmentId);
    if (!prepared || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      setState({
        ...state,
        panelOpen: options?.openFloatingPanel ?? !requestedThreadId,
        minimized: false,
        phase: "error",
        error: m(msg("Connect to an environment with agent access to use Talk to Fleet.")),
      });
      return;
    }

    if (isTalkToFleetWebActive(state.phase) && state.sessionId) {
      sendControl({ type: "hangup" });
    }

    const sequence = ++activeRunSequence;
    intentionalStop = false;
    clearReconnectTimer();
    reconnectAttempt = 0;
    disconnectedAtMs = null;

    cancelAllActiveVoiceInputSessions();
    teardownSocketOnly();
    teardownAudio();

    // Create playback context synchronously under the user click gesture before async hops.
    playbackContext = createPlaybackAudioContext();
    void playbackContext.resume().catch(() => {});

    const mode = options?.mode ?? (requestedThreadId ? "thread" : "fleet");
    setState({
      ...createInitialTalkToFleetWebState({
        showCaptions: state.showCaptions,
        selectedEnvironmentId: environmentId,
        selectedMicrophoneId: state.selectedMicrophoneId,
      }),
      panelOpen: options?.openFloatingPanel ?? mode === "fleet",
      minimized: false,
      phase: "connecting",
      environmentId,
      scopedThreadId: requestedThreadId,
      scopedThreadTitle: options?.threadTitle ?? null,
      mode,
    });
    writeStorageString(STORAGE_ENV_KEY, environmentId);

    try {
      await Promise.all([
        setupCapturePipeline(sequence),
        setupPlaybackPipeline(sequence),
        openSocket(
          environmentId,
          {
            type: "config",
            ...(requestedThreadId ? { threadId: requestedThreadId } : {}),
            mode,
            greet: true,
          },
          sequence,
          requestedThreadId ?? undefined,
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
      scopedThreadTitle: null,
      statusDetail: null,
      error: null,
      inputLevel: 0,
      outputLevel: 0,
    });
  };

  const interruptAssistant = () => {
    if (!isTalkToFleetWebActive(state.phase)) return;
    flushPlayback();
    sendControl({ type: "interrupt_assistant" });
    setState({
      ...state,
      phase: "listening",
      statusDetail: null,
    });
  };

  const newSession = () => {
    if (!isTalkToFleetWebActive(state.phase)) {
      if (state.environmentId) {
        void start(state.environmentId, {
          ...(state.scopedThreadId ? { threadId: state.scopedThreadId } : {}),
          ...(state.scopedThreadTitle ? { threadTitle: state.scopedThreadTitle } : {}),
          mode: state.mode,
          openFloatingPanel: state.panelOpen,
        });
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
    if (nextMuted) {
      publishLevels({ ...levels, input: 0 });
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

  const setMicrophoneId = async (microphoneId: string) => {
    writeStorageString(STORAGE_MIC_KEY, microphoneId);
    setState({ ...state, selectedMicrophoneId: microphoneId });
    if (!isTalkToFleetWebActive(state.phase)) {
      return;
    }
    const sequence = activeRunSequence;
    teardownCapture();
    try {
      const resolved = microphoneId || (await chooseRecordingMicrophone().catch(() => ""));
      await setupCapturePipeline(sequence, resolved);
    } catch (error) {
      if (sequence !== activeRunSequence) return;
      setState({
        ...state,
        error:
          error instanceof Error
            ? error.message
            : m(msg("Could not switch microphone during Talk to Fleet.")),
      });
    }
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
    subscribeLevels: (listener: () => void) => {
      levelListeners.add(listener);
      return () => {
        levelListeners.delete(listener);
      };
    },
    getLevels: () => levels,
    openPanel,
    closePanel,
    toggleMinimize,
    setSelectedEnvironmentId,
    setMicrophoneId,
    start,
    stop,
    interruptAssistant,
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

export function useTalkToFleetLevels(): TalkToFleetAudioLevels {
  return useSyncExternalStore(
    talkToFleetController.subscribeLevels,
    talkToFleetController.getLevels,
  );
}

const getTalkToFleetActiveSnapshot = (): boolean =>
  isTalkToFleetWebActive(talkToFleetController.getSnapshot().phase);

export function useTalkToFleetActive(): boolean {
  return useSyncExternalStore(talkToFleetController.subscribe, getTalkToFleetActiveSnapshot);
}

const visibleVoicePanes = new Map<string, number>();
const visibleVoicePaneListeners = new Set<() => void>();

export function registerVisibleVoicePane(threadId: string): () => void {
  visibleVoicePanes.set(threadId, (visibleVoicePanes.get(threadId) ?? 0) + 1);
  for (const listener of visibleVoicePaneListeners) {
    listener();
  }
  return () => {
    const next = (visibleVoicePanes.get(threadId) ?? 1) - 1;
    if (next > 0) {
      visibleVoicePanes.set(threadId, next);
    } else {
      visibleVoicePanes.delete(threadId);
    }
    for (const listener of visibleVoicePaneListeners) {
      listener();
    }
  };
}

function subscribeVisibleVoicePanes(listener: () => void): () => void {
  visibleVoicePaneListeners.add(listener);
  return () => visibleVoicePaneListeners.delete(listener);
}

export function useIsVoicePaneVisible(threadId: string | null): boolean {
  return useSyncExternalStore(
    subscribeVisibleVoicePanes,
    () => threadId !== null && visibleVoicePanes.has(threadId),
  );
}
