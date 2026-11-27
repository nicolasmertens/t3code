import * as Schema from "effect/Schema";

export const TALK_TO_FLEET_STREAM_PATH = "/ws/talk-to-fleet";
export const TALK_TO_FLEET_BINARY_HEADER_BYTES = 5;
export const TALK_TO_FLEET_FRAME_CLIENT_AUDIO = 0x01;
export const TALK_TO_FLEET_FRAME_SERVER_AUDIO = 0x02;
export const TALK_TO_FLEET_INPUT_SAMPLE_RATE = 16_000;
export const TALK_TO_FLEET_OUTPUT_SAMPLE_RATE = 24_000;
export const TALK_TO_FLEET_MAX_CONTROL_BYTES = 64_000;
export const TALK_TO_FLEET_MAX_AUDIO_BYTES = 64_000;

export type TalkToFleetBinaryFrameKind =
  | typeof TALK_TO_FLEET_FRAME_CLIENT_AUDIO
  | typeof TALK_TO_FLEET_FRAME_SERVER_AUDIO;

export interface DecodedTalkToFleetAudioFrame {
  readonly kind: number;
  readonly turnId: number;
  readonly pcm: Uint8Array;
}

export function encodeTalkToFleetAudioFrame(
  kind: TalkToFleetBinaryFrameKind,
  turnId: number,
  pcm: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(TALK_TO_FLEET_BINARY_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint8(0, kind);
  view.setUint32(1, turnId >>> 0, false);
  frame.set(pcm, TALK_TO_FLEET_BINARY_HEADER_BYTES);
  return frame;
}

export function decodeTalkToFleetAudioFrame(
  frame: Uint8Array,
): DecodedTalkToFleetAudioFrame | null {
  if (frame.byteLength < TALK_TO_FLEET_BINARY_HEADER_BYTES) {
    return null;
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const kind = view.getUint8(0);
  if (kind !== TALK_TO_FLEET_FRAME_CLIENT_AUDIO && kind !== TALK_TO_FLEET_FRAME_SERVER_AUDIO) {
    return null;
  }
  const turnId = view.getUint32(1, false);
  const pcm = frame.subarray(TALK_TO_FLEET_BINARY_HEADER_BYTES);
  return { kind, turnId, pcm };
}

export const TalkToFleetPhase = Schema.Literals([
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "reconnecting",
  "paused",
  "ended",
]);
export type TalkToFleetPhase = typeof TalkToFleetPhase.Type;

export const TalkToFleetToolCard = Schema.Struct({
  kind: Schema.Literal("tool"),
  id: Schema.String,
  tool: Schema.String,
  title: Schema.String,
  status: Schema.Literals(["running", "done", "error"]),
  detail: Schema.optional(Schema.String),
  sourceAge: Schema.optional(Schema.String),
  updatedAt: Schema.String,
});
export type TalkToFleetToolCard = typeof TalkToFleetToolCard.Type;

export const TalkToFleetThreadCard = Schema.Struct({
  kind: Schema.Literal("thread"),
  id: Schema.String,
  threadId: Schema.String,
  title: Schema.String,
  projectTitle: Schema.optional(Schema.String),
  status: Schema.Literals(["created", "steered", "running", "completed", "failed"]),
  summary: Schema.optional(Schema.String),
  updatedAt: Schema.String,
});
export type TalkToFleetThreadCard = typeof TalkToFleetThreadCard.Type;

export const TalkToFleetApprovalCard = Schema.Struct({
  kind: Schema.Literal("approval"),
  id: Schema.String,
  threadId: Schema.String,
  requestId: Schema.String,
  threadTitle: Schema.String,
  summary: Schema.String,
  status: Schema.Literals(["pending", "approved", "declined"]),
  updatedAt: Schema.String,
});
export type TalkToFleetApprovalCard = typeof TalkToFleetApprovalCard.Type;

export const TalkToFleetCard = Schema.Union([
  TalkToFleetToolCard,
  TalkToFleetThreadCard,
  TalkToFleetApprovalCard,
]);
export type TalkToFleetCard = typeof TalkToFleetCard.Type;

export const TalkToFleetClientMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("config"),
    sessionId: Schema.optional(Schema.String),
    lastEventSeq: Schema.optional(Schema.Int),
    threadId: Schema.optional(Schema.String),
    mode: Schema.optional(Schema.Literals(["thread", "fleet"])),
    greet: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("hangup") }),
  Schema.Struct({ type: Schema.Literal("new_session") }),
  Schema.Struct({ type: Schema.Literal("interrupt_assistant") }),
  Schema.Struct({
    type: Schema.Literal("approve"),
    threadId: Schema.String,
    requestId: Schema.String,
    decision: Schema.Literals(["accept", "decline"]),
  }),
  Schema.Struct({
    type: Schema.Literal("playback_state"),
    speaking: Schema.Boolean,
    route: Schema.String,
  }),
]);
export type TalkToFleetClientMessage = typeof TalkToFleetClientMessage.Type;

export const TalkToFleetSpeaker = Schema.Literals(["you", "fleet"]);
export type TalkToFleetSpeaker = typeof TalkToFleetSpeaker.Type;

export const TalkToFleetServerPhase = Schema.Literals(["listening", "thinking", "speaking"]);
export type TalkToFleetServerPhase = typeof TalkToFleetServerPhase.Type;

export const TalkToFleetServerEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ready"),
    seq: Schema.Int,
    sessionId: Schema.String,
    provider: Schema.String,
    model: Schema.String,
    scopedThreadId: Schema.optional(Schema.NullOr(Schema.String)),
    scopedThreadTitle: Schema.optional(Schema.NullOr(Schema.String)),
    contextBuiltAt: Schema.NullOr(Schema.String),
    degradedSources: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("phase"),
    seq: Schema.Int,
    phase: TalkToFleetServerPhase,
  }),
  Schema.Struct({
    type: Schema.Literal("transcript"),
    seq: Schema.Int,
    id: Schema.String,
    speaker: TalkToFleetSpeaker,
    delta: Schema.String,
    replace: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("interrupt"),
    seq: Schema.Int,
    turnId: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literal("card"),
    seq: Schema.Int,
    card: TalkToFleetCard,
  }),
  Schema.Struct({
    type: Schema.Literal("status_detail"),
    seq: Schema.Int,
    message: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    seq: Schema.Int,
    code: Schema.String,
    message: Schema.String,
    recoverable: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("session_ended"),
    seq: Schema.Int,
    reason: Schema.String,
  }),
]);
export type TalkToFleetServerEvent = typeof TalkToFleetServerEvent.Type;
