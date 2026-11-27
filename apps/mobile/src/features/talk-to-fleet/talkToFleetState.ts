import type {
  EnvironmentId,
  TalkToFleetCard,
  TalkToFleetPhase,
  TalkToFleetServerEvent,
} from "@t3tools/contracts";

export const TALK_TO_FLEET_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;
export const TALK_TO_FLEET_GIVE_UP_MS = 60_000;
const MAX_TRANSCRIPT_ITEMS = 40;
const MAX_CARDS = 20;

export type TalkToFleetClientPhase = "idle" | TalkToFleetPhase | "error";

export interface TalkToFleetTranscriptItem {
  readonly id: string;
  readonly speaker: "you" | "fleet";
  readonly text: string;
}

export interface TalkToFleetState {
  readonly phase: TalkToFleetClientPhase;
  readonly environmentId: EnvironmentId | null;
  readonly scopedThreadId: string | null;
  readonly scopedThreadTitle: string | null;
  readonly sessionId: string | null;
  readonly lastEventSeq: number;
  readonly provider: string | null;
  readonly model: string | null;
  readonly contextBuiltAt: string | null;
  readonly degradedSources: ReadonlyArray<string>;
  readonly route: string;
  readonly statusDetail: string | null;
  readonly muted: boolean;
  readonly speaker: boolean;
  readonly showCaptions: boolean;
  readonly error: string | null;
  readonly transcript: ReadonlyArray<TalkToFleetTranscriptItem>;
  readonly cards: ReadonlyArray<TalkToFleetCard>;
}

export function createInitialTalkToFleetState(options?: {
  readonly speaker?: boolean;
  readonly showCaptions?: boolean;
}): TalkToFleetState {
  return {
    phase: "idle",
    environmentId: null,
    scopedThreadId: null,
    scopedThreadTitle: null,
    sessionId: null,
    lastEventSeq: 0,
    provider: null,
    model: null,
    contextBuiltAt: null,
    degradedSources: [],
    route: "Speaker",
    statusDetail: null,
    muted: false,
    speaker: options?.speaker ?? true,
    showCaptions: options?.showCaptions ?? true,
    error: null,
    transcript: [],
    cards: [],
  };
}

export function isTalkToFleetActivePhase(phase: TalkToFleetClientPhase): boolean {
  return (
    phase === "connecting" ||
    phase === "listening" ||
    phase === "thinking" ||
    phase === "speaking" ||
    phase === "reconnecting" ||
    phase === "paused"
  );
}

function upsertTranscript(
  items: ReadonlyArray<TalkToFleetTranscriptItem>,
  id: string,
  speaker: "you" | "fleet",
  delta: string,
  replace?: boolean,
): ReadonlyArray<TalkToFleetTranscriptItem> {
  const existingIndex = items.findIndex((item) => item.id === id);
  if (existingIndex === -1) {
    return [...items, { id, speaker, text: delta }].slice(-MAX_TRANSCRIPT_ITEMS);
  }
  const existing = items[existingIndex]!;
  const updated: TalkToFleetTranscriptItem = {
    ...existing,
    text: replace ? delta : `${existing.text}${delta}`,
  };
  return [...items.slice(0, existingIndex), updated, ...items.slice(existingIndex + 1)];
}

function upsertCard(
  cards: ReadonlyArray<TalkToFleetCard>,
  card: TalkToFleetCard,
): ReadonlyArray<TalkToFleetCard> {
  const existingIndex = cards.findIndex((item) => item.id === card.id);
  if (existingIndex === -1) {
    return [card, ...cards].slice(0, MAX_CARDS);
  }
  return [card, ...cards.slice(0, existingIndex), ...cards.slice(existingIndex + 1)].slice(
    0,
    MAX_CARDS,
  );
}

export function reduceTalkToFleetEvent(
  state: TalkToFleetState,
  event: TalkToFleetServerEvent,
): TalkToFleetState {
  const lastEventSeq = Math.max(state.lastEventSeq, event.seq);

  switch (event.type) {
    case "ready":
      return {
        ...state,
        lastEventSeq,
        sessionId: event.sessionId,
        scopedThreadId: event.scopedThreadId ?? state.scopedThreadId,
        scopedThreadTitle: event.scopedThreadTitle ?? state.scopedThreadTitle,
        provider: event.provider,
        model: event.model,
        contextBuiltAt: event.contextBuiltAt,
        degradedSources: event.degradedSources,
        error: null,
        statusDetail: null,
      };
    case "phase":
      return {
        ...state,
        lastEventSeq,
        phase: event.phase,
        statusDetail: event.phase === "thinking" ? state.statusDetail : null,
      };
    case "transcript":
      return {
        ...state,
        lastEventSeq,
        transcript: upsertTranscript(
          state.transcript,
          event.id,
          event.speaker,
          event.delta,
          event.replace,
        ),
      };
    case "interrupt":
      return {
        ...state,
        lastEventSeq,
        phase: "listening",
        statusDetail: null,
      };
    case "card":
      return {
        ...state,
        lastEventSeq,
        cards: upsertCard(state.cards, event.card),
      };
    case "status_detail":
      return {
        ...state,
        lastEventSeq,
        statusDetail: event.message,
      };
    case "error":
      return {
        ...state,
        lastEventSeq,
        error: event.message,
        ...(event.recoverable ? {} : { phase: "error" as const }),
      };
    case "session_ended":
      return {
        ...state,
        lastEventSeq,
        phase: "ended",
        sessionId: null,
        scopedThreadTitle: null,
        statusDetail: null,
      };
  }
}
