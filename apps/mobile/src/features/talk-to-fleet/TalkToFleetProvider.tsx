import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { getEnvironmentTalkToFleetStreamUrl } from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  TalkToFleetServerEvent,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { msg } from "gt-react-native";
import { useSyncExternalStore } from "react";
import { makeMutable } from "react-native-reanimated";

import { m } from "../../i18n/messages";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";
import { getVoiceCallNativeBridge } from "../../native/voiceCall";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { environmentSession, sessionHasScope } from "../../state/session";
import { voiceInputAtom } from "../voice-input/VoiceInputProvider";
import { runSpeech } from "../voice-input/voiceDestination";
import {
  TALK_TO_FLEET_GIVE_UP_MS,
  TALK_TO_FLEET_RECONNECT_DELAYS_MS,
  type TalkToFleetState,
  createInitialTalkToFleetState,
  isTalkToFleetActivePhase,
  reduceTalkToFleetEvent,
} from "./talkToFleetState";

const WAVEFORM_BAR_COUNT = 16;
const decodeServerEvent = Schema.decodeUnknownSync(Schema.fromJsonString(TalkToFleetServerEvent));

export const talkToFleetCurrentRouteAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:talk-to-fleet:route"),
);

export function setTalkToFleetCurrentRouteName(routeName: string | null): void {
  if (appAtomRegistry.get(talkToFleetCurrentRouteAtom) !== routeName) {
    appAtomRegistry.set(talkToFleetCurrentRouteAtom, routeName);
  }
}

export interface StartTalkToFleetOptions {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: string;
}

