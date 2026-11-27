// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off globalTimersInEffect:off globalJsonInEffect:off - Manages live WebSocket voice sessions, reconnect TTL timers, and JSON frame encoding.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  RuntimeRequestId,
  TALK_TO_FLEET_FRAME_CLIENT_AUDIO,
  TALK_TO_FLEET_FRAME_SERVER_AUDIO,
  TALK_TO_FLEET_MAX_AUDIO_BYTES,
  TALK_TO_FLEET_MAX_CONTROL_BYTES,
  TalkToFleetClientMessage,
  type TalkToFleetCard,
  type TalkToFleetServerEvent,
  type TalkToFleetServerPhase,
  ThreadId,
  decodeTalkToFleetAudioFrame,
  encodeTalkToFleetAudioFrame,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { boundPhonicToolOutput } from "./PhonicProvider.ts";
import { RealtimeVoiceProvider, type VoiceProviderConnection } from "./RealtimeVoiceProvider.ts";
import { VoiceContextCache, buildVoiceBriefing } from "./VoiceContextCache.ts";
import { buildVoiceSystemPrompt } from "./VoicePrompt.ts";
import {
  VOICE_TOOL_DEFINITIONS,
  executeVoiceTool,
  extractBoostedKeywordsFromSnapshot,
  readLiveBrowneSnapshot,
  type VoiceToolsDeps,
} from "./VoiceTools.ts";

const SESSION_RECONNECT_TTL_MS = 120_000;
const SESSION_HISTORY_LIMIT = 80;
const textEncoder = new TextEncoder();

const decodeClientMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(TalkToFleetClientMessage),
);

type ServerEventWithoutSeq =
  | Omit<Extract<TalkToFleetServerEvent, { readonly type: "ready" }>, "seq">
  | Omit<Extract<TalkToFleetServerEvent, { readonly type: "phase" }>, "seq">
  | Omit<Extract<TalkToFleetServerEvent, { readonly type: "transcript" }>, "seq">
  | Omit<Extract<TalkToFleetServerEvent, { readonly type: "interrupt" }>, "seq">
  | Omit<Extract<TalkToFleetServerEvent, { readonly type: "card" }>, "seq">
  | Omit<Extract<TalkToFleetServerEvent, { readonly type: "status_detail" }>, "seq">
  | Omit<Extract<TalkToFleetServerEvent, { readonly type: "error" }>, "seq">
  | Omit<Extract<TalkToFleetServerEvent, { readonly type: "session_ended" }>, "seq">;

type OutboundFrame =
  | { readonly kind: "json"; readonly event: TalkToFleetServerEvent }
  | { readonly kind: "audio"; readonly bytes: Uint8Array }
  | { readonly kind: "close"; readonly code: number; readonly reason?: string };

interface AttachedClient {
  readonly connectionId: string;
  readonly offer: (frame: OutboundFrame) => void;
}

interface ActiveSession {
  readonly sessionId: string;
  readonly scopedThreadId?: string | undefined;
  readonly trackedThreads: Map<string, string>;
  readonly cancelledToolCalls: Set<string>;
  readonly history: TalkToFleetServerEvent[];
  readonly cards: Map<string, TalkToFleetCard>;
  seq: number;
  turnId: number;
  phase: TalkToFleetServerPhase;
  providerName: string;
  modelName: string;
  scopedThreadTitle: string | null;
  contextBuiltAt: string | null;
  degradedSources: ReadonlyArray<string>;
  activeTranscriptId: string | null;
  activeTranscriptSpeaker: "you" | "fleet" | null;
  clientSpeaking: boolean;
  userSpeaking: boolean;
  dropAudioUntilNextAssistantTurn: boolean;
  providerReady: boolean;
  providerConn: VoiceProviderConnection | null;
  attached: AttachedClient | null;
  orphanTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
}

