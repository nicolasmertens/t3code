// @effect-diagnostics globalFetch:off globalDate:off globalTimers:off - Phonic STS adapter runs over undici WebSocket and keepalive timers.
import {
  TALK_TO_FLEET_INPUT_SAMPLE_RATE,
  TALK_TO_FLEET_OUTPUT_SAMPLE_RATE,
} from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { WebSocket as UndiciWebSocket } from "undici";

import {
  RealtimeVoiceProvider,
  type VoiceProviderCallbacks,
  type VoiceProviderConfig,
  type VoiceProviderConnection,
  type VoiceToolDefinition,
} from "./RealtimeVoiceProvider.ts";

const PHONIC_WS_ENDPOINT = "wss://api.phonic.ai/v1/sts/ws";
const PHONIC_AGENTS_ENDPOINT = "https://api.phonic.ai/v1/agents";
const PHONIC_PCM_CHUNK_BYTES = 640; // 20 ms at 16 kHz Int16 mono
const PHONIC_KEEPALIVE_INTERVAL_MS = 100;
const PHONIC_SILENCE_GAP_MS = 200;
const PHONIC_SILENCE_FRAME = new Uint8Array(3200);
const MAX_TOOL_OUTPUT_BYTES = 15_000;

interface PhonicAgentSummary {
  readonly name?: string;
  readonly voice_id?: string;
  readonly audio_speed?: number;
  readonly intelligence_level?: string;
  readonly background_noise?: string | null;
  readonly background_noise_level?: number;
  readonly min_words_to_interrupt?: number;
  readonly enable_assistant_backchannel?: boolean;
  readonly no_input_end_conversation_sec?: number;
  readonly boosted_keywords?: ReadonlyArray<string>;
  readonly pronunciation_dictionary?: ReadonlyArray<unknown>;
}

function toPhonicToolSchema(tool: VoiceToolDefinition) {
  const properties: Record<string, Record<string, unknown>> = {};
  const requiredSet = new Set(tool.parameters.required);
  for (const [key, rawDef] of Object.entries(tool.parameters.properties)) {
    const def = { ...rawDef };
    if (!requiredSet.has(key) && typeof def.type === "string") {
      def.type = [def.type, "null"];
      if (Array.isArray(def.enum)) {
        def.enum = [...def.enum, null];
      }
    }
    properties[key] = def;
  }
  return {
    type: "custom_websocket",
    execution_mode: "sync",
    tool_call_output_timeout_ms: 25_000,
    tool_schema: {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        strict: true,
        parameters: {
          type: "object",
          properties,
          required: Object.keys(properties),
          additionalProperties: false,
        },
      },
    },
  };
}

function boundPhonicToolOutput(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return { status: "empty" };
  if (Buffer.byteLength(serialized, "utf8") <= MAX_TOOL_OUTPUT_BYTES) {
    return value;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const copy = { ...(value as Record<string, unknown>), truncated: true };
    const compact = JSON.stringify(copy);
    if (Buffer.byteLength(compact, "utf8") <= MAX_TOOL_OUTPUT_BYTES) return copy;
  }
  return {
    ok: true,
    truncated: true,
    summary: serialized.slice(0, 6_000) + " ...[truncated]",
  };
}