function createTalkToFleetController(registry: AtomRegistry.AtomRegistry) {
  const bridge = getVoiceCallNativeBridge();
  const initialPrefs = AsyncResult.getOrElse(registry.get(mobilePreferencesAtom), () => null);
  let state: TalkToFleetState = createInitialTalkToFleetState({
    speaker: initialPrefs?.talkToFleetSpeaker ?? true,
    showCaptions: initialPrefs?.talkToFleetShowCaptions ?? true,
  });

  const audioLevels = makeMutable<ReadonlyArray<number>>(Array<number>(WAVEFORM_BAR_COUNT).fill(0));
  let latestLevels = Array<number>(WAVEFORM_BAR_COUNT).fill(0);

  const listeners = new Set<() => void>();
  let audioToken: ReturnType<typeof acquireAudioSession> | null = null;
  let keepAwakeHeld = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let disconnectedAtMs: number | null = null;
  let intentionalStop = false;
  let activeStartSequence = 0;

  const setState = (next: TalkToFleetState) => {
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

  const resetAudioLevels = () => {
    latestLevels = Array<number>(WAVEFORM_BAR_COUNT).fill(0);
    audioLevels.set(latestLevels);
  };

  const releaseHoldResources = () => {
    clearReconnectTimer();
    resetAudioLevels();
    if (keepAwakeHeld) {
      keepAwakeHeld = false;
      void deactivateKeepAwake("talk-to-fleet").catch(() => {});
    }
    const token = audioToken;
    audioToken = null;
    if (token) {
      void releaseAudioSession(token).catch(() => {});
    }
  };

  const resolveConnectedEnvironment = (preferredId?: EnvironmentId) => {
    const presentations = registry.get(environmentPresentations.presentationsAtom);
    if (preferredId) {
      const preferred = presentations.get(preferredId);
      if (
        preferred?.connection.phase === "connected" &&
        sessionHasScope(
          registry.get(environmentSession.sessionStateAtom(preferredId)),
          AuthOrchestrationOperateScope,
        )
      ) {
        const prepared = Option.getOrNull(
          registry.get(environmentSession.preparedConnectionValueAtom(preferredId)),
        );
        if (prepared) return { environmentId: preferredId, prepared };
      }
    }
    for (const [id, presentation] of presentations.entries()) {
      if (presentation.connection.phase !== "connected") continue;
      if (
        !sessionHasScope(
          registry.get(environmentSession.sessionStateAtom(id)),
          AuthOrchestrationOperateScope,
        )
      ) {
        continue;
      }
      const prepared = Option.getOrNull(
        registry.get(environmentSession.preparedConnectionValueAtom(id)),
      );
      if (prepared) return { environmentId: id, prepared };
    }
    return null;
  };

  const dialNativeSocket = async (
    targetEnvId: EnvironmentId,
    configPayload: Record<string, unknown>,
    sequence: number,
    threadId?: string,
  ) => {
    const resolved = resolveConnectedEnvironment(targetEnvId);
    if (!resolved) {
      throw new Error(m(msg("Environment disconnected before Talk to Fleet could connect.")));
    }
    const wsUrl = await runSpeech(
      getEnvironmentTalkToFleetStreamUrl(resolved.prepared, threadId ? { threadId } : undefined),
    );
    if (sequence !== activeStartSequence || intentionalStop) return;
    await bridge.start(wsUrl, JSON.stringify(configPayload), state.speaker);
  };

  const scheduleReconnect = () => {
    if (intentionalStop || !state.sessionId || !state.environmentId) return;
    const now = Date.now();
    if (disconnectedAtMs === null) {
      disconnectedAtMs = now;
    }
    if (now - disconnectedAtMs >= TALK_TO_FLEET_GIVE_UP_MS) {
      bridge.stop();
      releaseHoldResources();
      setState({
        ...state,
        phase: "error",
        sessionId: null,
        error: m(msg("Could not reconnect to Talk to Fleet.")),
      });
      return;
    }
    const delay =
      TALK_TO_FLEET_RECONNECT_DELAYS_MS[
        Math.min(reconnectAttempt, TALK_TO_FLEET_RECONNECT_DELAYS_MS.length - 1)
      ]!;
    reconnectAttempt += 1;
    setState({ ...state, phase: "reconnecting", statusDetail: m(msg("Reconnecting...")) });
    clearReconnectTimer();
    const envId = state.environmentId;
    const seq = activeStartSequence;
    reconnectTimer = setTimeout(() => {
      if (intentionalStop || seq !== activeStartSequence || !state.sessionId) return;
      void dialNativeSocket(
        envId,
        {
          type: "config",
          sessionId: state.sessionId,
          lastEventSeq: state.lastEventSeq,
          greet: false,
        },
        seq,
        state.scopedThreadId ?? undefined,
      ).catch(() => {
        scheduleReconnect();
      });
    }, delay);
  };

  const nativeSubscriptions = [
    bridge.addListener("onState", ({ state: nativeState }) => {
      if (nativeState === "connected") {
        reconnectAttempt = 0;
        disconnectedAtMs = null;
        return;
      }
      if (nativeState === "ended") {
        releaseHoldResources();
        if (state.phase !== "ended" && state.phase !== "error") {
          setState({ ...state, phase: "ended", sessionId: null, statusDetail: null });
        }
        return;
      }
      if (nativeState === "disconnected") {
        if (!intentionalStop && state.sessionId) {
          scheduleReconnect();
        } else {
          releaseHoldResources();
          if (state.phase !== "error") {
            setState({ ...state, phase: "ended", sessionId: null, statusDetail: null });
          }
        }
      }
    }),
    bridge.addListener("onEvent", ({ json }) => {
      try {
        const event = decodeServerEvent(json);
        const next = reduceTalkToFleetEvent(state, event);
        setState(next);
        if (event.type === "session_ended" || (event.type === "error" && !event.recoverable)) {
          intentionalStop = true;
          bridge.stop();
          releaseHoldResources();
        }
      } catch {
        // ignore unrecognized server event frames
      }
    }),
    bridge.addListener("onLevel", ({ level }) => {
      const clamped = Math.max(0, Math.min(1, level));
      latestLevels = [...latestLevels.slice(1), clamped];
      audioLevels.set(latestLevels);
    }),
    bridge.addListener("onRoute", ({ route }) => {
      setState({ ...state, route });
      if (state.sessionId && isTalkToFleetActivePhase(state.phase)) {
        bridge.sendControl(
          JSON.stringify({
            type: "playback_state",
            speaking: state.phase === "speaking",
            route,
          }),
        );
      }
    }),
    bridge.addListener("onError", ({ message }) => {
      if (!state.sessionId) {
        releaseHoldResources();
        setState({ ...state, phase: "error", error: message });
      } else {
        setState({ ...state, error: message });
      }
    }),
  ];

  const start = async (options?: StartTalkToFleetOptions) => {
    if (!bridge.isSupported) {
      setState({
        ...state,
        phase: "error",
        error: m(
          msg("Talk to Fleet live audio requires the updated iOS native build on your Mac."),
        ),
      });
      return;
    }

    if (isTalkToFleetActivePhase(state.phase) && !options?.threadId) {
      return;
    }

    const sequence = ++activeStartSequence;
    intentionalStop = false;
    clearReconnectTimer();
    reconnectAttempt = 0;
    disconnectedAtMs = null;

    const target = resolveConnectedEnvironment(options?.environmentId);
    if (!target) {
      setState({
        ...state,
        phase: "error",
        error: m(msg("Connect to your Browne environment first to use Talk to Fleet.")),
      });
      return;
    }

    // Cancel any active dictation recording cleanly before claiming full-duplex liveVoice.
    registry.get(voiceInputAtom).session.controller.cancel();

    const token = acquireAudioSession("liveVoice", () => {
      hangup();
    });
    audioToken = token;

    setState({
      ...createInitialTalkToFleetState({
        speaker: state.speaker,
        showCaptions: state.showCaptions,
      }),
      phase: "connecting",
      environmentId: target.environmentId,
      scopedThreadId: options?.threadId ?? null,
    });

    try {
      await activateAudioSession(token);
      if (sequence !== activeStartSequence || intentionalStop) return;
      if (!keepAwakeHeld) {
        keepAwakeHeld = true;
        void activateKeepAwakeAsync("talk-to-fleet").catch(() => {});
      }
      await dialNativeSocket(
        target.environmentId,
        {
          type: "config",
          ...(options?.threadId ? { threadId: options.threadId } : {}),
          greet: true,
        },
        sequence,
        options?.threadId,
      );
    } catch (error) {
      if (sequence !== activeStartSequence) return;
      releaseHoldResources();
      bridge.stop();
      setState({
        ...state,
        phase: "error",
        error: error instanceof Error ? error.message : m(msg("Failed to start Talk to Fleet.")),
      });
    }
  };

  const hangup = () => {
    intentionalStop = true;
    activeStartSequence += 1;
    clearReconnectTimer();
    if (state.sessionId) {
      bridge.sendControl(JSON.stringify({ type: "hangup" }));
    }
    bridge.stop();
    releaseHoldResources();
    setState({
      ...state,
      phase: "ended",
      sessionId: null,
      statusDetail: null,
      error: null,
    });
  };

  const newSession = () => {
    if (!isTalkToFleetActivePhase(state.phase)) {
      void start({
        environmentId: state.environmentId ?? undefined,
        threadId: state.scopedThreadId ?? undefined,
      });
      return;
    }
    setState({
      ...state,
      transcript: [],
      cards: [],
      error: null,
      statusDetail: m(msg("Starting fresh session...")),
    });
    bridge.sendControl(JSON.stringify({ type: "new_session" }));
  };

  const toggleMute = () => {
    const nextMuted = !state.muted;
    bridge.setMuted(nextMuted);
    setState({ ...state, muted: nextMuted });
  };

  const toggleSpeaker = () => {
    const nextSpeaker = !state.speaker;
    bridge.setSpeaker(nextSpeaker);
    setState({ ...state, speaker: nextSpeaker });
    void runAtomCommand(registry, saveMobilePreferences, {
      transform: () => ({ talkToFleetSpeaker: nextSpeaker }),
    }).catch(() => {});
  };

  const toggleCaptions = () => {
    const nextCaptions = !state.showCaptions;
    setState({ ...state, showCaptions: nextCaptions });
    void runAtomCommand(registry, saveMobilePreferences, {
      transform: () => ({ talkToFleetShowCaptions: nextCaptions }),
    }).catch(() => {});
  };

  const respondApproval = (threadId: string, requestId: string, decision: "accept" | "decline") => {
    bridge.sendControl(
      JSON.stringify({
        type: "approve",
        threadId,
        requestId,
        decision,
      }),
    );
  };

  const dispose = () => {
    intentionalStop = true;
    clearReconnectTimer();
    bridge.stop();
    releaseHoldResources();
    for (const sub of nativeSubscriptions) {
      sub.remove();
    }
  };

  return {
    audioLevels,
    isNativeSupported: bridge.isSupported,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    start,
    hangup,
    newSession,
    toggleMute,
    toggleSpeaker,
    toggleCaptions,
    respondApproval,
    dispose,
  };
}

export const talkToFleetAtom = Atom.make((get) => {
  get.mount(mobilePreferencesAtom);
  const controller = createTalkToFleetController(get.registry);
  get.addFinalizer(() => controller.dispose());
  return controller;
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:talk-to-fleet"));

export function useTalkToFleet() {
  const controller = useAtomValue(talkToFleetAtom);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return {
    state,
    audioLevels: controller.audioLevels,
    isNativeSupported: controller.isNativeSupported,
    start: controller.start,
    hangup: controller.hangup,
    newSession: controller.newSession,
    toggleMute: controller.toggleMute,
    toggleSpeaker: controller.toggleSpeaker,
    toggleCaptions: controller.toggleCaptions,
    respondApproval: controller.respondApproval,
  };
}
