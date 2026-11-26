import type {
  EnvironmentId,
  TalkToFleetCard,
  TalkToFleetPhase,
  TalkToFleetServerEvent,
} from "@t3tools/contracts";

export const TALK_TO_FLEET_WEB_RECONNECT_DELAYS_MS = [
  500, 1_000, 2_000, 4_000, 8_000, 15_000,
] as const;
export const TALK_TO_FLEET_WEB_GIVE_UP_MS = 60_000;
const MAX_TRANSCRIPT_ITEMS = 40;
const MAX_CARDS = 12;

export type TalkToFleetWebPhase = "idle" | TalkToFleetPhase | "error";

export interface TalkToFleetWebTranscriptItem {
  readonly id: string;
  readonly speaker: "you" | "fleet";
  readonly text: string;
}

export interface TalkToFleetWebState {
  readonly panelOpen: boolean;
  readonly minimized: boolean;
  readonly phase: TalkToFleetWebPhase;
  readonly environmentId: EnvironmentId | null;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly scopedThreadId: string | null;
  readonly sessionId: string | null;
  readonly lastEventSeq: number;
  readonly activeTurnId: number;
  readonly provider: string | null;
  readonly model: string | null;
  readonly contextBuiltAt: string | null;
  readonly degradedSources: ReadonlyArray<string>;
  readonly statusDetail: string | null;
  readonly muted: boolean;
  readonly showCaptions: boolean;
  readonly inputLevel: number;
  readonly outputLevel: number;
  readonly error: string | null;
  readonly transcript: ReadonlyArray<TalkToFleetWebTranscriptItem>;
  readonly cards: ReadonlyArray<TalkToFleetCard>;
}

export function createInitialTalkToFleetWebState(options?: {
  readonly showCaptions?: boolean;
  readonly selectedEnvironmentId?: EnvironmentId | null;
}): TalkToFleetWebState {
  return {
    panelOpen: false,
    minimized: false,
    phase: "idle",
    environmentId: null,
    selectedEnvironmentId: options?.selectedEnvironmentId ?? null,
    scopedThreadId: null,
    sessionId: null,
    lastEventSeq: 0,
    activeTurnId: 0,
    provider: null,
    model: null,
    contextBuiltAt: null,
    degradedSources: [],
    statusDetail: null,
    muted: false,
    showCaptions: options?.showCaptions ?? true,
    inputLevel: 0,
    outputLevel: 0,
    error: null,
    transcript: [],
    cards: [],
  };
}

export function isTalkToFleetWebActive(phase: TalkToFleetWebPhase): boolean {
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
  items: ReadonlyArray<TalkToFleetWebTranscriptItem>,
  id: string,
  speaker: "you" | "fleet",
  delta: string,
  replace?: boolean,
): ReadonlyArray<TalkToFleetWebTranscriptItem> {
  const existingIndex = items.findIndex((item) => item.id === id);
  if (existingIndex === -1) {
    return [...items, { id, speaker, text: delta }].slice(-MAX_TRANSCRIPT_ITEMS);
  }
  const existing = items[existingIndex]!;
  const updated: TalkToFleetWebTranscriptItem = {
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

export function reduceTalkToFleetWebEvent(
  state: TalkToFleetWebState,
  event: TalkToFleetServerEvent,
): TalkToFleetWebState {
  if (event.type !== "ready" && state.lastEventSeq > 0 && event.seq <= state.lastEventSeq) {
    return state;
  }

  const lastEventSeq = Math.max(state.lastEventSeq, event.seq);

  switch (event.type) {
    case "ready":
      if (state.sessionId === event.sessionId && event.seq <= state.lastEventSeq) {
        return state;
      }
      return {
        ...state,
        lastEventSeq: event.seq,
        sessionId: event.sessionId,
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
        ...(event.phase !== "speaking" ? { outputLevel: 0 } : {}),
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
        activeTurnId: Math.max(state.activeTurnId, event.turnId),
        phase: "listening",
        statusDetail: null,
        outputLevel: 0,
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
        ...(event.recoverable ? {} : { phase: "error" as const, outputLevel: 0 }),
      };
    case "session_ended":
      return {
        ...state,
        lastEventSeq,
        phase: "ended",
        sessionId: null,
        statusDetail: null,
        outputLevel: 0,
      };
  }
}
