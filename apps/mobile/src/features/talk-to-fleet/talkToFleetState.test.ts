import { describe, expect, it } from "vite-plus/test";
import {
  createInitialTalkToFleetState,
  isTalkToFleetActivePhase,
  reduceTalkToFleetEvent,
} from "./talkToFleetState";

describe("talkToFleetState", () => {
  it("coalesces streaming transcript deltas by id and supports replace", () => {
    let state = createInitialTalkToFleetState();
    state = reduceTalkToFleetEvent(state, {
      type: "transcript",
      seq: 1,
      id: "turn-1",
      speaker: "fleet",
      delta: "Hey ",
    });
    state = reduceTalkToFleetEvent(state, {
      type: "transcript",
      seq: 2,
      id: "turn-1",
      speaker: "fleet",
      delta: "Nick!",
    });
    expect(state.transcript).toEqual([{ id: "turn-1", speaker: "fleet", text: "Hey Nick!" }]);
    expect(state.lastEventSeq).toBe(2);

    state = reduceTalkToFleetEvent(state, {
      type: "transcript",
      seq: 3,
      id: "turn-1",
      speaker: "fleet",
      delta: "Corrected",
      replace: true,
    });
    expect(state.transcript).toEqual([{ id: "turn-1", speaker: "fleet", text: "Corrected" }]);
  });

  it("upserts live tool and approval cards cleanly", () => {
    let state = createInitialTalkToFleetState();
    state = reduceTalkToFleetEvent(state, {
      type: "card",
      seq: 1,
      card: {
        kind: "tool",
        id: "tool:1",
        tool: "fleet_search",
        title: "Search mail: invoice",
        status: "running",
        updatedAt: "2026-11-26T10:00:00.000Z",
      },
    });
    state = reduceTalkToFleetEvent(state, {
      type: "card",
      seq: 2,
      card: {
        kind: "tool",
        id: "tool:1",
        tool: "fleet_search",
        title: "Search mail: invoice",
        status: "done",
        sourceAge: "10:00",
        updatedAt: "2026-11-26T10:00:01.000Z",
      },
    });
    expect(state.cards).toHaveLength(1);
    expect(state.cards[0]).toMatchObject({ id: "tool:1", status: "done", sourceAge: "10:00" });

    state = reduceTalkToFleetEvent(state, {
      type: "card",
      seq: 3,
      card: {
        kind: "approval",
        id: "approval:req-1",
        threadId: "t-1",
        requestId: "req-1",
        threadTitle: "Deploy Browne",
        summary: "command approval needed",
        status: "pending",
        updatedAt: "2026-11-26T10:00:02.000Z",
      },
    });
    expect(state.cards.map((c) => c.id)).toEqual(["approval:req-1", "tool:1"]);
  });

  it("tracks ready, interrupt, fatal error, and session_ended lifecycle", () => {
    let state = createInitialTalkToFleetState({ speaker: false, showCaptions: false });
    expect(state.speaker).toBe(false);
    expect(isTalkToFleetActivePhase(state.phase)).toBe(false);

    state = reduceTalkToFleetEvent(state, {
      type: "ready",
      seq: 4,
      sessionId: "sess-abc",
      scopedThreadId: "thread-42",
      scopedThreadTitle: "Voice polish",
      provider: "phonic",
      model: "phonic-1",
      contextBuiltAt: "2026-11-26T10:00:00.000Z",
      degradedSources: ["maxbook"],
    });
    state = reduceTalkToFleetEvent(state, {
      type: "phase",
      seq: 5,
      phase: "speaking",
    });
    expect(state.sessionId).toBe("sess-abc");
    expect(state.scopedThreadId).toBe("thread-42");
    expect(state.scopedThreadTitle).toBe("Voice polish");
    expect(state.degradedSources).toEqual(["maxbook"]);
    expect(isTalkToFleetActivePhase(state.phase)).toBe(true);

    state = reduceTalkToFleetEvent(state, {
      type: "interrupt",
      seq: 6,
      turnId: 2,
    });
    expect(state.phase).toBe("listening");

    state = reduceTalkToFleetEvent(state, {
      type: "error",
      seq: 7,
      code: "fatal",
      message: "Lost connection",
      recoverable: false,
    });
    expect(state.phase).toBe("error");
    expect(state.error).toBe("Lost connection");

    state = reduceTalkToFleetEvent(state, {
      type: "session_ended",
      seq: 8,
      reason: "hangup",
    });
    expect(state.phase).toBe("ended");
    expect(state.sessionId).toBeNull();
    expect(state.scopedThreadTitle).toBeNull();
    expect(isTalkToFleetActivePhase(state.phase)).toBe(false);
  });
});