async function fetchPhonicAgentOverrides(
  apiKey: string,
  project: string,
  agentName: string,
): Promise<PhonicAgentSummary | null> {
  try {
    const url = `${PHONIC_AGENTS_ENDPOINT}?project=${encodeURIComponent(project)}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { readonly agents?: ReadonlyArray<PhonicAgentSummary> };
    return body.agents?.find((agent) => agent.name === agentName) ?? null;
  } catch {
    return null;
  }
}

function decodeMessageText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return null;
}

async function connectPhonicVoiceProvider(
  config: VoiceProviderConfig,
  callbacks: VoiceProviderCallbacks,
  options?: {
    readonly apiKey?: string;
    readonly endpoint?: string;
    readonly fetchOverrides?: boolean;
  },
): Promise<VoiceProviderConnection> {
  const apiKey = options?.apiKey ?? process.env.PHONIC_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error("PHONIC_API_KEY is not configured on this Browne server.");
  }
  const project = process.env.PHONIC_PROJECT?.trim() || "main";
  const agentName = process.env.PHONIC_AGENT_NAME?.trim() || "talk-to-fleet";
  const agentOverrides =
    options?.fetchOverrides === false
      ? null
      : await fetchPhonicAgentOverrides(apiKey, project, agentName);

  const wsUrl = options?.endpoint ?? PHONIC_WS_ENDPOINT;
  const ws = new UndiciWebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  let closed = false;
  let ready = false;
  let assistantSpeaking = false;
  let lastAudioSentAt = Date.now();
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const sendJson = (payload: unknown) => {
    if (closed || ws.readyState !== UndiciWebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  };

  const sendAudioChunks = (pcm: Uint8Array) => {
    if (closed || !ready || ws.readyState !== UndiciWebSocket.OPEN) return;
    lastAudioSentAt = Date.now();
    for (let offset = 0; offset + 1 < pcm.byteLength; offset += PHONIC_PCM_CHUNK_BYTES) {
      const end = Math.min(pcm.byteLength, offset + PHONIC_PCM_CHUNK_BYTES);
      const slice = pcm.subarray(offset, end);
      if (slice.byteLength % 2 !== 0) continue;
      sendJson({
        type: "audio_chunk",
        audio: Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString("base64"),
      });
    }
  };

  const cleanup = () => {
    if (keepaliveTimer !== null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  };

  ws.addEventListener("open", () => {
    const voiceId =
      config.voiceId ?? process.env.PHONIC_VOICE_ID?.trim() ?? agentOverrides?.voice_id ?? "grant";
    const envSpeed = Number(process.env.PHONIC_AUDIO_SPEED);
    const audioSpeed =
      config.audioSpeed ??
      (Number.isFinite(envSpeed) && envSpeed > 0 ? envSpeed : undefined) ??
      agentOverrides?.audio_speed ??
      1.15;

    sendJson({
      type: "config",
      agent: agentName,
      project,
      model: "phonic-1",
      system_prompt: config.systemPrompt,
      voice_id: voiceId,
      audio_speed: audioSpeed,
      input_format: `pcm_${TALK_TO_FLEET_INPUT_SAMPLE_RATE}`,
      output_format: `pcm_${TALK_TO_FLEET_OUTPUT_SAMPLE_RATE}`,
      intelligence_level: agentOverrides?.intelligence_level ?? "standard",
      background_noise: agentOverrides?.background_noise ?? null,
      background_noise_level: agentOverrides?.background_noise_level ?? 0,
      default_language: "nl",
      additional_languages: ["en"],
      multilingual_mode: "auto",
      min_words_to_interrupt: agentOverrides?.min_words_to_interrupt ?? 1,
      generate_welcome_message: false,
      welcome_message: config.welcomeMessage,
      is_welcome_message_interruptible: true,
      enable_assistant_backchannel: agentOverrides?.enable_assistant_backchannel ?? true,
      no_input_poke_sec: null,
      no_input_end_conversation_sec: agentOverrides?.no_input_end_conversation_sec ?? 180,
      boosted_keywords: agentOverrides?.boosted_keywords ?? [],
      pronunciation_dictionary: agentOverrides?.pronunciation_dictionary ?? [],
      tools: [
        ...config.tools.map(toPhonicToolSchema),
        {
          type: "built_in",
          name: "choose_not_to_respond",
          tool_config: { respond_after_sec: null },
        },
      ],
    });

    keepaliveTimer = setInterval(() => {
      if (closed || !ready) return;
      if (Date.now() - lastAudioSentAt >= PHONIC_SILENCE_GAP_MS) {
        sendAudioChunks(PHONIC_SILENCE_FRAME);
      }
    }, PHONIC_KEEPALIVE_INTERVAL_MS);
  });

  ws.addEventListener("message", (event) => {
    const raw = decodeMessageText(event.data);
    if (!raw) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const kind = parsed.type;
    if (kind === "ready_to_start_conversation") {
      ready = true;
      lastAudioSentAt = Date.now();
      callbacks.onReady({ provider: "phonic", model: "phonic-1" });
      return;
    }
    if (kind === "input_text" && typeof parsed.text === "string" && parsed.text.length > 0) {
      callbacks.onTranscript("you", parsed.text);
      return;
    }
    if (kind === "audio_chunk") {
      const audioB64 = typeof parsed.audio === "string" ? parsed.audio : "";
      const text = typeof parsed.text === "string" ? parsed.text : "";
      if (audioB64.length > 0 && (assistantSpeaking || text.length > 0)) {
        const pcm = Buffer.from(audioB64, "base64");
        if (pcm.byteLength > 0) {
          callbacks.onAudio(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        }
      }
      if (text.length > 0) {
        callbacks.onTranscript("fleet", text);
      }
      return;
    }
    if (kind === "user_started_speaking") {
      assistantSpeaking = false;
      callbacks.onAssistantSpeakingChanged(false);
      callbacks.onUserInterrupted();
      return;
    }
    if (kind === "assistant_started_speaking") {
      assistantSpeaking = true;
      callbacks.onAssistantSpeakingChanged(true);
      return;
    }
    if (kind === "assistant_finished_speaking") {
      assistantSpeaking = false;
      callbacks.onAssistantSpeakingChanged(false);
      return;
    }
    if (kind === "tool_call") {
      const callId = typeof parsed.tool_call_id === "string" ? parsed.tool_call_id : "";
      const name = typeof parsed.tool_name === "string" ? parsed.tool_name : "";
      const params =
        typeof parsed.parameters === "object" &&
        parsed.parameters !== null &&
        !Array.isArray(parsed.parameters)
          ? (parsed.parameters as Record<string, unknown>)
          : {};
      if (callId && name) {
        callbacks.onToolCall(callId, name, params);
      }
      return;
    }
    if (kind === "tool_call_interrupted" && typeof parsed.tool_call_id === "string") {
      callbacks.onToolCallInterrupted(parsed.tool_call_id);
      return;
    }
    if (kind === "error") {
      const code = typeof parsed.code === "string" ? parsed.code : "phonic_provider_error";
      const message =
        typeof parsed.message === "string"
          ? parsed.message
          : "Phonic voice session encountered an error.";
      callbacks.onError(code, message, false);
      return;
    }
    if (kind === "assistant_ended_conversation") {
      closed = true;
      cleanup();
      callbacks.onClosed("assistant_ended");
      ws.close();
    }
  });

  ws.addEventListener("error", () => {
    if (closed) return;
    callbacks.onError("phonic_socket_error", "Lost connection to Phonic voice service.", true);
  });

  ws.addEventListener("close", (event) => {
    if (closed) return;
    closed = true;
    cleanup();
    callbacks.onClosed(event.reason || `closed:${event.code}`);
  });

  return {
    sendAudio16k: (pcm) => sendAudioChunks(pcm),
    sendToolOutput: (callId, output) => {
      sendJson({
        type: "tool_call_output",
        tool_call_id: callId,
        output: boundPhonicToolOutput(output),
      });
    },
    sendSystemNote: (text) => {
      sendJson({ type: "add_system_message", system_message: text });
    },
    generateReply: (systemMessage) => {
      sendJson({ type: "generate_reply", system_message: systemMessage });
    },
    close: () => {
      if (closed) return;
      closed = true;
      cleanup();
      try {
        ws.close();
      } catch {
        // ignore close errors during teardown
      }
    },
  };
}

export const PhonicProviderLayer = Layer.succeed(
  RealtimeVoiceProvider,
  RealtimeVoiceProvider.of({
    id: "phonic",
    connect: (config, callbacks) => connectPhonicVoiceProvider(config, callbacks),
  }),
);
