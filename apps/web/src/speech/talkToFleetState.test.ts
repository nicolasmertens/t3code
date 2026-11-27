import type { TalkToFleetServerEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createInitialTalkToFleetWebState, reduceTalkToFleetWebEvent } from "./talkToFleetState";

describe("reduceTalkToFleetWebEvent", () => {
  it("handles ready, phase transitions, transcripts, cards, interrupt turns, and dedupe", () => {
    let state = createInitialTalkToFleetWebState();

    state = reduceTalkToFleetWebEvent(state, {
      type: "ready",
      seq: 1,
      sessionId: "sess-1",
      scopedThreadId: "thread-7",
      scopedThreadTitle: "Voice Sidechat",
      provider: "phonic",
      model: "phonic-1",
      contextBuiltAt: "2026-11-26T16:00:00.000Z",
      degradedSources: ["mail"],
    });
    expect(state.sessionId).toBe("sess-1");
    expect(state.scopedThreadId).toBe("thread-7");
    expect(state.scopedThreadTitle).toBe("Voice Sidechat");
    expect(state.mode).toBe("thread");
    expect(state.degradedSources).toEqual(["mail"]);

    state = reduceTalkToFleetWebEvent(state, {
      type: "phase",
      seq: 2,
      phase: "speaking",
    });
    expect(state.phase).toBe("speaking");

    state = reduceTalkToFleetWebEvent(state, {
      type: "transcript",
      seq: 3,
      id: "t-1",
      speaker: "fleet",
      delta: "Hey ",
    });
    state = reduceTalkToFleetWebEvent(state, {
      type: "transcript",
      seq: 4,
      id: "t-1",
      speaker: "fleet",
      delta: "Nick.",
    });
    expect(state.transcript).toEqual([{ id: "t-1", speaker: "fleet", text: "Hey Nick." }]);

    // Stale replay with seq <= lastEventSeq is ignored.
    const duplicateEvent: TalkToFleetServerEvent = {
      type: "transcript",
      seq: 4,
      id: "t-1",
      speaker: "fleet",
      delta: "DUPLICATE",
    };
    expect(reduceTalkToFleetWebEvent(state, duplicateEvent)).toBe(state);

    state = reduceTalkToFleetWebEvent(state, {
      type: "card",
      seq: 5,
      card: {
        kind: "tool",
        id: "tool-1",
        tool: "check_mail",
        title: "Checked inbox",
        status: "running",
        updatedAt: "2026-11-26T16:00:01.000Z",
      },
    });
    state = reduceTalkToFleetWebEvent(state, {
      type: "card",
      seq: 6,
      card: {
        kind: "tool",
        id: "tool-1",
        tool: "check_mail",
        title: "Checked inbox",
        status: "done",
        updatedAt: "2026-11-26T16:00:02.000Z",
      },
    });
    expect(state.cards).toHaveLength(1);
    expect(state.cards[0]).toMatchObject({ id: "tool-1", status: "done" });

    state = reduceTalkToFleetWebEvent(state, {
      type: "interrupt",
      seq: 7,
      turnId: 4,
    });
    expect(state.activeTurnId).toBe(4);
    expect(state.phase).toBe("listening");
    expect(state.outputLevel).toBe(0);

    state = reduceTalkToFleetWebEvent(state, {
      type: "transcript",
      seq: 8,
      id: "t-1",
      speaker: "fleet",
      delta: "Hey Nick — updated.",
      replace: true,
    });
    expect(state.transcript).toEqual([
      { id: "t-1", speaker: "fleet", text: "Hey Nick — updated." },
    ]);

    state = reduceTalkToFleetWebEvent(state, {
      type: "session_ended",
      seq: 9,
      reason: "hangup",
    });
    expect(state.phase).toBe("ended");
    expect(state.sessionId).toBeNull();
    expect(state.scopedThreadTitle).toBeNull();
  });
});
