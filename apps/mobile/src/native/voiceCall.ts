export interface VoiceCallNativeStateEvent {
  readonly state: "connecting" | "connected" | "disconnected" | "ended";
}

export interface VoiceCallNativeJsonEvent {
  readonly json: string;
}

export interface VoiceCallNativeLevelEvent {
  readonly level: number;
}

export interface VoiceCallNativeRouteEvent {
  readonly route: string;
}

export interface VoiceCallNativeErrorEvent {
  readonly message: string;
}

export interface VoiceCallNativeBridge {
  readonly isSupported: boolean;
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

export function getVoiceCallNativeBridge(): VoiceCallNativeBridge {
  return {
    isSupported: false,
    async start() {
      throw new Error("Talk to Fleet native voice audio requires iOS.");
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