function buildGreetingMessage(scopedTitle?: string | null): string {
  const cleaned = scopedTitle?.replace(/\s+/gu, " ").trim();
  if (
    !cleaned ||
    cleaned.toLowerCase() === "new thread" ||
    cleaned.toLowerCase() === "untitled thread"
  ) {
    return "Hey Nick, ik ben er.";
  }
  const shortTitle = cleaned.length > 48 ? `${cleaned.slice(0, 45).trimEnd()}...` : cleaned;
  return `Hey Nick, ik kijk mee op ${shortTitle}.`;
}

export class TalkToFleetService extends Context.Service<
  TalkToFleetService,
  {
    readonly runSocket: (socket: Socket.Socket, queryThreadId?: string) => Effect.Effect<void>;
    readonly activeSessionCount: Effect.Effect<number>;
  }
>()("t3/voice/TalkToFleetService") {
  static readonly layer = Layer.effect(
    TalkToFleetService,
    Effect.gen(function* () {
      const runtimeContext = yield* Effect.context<never>();
      const runPromise = Effect.runPromiseWith(runtimeContext);
      const runSync = Effect.runSyncWith(runtimeContext);

      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadManagement = yield* ThreadManagement.ThreadManagementService;
      const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
      const projectStore = yield* ProjectStore.ProjectStoreV2;
      const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const contextCache = yield* VoiceContextCache;
      const voiceProvider = yield* RealtimeVoiceProvider;

      const toolDeps: VoiceToolsDeps = {
        orchestrator,
        threadManagement,
        threadLaunch,
        projectStore,
        managedFolders,
        serverSettings,
        providerRegistry,
        contextCache,
      };

      const sessions = new Map<string, ActiveSession>();

      const emitEvent = (session: ActiveSession, partial: ServerEventWithoutSeq) => {
        if (session.disposed && partial.type !== "session_ended") return;
        const seq = ++session.seq;
        const event = { ...partial, seq } as TalkToFleetServerEvent;
        session.history.push(event);
        if (session.history.length > SESSION_HISTORY_LIMIT) {
          session.history.shift();
        }
        if (event.type === "card") {
          session.cards.set(event.card.id, event.card);
        } else if (event.type === "phase") {
          session.phase = event.phase;
        }
        session.attached?.offer({ kind: "json", event });
      };

      const disposeSession = (session: ActiveSession, reason: string, notifyClient: boolean) => {
        if (session.disposed) return;
        session.disposed = true;
        if (session.orphanTimer !== null) {
          clearTimeout(session.orphanTimer);
          session.orphanTimer = null;
        }
        sessions.delete(session.sessionId);
        const conn = session.providerConn;
        session.providerConn = null;
        conn?.close();
        if (notifyClient) {
          const seq = ++session.seq;
          session.attached?.offer({
            kind: "json",
            event: { type: "session_ended", seq, reason },
          });
          session.attached?.offer({ kind: "close", code: 1000, reason });
        }
        session.attached = null;
      };

      const startProviderForSession = async (
        session: ActiveSession,
        options: { readonly greet: boolean },
      ) => {
        const external = await runPromise(contextCache.getSnapshot);
        const live = await runPromise(readLiveBrowneSnapshot(toolDeps, session.scopedThreadId));
        if (session.disposed) return;

        if (live.scopedThread) {
          session.scopedThreadTitle = live.scopedThread.title;
          session.trackedThreads.set(live.scopedThread.id, live.scopedThread.title);
        }

        const briefing = buildVoiceBriefing({ external, live });
        session.contextBuiltAt = briefing.builtAt;
        session.degradedSources = briefing.degradedSources;
        const systemPrompt = buildVoiceSystemPrompt({
          briefingText: briefing.text,
          ...(live.scopedThread
            ? {
                scopedThread: {
                  title: live.scopedThread.title,
                  projectTitle: live.scopedThread.projectTitle,
                },
              }
            : {}),
        });
        const welcomeMessage = options.greet
          ? buildGreetingMessage(live.scopedThread?.title)
          : null;
        const boostedKeywords = extractBoostedKeywordsFromSnapshot(live);

        try {
          const conn = await voiceProvider.connect(
            {
              systemPrompt,
              welcomeMessage,
              tools: VOICE_TOOL_DEFINITIONS,
              intelligenceLevel: "high",
              boostedKeywords,
            },
            {
              onReady: ({ provider, model }) => {
                if (session.disposed) return;
                session.providerReady = true;
                session.providerName = provider;
                session.modelName = model;
                emitEvent(session, {
                  type: "ready",
                  sessionId: session.sessionId,
                  provider,
                  model,
                  scopedThreadId: session.scopedThreadId ?? null,
                  scopedThreadTitle: session.scopedThreadTitle,
                  contextBuiltAt: session.contextBuiltAt,
                  degradedSources: session.degradedSources,
                });
                emitEvent(session, { type: "phase", phase: "listening" });
              },
              onAudio: (pcm24k) => {
                if (session.disposed || session.dropAudioUntilNextAssistantTurn) return;
                const bytes = encodeTalkToFleetAudioFrame(
                  TALK_TO_FLEET_FRAME_SERVER_AUDIO,
                  session.turnId,
                  pcm24k,
                );
                session.attached?.offer({ kind: "audio", bytes });
              },
              onTranscript: (speaker, delta) => {
                if (session.disposed || delta.length === 0) return;
                if (session.activeTranscriptSpeaker !== speaker || !session.activeTranscriptId) {
                  session.activeTranscriptSpeaker = speaker;
                  session.activeTranscriptId = `${session.sessionId}:turn:${session.seq + 1}:${speaker}`;
                }
                emitEvent(session, {
                  type: "transcript",
                  id: session.activeTranscriptId,
                  speaker,
                  delta,
                });
              },
              onAssistantSpeakingChanged: (speaking) => {
                if (session.disposed) return;
                if (speaking) {
                  session.dropAudioUntilNextAssistantTurn = false;
                  session.turnId += 1;
                  emitEvent(session, { type: "phase", phase: "speaking" });
                } else {
                  emitEvent(session, { type: "phase", phase: "listening" });
                }
              },
              onUserSpeakingChanged: (speaking) => {
                if (session.disposed) return;
                session.userSpeaking = speaking;
              },
              onUserInterrupted: () => {
                if (session.disposed) return;
                session.turnId += 1;
                session.dropAudioUntilNextAssistantTurn = false;
                session.activeTranscriptSpeaker = "you";
                session.activeTranscriptId = null;
                emitEvent(session, { type: "interrupt", turnId: session.turnId });
                emitEvent(session, { type: "phase", phase: "listening" });
              },
              onToolCall: (callId, name, args) => {
                if (session.disposed) return;
                emitEvent(session, { type: "phase", phase: "thinking" });
                emitEvent(session, { type: "status_detail", message: `Running ${name}...` });
                void runPromise(
                  executeVoiceTool({
                    deps: toolDeps,
                    callId,
                    name,
                    args,
                    scopedThreadId: session.scopedThreadId,
                    emitCard: (card) => emitEvent(session, { type: "card", card }),
                    trackThread: (threadId, title) => {
                      session.trackedThreads.set(threadId, title ?? threadId);
                    },
                  }),
                ).then((result) => {
                  if (session.disposed) return;
                  if (session.cancelledToolCalls.delete(callId)) {
                    emitEvent(session, { type: "status_detail", message: null });
                    const bounded = JSON.stringify(boundPhonicToolOutput({ tool: name, result }));
                    session.providerConn?.sendSystemNote(
                      `[Browne update] Untrusted late evidence for an interrupted tool call. Use if relevant; do not interrupt Nick to announce it. ${bounded}`,
                    );
                    return;
                  }
                  emitEvent(session, { type: "status_detail", message: null });
                  session.providerConn?.sendToolOutput(callId, result);
                });
              },
              onToolCallInterrupted: (callId) => {
                session.cancelledToolCalls.add(callId);
              },
              onError: (code, message, recoverable) => {
                if (session.disposed) return;
                emitEvent(session, { type: "error", code, message, recoverable });
                if (!recoverable) {
                  disposeSession(session, code, true);
                }
              },
              onClosed: (reason) => {
                if (session.disposed) return;
                disposeSession(session, reason, true);
              },
            },
          );
          if (session.disposed) {
            conn.close();
            return;
          }
          session.providerConn = conn;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to initialize live voice session.";
          emitEvent(session, {
            type: "error",
            code: "provider_connect_failed",
            message,
            recoverable: false,
          });
          disposeSession(session, "provider_connect_failed", true);
        }
      };

      // Single background domain event listener notifies active sessions when tracked or scoped threads update.
      yield* orchestrator.streamDomainEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (sessions.size === 0) return;
            if (event.type !== "run.updated" && event.type !== "runtime-request.updated") return;
            const threadId = event.threadId;

            for (const session of sessions.values()) {
              if (session.disposed) continue;
              const isScopedMain = session.scopedThreadId === threadId;
              if (!isScopedMain && !session.trackedThreads.has(threadId)) continue;
              const threadTitle = session.trackedThreads.get(threadId) ?? "Thread";
              const tag = isScopedMain ? "[Main session update]" : "[Browne update]";

              if (event.type === "runtime-request.updated" && event.payload.status === "pending") {
                emitEvent(session, {
                  type: "card",
                  card: {
                    kind: "approval",
                    id: `approval:${event.payload.id}`,
                    threadId,
                    requestId: event.payload.id,
                    threadTitle,
                    summary: `${event.payload.kind} approval needed`,
                    status: "pending",
                    updatedAt: new Date().toISOString(),
                  },
                });
                session.providerConn?.sendSystemNote(
                  `${tag} Thread '${threadTitle}' needs ${event.payload.kind} approval.`,
                );
              }

              if (
                event.type === "run.updated" &&
                isScopedMain &&
                event.payload.status === "running"
              ) {
                session.providerConn?.sendSystemNote(
                  `${tag} Main thread '${threadTitle}' started a new active run.`,
                );
              }

              if (
                event.type === "run.updated" &&
                (event.payload.status === "completed" || event.payload.status === "failed")
              ) {
                const runStatus = event.payload.status;
                const projection = yield* orchestrator
                  .getThreadProjection(threadId)
                  .pipe(Effect.orElseSucceed(() => null));
                if (session.disposed) continue;
                const resolvedTitle = projection?.thread.title ?? threadTitle;
                if (isScopedMain && projection?.thread.title) {
                  session.scopedThreadTitle = projection.thread.title;
                  session.trackedThreads.set(threadId, projection.thread.title);
                }
                const lastUser = projection?.messages
                  .filter((m) => m.role === "user" && m.text.trim().length > 0)
                  .at(-1)?.text;
                const lastAssistant = projection?.messages
                  .filter((m) => m.role === "assistant" && m.text.trim().length > 0)
                  .at(-1)?.text;
                const summary = lastAssistant?.replace(/\s+/gu, " ").trim().slice(0, 180);
                emitEvent(session, {
                  type: "card",
                  card: {
                    kind: "thread",
                    id: `thread:${threadId}`,
                    threadId,
                    title: resolvedTitle,
                    status: runStatus === "completed" ? "completed" : "failed",
                    ...(summary ? { summary } : {}),
                    updatedAt: new Date().toISOString(),
                  },
                });
                const promptContext =
                  isScopedMain && lastUser
                    ? ` (user prompt: ${lastUser.replace(/\s+/gu, " ").trim().slice(0, 120)})`
                    : "";
                const note = summary
                  ? `${tag} Thread '${resolvedTitle}' ${runStatus}${promptContext}: ${summary}`
                  : `${tag} Thread '${resolvedTitle}' ${runStatus}${promptContext}.`;
                if (
                  session.phase === "listening" &&
                  !session.clientSpeaking &&
                  !session.userSpeaking
                ) {
                  session.providerConn?.generateReply(note);
                } else {
                  session.providerConn?.sendSystemNote(note);
                }
              }
            }
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("talk-to-fleet domain event listener stopped", { cause }),
        ),
        Effect.forkScoped,
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const session of sessions.values()) {
            disposeSession(session, "server_shutdown", false);
          }
        }),
      );

      const runSocket = Effect.fn("voice.runSocket")(function* (
        socket: Socket.Socket,
        queryThreadId?: string,
      ) {
        yield* Effect.gen(function* () {
          const connectionId = NodeCrypto.randomUUID();
          const outboundQueue = yield* Queue.unbounded<OutboundFrame>();
          const writer = yield* socket.writer;
          const reader = yield* socket.reader;

          const socketSession: { current: ActiveSession | null } = { current: null };
          let socketClosed = false;

          const offerFrame = (frame: OutboundFrame) => {
            if (socketClosed) return;
            runSync(Queue.offer(outboundQueue, frame));
          };

          const writerFiber = yield* Effect.gen(function* () {
            while (true) {
              const frame = yield* Queue.take(outboundQueue);
              if (frame.kind === "close") {
                yield* writer.write(new Socket.CloseEvent(frame.code, frame.reason));
                return;
              }
              if (frame.kind === "json") {
                yield* writer.write(JSON.stringify(frame.event));
              } else {
                yield* writer.write(frame.bytes);
              }
            }
          }).pipe(Effect.ignore, Effect.forkScoped);

          const attachSession = (session: ActiveSession, lastEventSeq?: number) => {
            if (session.orphanTimer !== null) {
              clearTimeout(session.orphanTimer);
              session.orphanTimer = null;
            }
            if (session.attached && session.attached.connectionId !== connectionId) {
              session.attached.offer({
                kind: "close",
                code: 1000,
                reason: "replaced_by_reconnect",
              });
            }
            session.attached = { connectionId, offer: offerFrame };
            socketSession.current = session;

            if (session.providerReady) {
              const readyEvent: TalkToFleetServerEvent = {
                type: "ready",
                seq: ++session.seq,
                sessionId: session.sessionId,
                provider: session.providerName,
                model: session.modelName,
                scopedThreadId: session.scopedThreadId ?? null,
                scopedThreadTitle: session.scopedThreadTitle,
                contextBuiltAt: session.contextBuiltAt,
                degradedSources: session.degradedSources,
              };
              offerFrame({ kind: "json", event: readyEvent });
              const since = lastEventSeq ?? 0;
              for (const event of session.history) {
                if (event.seq > since) {
                  offerFrame({ kind: "json", event });
                }
              }
              offerFrame({
                kind: "json",
                event: { type: "phase", seq: ++session.seq, phase: session.phase },
              });
            }
          };

          const createSession = (scopedThreadId?: string, greet = true) => {
            const sessionId = NodeCrypto.randomUUID();
            const session: ActiveSession = {
              sessionId,
              ...(scopedThreadId ? { scopedThreadId } : {}),
              trackedThreads: new Map(scopedThreadId ? [[scopedThreadId, "Current thread"]] : []),
              cancelledToolCalls: new Set(),
              history: [],
              cards: new Map(),
              seq: 0,
              turnId: 1,
              phase: "listening",
              providerName: voiceProvider.id,
              modelName: "phonic-1",
              scopedThreadTitle: null,
              contextBuiltAt: null,
              degradedSources: [],
              activeTranscriptId: null,
              activeTranscriptSpeaker: null,
              clientSpeaking: false,
              userSpeaking: false,
              dropAudioUntilNextAssistantTurn: false,
              providerReady: false,
              providerConn: null,
              attached: { connectionId, offer: offerFrame },
              orphanTimer: null,
              disposed: false,
            };
            sessions.set(sessionId, session);
            socketSession.current = session;
            void startProviderForSession(session, { greet });
            return session;
          };

          const handleControl = Effect.fn("voice.handleControl")(function* (rawText: string) {
            if (textEncoder.encode(rawText).byteLength > TALK_TO_FLEET_MAX_CONTROL_BYTES) {
              return;
            }
            const parsed = yield* decodeClientMessage(rawText).pipe(Effect.result);
            if (parsed._tag === "Failure") return;
            const msg = parsed.success;

            if (msg.type === "config") {
              const existing = msg.sessionId ? sessions.get(msg.sessionId) : undefined;
              if (existing && !existing.disposed) {
                attachSession(existing, msg.lastEventSeq);
                return;
              }
              if (socketSession.current !== null && !socketSession.current.disposed) {
                return;
              }
              const scoped = msg.mode === "fleet" ? undefined : (msg.threadId ?? queryThreadId);
              createSession(scoped, msg.greet !== false);
              return;
            }

            const session = socketSession.current;
            if (!session || session.disposed) return;

            if (msg.type === "hangup") {
              disposeSession(session, "hangup", true);
              return;
            }

            if (msg.type === "new_session") {
              const scoped = session.scopedThreadId;
              disposeSession(session, "new_session", false);
              const next = createSession(scoped, true);
              attachSession(next);
              return;
            }

            if (msg.type === "interrupt_assistant") {
              session.turnId += 1;
              session.dropAudioUntilNextAssistantTurn = true;
              session.clientSpeaking = false;
              emitEvent(session, { type: "interrupt", turnId: session.turnId });
              emitEvent(session, { type: "phase", phase: "listening" });
              return;
            }

            if (msg.type === "playback_state") {
              session.clientSpeaking = msg.speaking;
              return;
            }

            if (msg.type === "approve") {
              const commandId = CommandId.make(`voice-tap:${NodeCrypto.randomUUID()}`);
              const res = yield* orchestrator
                .dispatch({
                  type: "runtime-request.respond",
                  commandId,
                  threadId: ThreadId.make(msg.threadId),
                  requestId: RuntimeRequestId.make(msg.requestId),
                  decision: msg.decision,
                })
                .pipe(Effect.result);
              if (res._tag === "Success") {
                const threadTitle = session.trackedThreads.get(msg.threadId) ?? "Thread";
                emitEvent(session, {
                  type: "card",
                  card: {
                    kind: "approval",
                    id: `approval:${msg.requestId}`,
                    threadId: msg.threadId,
                    requestId: msg.requestId,
                    threadTitle,
                    summary: `Decision: ${msg.decision}`,
                    status: msg.decision === "accept" ? "approved" : "declined",
                    updatedAt: new Date().toISOString(),
                  },
                });
                session.providerConn?.sendSystemNote(
                  `[Browne UI] Nick ${msg.decision === "accept" ? "approved" : "declined"} request on thread '${threadTitle}'.`,
                );
              } else {
                emitEvent(session, {
                  type: "error",
                  code: "approval_dispatch_failed",
                  message: "Could not submit approval decision.",
                  recoverable: true,
                });
              }
            }
          });

          const handleBinary = (bytes: Uint8Array) => {
            if (bytes.byteLength > TALK_TO_FLEET_MAX_AUDIO_BYTES) return;
            const session = socketSession.current;
            if (!session || session.disposed || !session.providerConn) return;
            const frame = decodeTalkToFleetAudioFrame(bytes);
            if (!frame || frame.kind !== TALK_TO_FLEET_FRAME_CLIENT_AUDIO) return;
            session.providerConn.sendAudio16k(frame.pcm);
          };

          yield* Effect.gen(function* () {
            while (true) {
              const frames = yield* reader.pull;
              for (const frame of frames) {
                if (typeof frame === "string") {
                  yield* handleControl(frame);
                } else {
                  handleBinary(frame);
                }
              }
            }
          }).pipe(Effect.ignore);

          socketClosed = true;
          yield* Fiber.interrupt(writerFiber);

          const session = socketSession.current;
          if (session && !session.disposed && session.attached?.connectionId === connectionId) {
            session.attached = null;
            session.orphanTimer = setTimeout(() => {
              disposeSession(session, "reconnect_timeout", false);
            }, SESSION_RECONNECT_TTL_MS);
          }
        }).pipe(Effect.scoped, Effect.ignore);
      });

      return TalkToFleetService.of({
        runSocket,
        activeSessionCount: Effect.sync(() => sessions.size),
      });
    }),
  );
}
