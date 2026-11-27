import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  TALK_TO_FLEET_BINARY_HEADER_BYTES,
  TALK_TO_FLEET_FRAME_CLIENT_AUDIO,
  TALK_TO_FLEET_FRAME_SERVER_AUDIO,
  TalkToFleetClientMessage,
  TalkToFleetServerEvent,
  decodeTalkToFleetAudioFrame,
  encodeTalkToFleetAudioFrame,
} from "@t3tools/contracts";

describe("TalkToFleet binary audio framing", () => {
  it("encodes and decodes client 16kHz frames with big-endian turnId", () => {
    const pcm = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
    const frame = encodeTalkToFleetAudioFrame(TALK_TO_FLEET_FRAME_CLIENT_AUDIO, 0, pcm);
    expect(frame.byteLength).toBe(TALK_TO_FLEET_BINARY_HEADER_BYTES + pcm.byteLength);
    expect(frame[0]).toBe(0x01);

    const decoded = decodeTalkToFleetAudioFrame(frame);
    expect(decoded).not.toBeNull();
    expect(decoded?.kind).toBe(TALK_TO_FLEET_FRAME_CLIENT_AUDIO);
    expect(decoded?.turnId).toBe(0);
    expect(Array.from(decoded?.pcm ?? [])).toEqual([0x10, 0x20, 0x30, 0x40]);
  });

  it("preserves large 32-bit turnIds in server audio frames", () => {
    const pcm = new Uint8Array([0xaa, 0xbb]);
    const frame = encodeTalkToFleetAudioFrame(TALK_TO_FLEET_FRAME_SERVER_AUDIO, 0x01020304, pcm);
    expect(frame[0]).toBe(0x02);
    expect(frame[1]).toBe(0x01);
    expect(frame[2]).toBe(0x02);
    expect(frame[3]).toBe(0x03);
    expect(frame[4]).toBe(0x04);

    const decoded = decodeTalkToFleetAudioFrame(frame);
    expect(decoded?.turnId).toBe(0x01020304);
    expect(Array.from(decoded?.pcm ?? [])).toEqual([0xaa, 0xbb]);
  });

  it("rejects short or unknown frames", () => {
    expect(decodeTalkToFleetAudioFrame(new Uint8Array([0x01, 0x00]))).toBeNull();
    expect(
      decodeTalkToFleetAudioFrame(new Uint8Array([0x99, 0x00, 0x00, 0x00, 0x01, 0x05])),
    ).toBeNull();
  });

  it("decodes control and event schemas", () => {
    const decodeClient = Schema.decodeUnknownSync(TalkToFleetClientMessage);
    const decodeServer = Schema.decodeUnknownSync(TalkToFleetServerEvent);

    expect(
      decodeClient({
        type: "config",
        sessionId: "sess-1",
        lastEventSeq: 4,
        threadId: "thread-9",
        mode: "thread",
        greet: false,
      }),
    ).toEqual({
      type: "config",
      sessionId: "sess-1",
      lastEventSeq: 4,
      threadId: "thread-9",
      mode: "thread",
      greet: false,
    });

    expect(decodeClient({ type: "interrupt_assistant" })).toEqual({
      type: "interrupt_assistant",
    });

    expect(
      decodeServer({
        type: "ready",
        seq: 1,
        sessionId: "sess-1",
        provider: "phonic",
        model: "phonic-1",
        scopedThreadId: "thread-9",
        scopedThreadTitle: "Refactor voice engine",
        contextBuiltAt: "2026-11-27T14:00:00.000Z",
        degradedSources: [],
      }),
    ).toMatchObject({
      type: "ready",
      scopedThreadId: "thread-9",
      scopedThreadTitle: "Refactor voice engine",
    });

    expect(
      decodeServer({
        type: "card",
        seq: 7,
        card: {
          kind: "approval",
          id: "approval:req-1",
          threadId: "t-1",
          requestId: "req-1",
          threadTitle: "Deploy fix",
          summary: "command approval needed",
          status: "pending",
          updatedAt: "2026-11-26T10:00:00.000Z",
        },
      }),
    ).toMatchObject({ type: "card", seq: 7 });
  });
});
