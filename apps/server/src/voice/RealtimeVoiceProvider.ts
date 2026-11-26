import * as Context from "effect/Context";

export interface VoiceToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly required: ReadonlyArray<string>;
  };
}

export interface VoiceProviderConfig {
  readonly systemPrompt: string;
  readonly welcomeMessage: string | null;
  readonly tools: ReadonlyArray<VoiceToolDefinition>;
  readonly voiceId?: string;
  readonly audioSpeed?: number;
}

export interface VoiceProviderCallbacks {
  readonly onReady: (info: { readonly provider: string; readonly model: string }) => void;
  readonly onAudio: (pcm24kInt16: Uint8Array) => void;
  readonly onTranscript: (speaker: "you" | "fleet", delta: string) => void;
  readonly onAssistantSpeakingChanged: (speaking: boolean) => void;
  readonly onUserInterrupted: () => void;
  readonly onToolCall: (
    callId: string,
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => void;
  readonly onToolCallInterrupted: (callId: string) => void;
  readonly onError: (code: string, message: string, recoverable: boolean) => void;
  readonly onClosed: (reason: string) => void;
}

export interface VoiceProviderConnection {
  sendAudio16k(pcm16kInt16: Uint8Array): void;
  sendToolOutput(callId: string, output: unknown): void;
  sendSystemNote(text: string): void;
  generateReply(systemMessage: string): void;
  close(): void;
}

export class RealtimeVoiceProvider extends Context.Service<
  RealtimeVoiceProvider,
  {
    readonly id: string;
    readonly connect: (
      config: VoiceProviderConfig,
      callbacks: VoiceProviderCallbacks,
    ) => Promise<VoiceProviderConnection>;
  }
>()("t3/voice/RealtimeVoiceProvider") {}
