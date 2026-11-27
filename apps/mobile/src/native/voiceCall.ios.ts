import { requireOptionalNativeModule } from "expo";
import type {
  VoiceCallNativeBridge,
  VoiceCallNativeErrorEvent,
  VoiceCallNativeJsonEvent,
  VoiceCallNativeLevelEvent,
  VoiceCallNativeRouteEvent,
  VoiceCallNativeStateEvent,
} from "./voiceCall";

interface NativeVoiceCallModule {
  start(url: string, configJson: string, speaker: boolean): Promise<void>;
  stop(): void;
  setMuted(muted: boolean): void;
  setSpeaker(speaker: boolean): void;
  interruptPlayback(): void;
  sendControl(json: string): void;
  addListener(
    event: "onState",
    listener: (payload: VoiceCallNativeStateEvent) => void,
  ): { remove(): void };
  addListener(
    event: "onEvent",
    listener: (payload: VoiceCallNativeJsonEvent) => void,
  ): { remove(): void };
  addListener(
    event: "onLevel",
    listener: (payload: VoiceCallNativeLevelEvent) => void,
  ): { remove(): void };
  addListener(
    event: "onRoute",
    listener: (payload: VoiceCallNativeRouteEvent) => void,
  ): { remove(): void };
  addListener(
    event: "onError",
    listener: (payload: VoiceCallNativeErrorEvent) => void,
  ): { remove(): void };
}

const native = requireOptionalNativeModule<NativeVoiceCallModule>("T3VoiceCall");

export function getVoiceCallNativeBridge(): VoiceCallNativeBridge {
  if (!native || typeof native.start !== "function") {
    return {
      isSupported: false,
      async start() {
        throw new Error(
          "T3VoiceCall native module is not installed in this iOS build yet. Rebuild the iOS app on Mac to enable Talk to Fleet.",
        );
      },
      stop() {},
      setMuted() {},
      setSpeaker() {},
      interruptPlayback() {},
      sendControl() {},
      addListener() {
        return { remove() {} };
      },
    };
  }

  return {
    isSupported: true,
    start: (url, configJson, speaker) => native.start(url, configJson, speaker),
    stop: () => native.stop(),
    setMuted: (muted) => native.setMuted(muted),
    setSpeaker: (speaker) => native.setSpeaker(speaker),
    interruptPlayback: () => {
      if (typeof native.interruptPlayback === "function") {
        native.interruptPlayback();
      }
    },
    sendControl: (json) => native.sendControl(json),
    addListener: ((event: string, listener: (payload: never) => void) =>
      (
        native.addListener as unknown as (
          name: string,
          fn: (payload: never) => void,
        ) => { remove(): void }
      )(event, listener)) as VoiceCallNativeBridge["addListener"],
  };
}
