// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Exercises real loopback WebSocket client framing.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  RuntimeRequestId,
  TALK_TO_FLEET_FRAME_CLIENT_AUDIO,
  TalkToFleetServerEvent,
  ThreadId,
  decodeTalkToFleetAudioFrame,
  encodeTalkToFleetAudioFrame,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import { expect } from "vite-plus/test";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  RealtimeVoiceProvider,
  type VoiceProviderCallbacks,
  type VoiceProviderConnection,
} from "./RealtimeVoiceProvider.ts";
import { TalkToFleetService } from "./TalkToFleetService.ts";
import { VoiceContextCache } from "./VoiceContextCache.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(TalkToFleetServerEvent));

type SocketItem =
  | { readonly kind: "event"; readonly event: TalkToFleetServerEvent }
  | { readonly kind: "audio"; readonly turnId: number; readonly pcm: Uint8Array };

function connectClient(url: string, configMsg: Record<string, unknown>) {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const items: SocketItem[] = [];
  let waiter: ReturnType<typeof Promise.withResolvers<SocketItem>> | undefined;

  const push = (item: SocketItem) => {
    if (waiter) {
      const current = waiter;
      waiter = undefined;
      current.resolve(item);
    } else {
      items.push(item);
    }
  };

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify(configMsg));
  });
  socket.addEventListener("message", ({ data }) => {
    if (typeof data === "string") {
      push({ kind: "event", event: decodeEvent(data) });
      return;
    }
    const bytes = new Uint8Array(data as ArrayBuffer);
    const decoded = decodeTalkToFleetAudioFrame(bytes);
    if (decoded) {
      push({ kind: "audio", turnId: decoded.turnId, pcm: decoded.pcm });
    }
  });
  socket.addEventListener("error", () => waiter?.reject(new Error("Voice socket error")));

  const next = () => {
    const existing = items.shift();
    if (existing) return Promise.resolve(existing);
    waiter = Promise.withResolvers<SocketItem>();
    return waiter.promise;
  };

  const nextEvent = async (): Promise<TalkToFleetServerEvent> => {
    while (true) {
      const item = await next();
      if (item.kind === "event") return item.event;
    }
  };

  return { socket, next, nextEvent };
}

it.live(
  "routes audio frames, executes tools, handles barge-in interrupts, dispatches approvals, and replays missed events on reconnect",
  () => {
    const uplinkChunks: Uint8Array[] = [];
    const uplinkArrived = Promise.withResolvers<void>();
    const dispatchedCommands: unknown[] = [];
    const systemNotes: string[] = [];
    const toolOutputs: Array<{ readonly callId: string; readonly output: unknown }> = [];
    let activeCallbacks: VoiceProviderCallbacks | null = null;
    let closedCount = 0;

    const fakeProviderLayer = Layer.succeed(
      RealtimeVoiceProvider,
      RealtimeVoiceProvider.of({
        id: "phonic-mock",
        connect: async (_config, callbacks) => {
          activeCallbacks = callbacks;
          const connection: VoiceProviderConnection = {
            sendAudio16k: (pcm) => {
              uplinkChunks.push(pcm);
              uplinkArrived.resolve();
            },
            sendToolOutput: (callId, output) => {
              toolOutputs.push({ callId, output });
            },
            sendSystemNote: (text) => {
              systemNotes.push(text);
            },
            generateReply: () => {},
            close: () => {
              closedCount += 1;
            },
          };
          queueMicrotask(() => {
            callbacks.onReady({ provider: "phonic-mock", model: "phonic-1" });
          });
          return connection;
        },
      }),
    );

    const fakeCacheLayer = Layer.succeed(
      VoiceContextCache,
      VoiceContextCache.of({
        getSnapshot: Effect.succeed({
          builtAt: "2026-11-26T15:00:00.000Z",
          planSummary: "Focus: Test suite",
          planStatus: { status: "ok", fetchedAt: "Thu, Nov 26, 2026, 10:00" },
          mailSummary: "No unread mail",
          mailStatus: { status: "ok", fetchedAt: "Thu, Nov 26, 2026, 10:00" },
          wikiSummary: "Wiki ok",
          wikiStatus: { status: "ok", fetchedAt: "Thu, Nov 26, 2026, 10:00" },
        }),
        refreshNow: Effect.die("unused"),
      }),
    );

    const fakeOrchestratorLayer = Layer.succeed(Orchestrator.OrchestratorV2, {
      getShellSnapshot: () =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 1,
          threads: [],
          archivedThreads: [],
        }),
      getThreadProjection: () => Effect.die("unused"),
      dispatch: (command: unknown) =>
        Effect.sync(() => {
          dispatchedCommands.push(command);
          return {
            sequence: 1,
            result: {
              commandId: CommandId.make("c-1"),
              aggregateVersion: 1,
              events: [],
            },
          };
        }),
      streamDomainEvents: Stream.empty,
    } as unknown as Orchestrator.OrchestratorV2["Service"]);

    const fakeProjectsLayer = Layer.succeed(ProjectStore.ProjectStoreV2, {
      listShells: () => Effect.succeed([]),
    } as unknown as ProjectStore.ProjectStoreV2["Service"]);

    const fakeThreadManagementLayer = Layer.succeed(
      ThreadManagement.ThreadManagementService,
      {} as ThreadManagement.ThreadManagementService["Service"],
    );
    const fakeThreadLaunchLayer = Layer.succeed(
      ThreadLaunch.ThreadLaunchService,
      {} as ThreadLaunch.ThreadLaunchService["Service"],
    );
    const fakeManagedFoldersLayer = Layer.succeed(ManagedProjectFolders.ManagedProjectFolders, {
      ensureScratchProject: Effect.succeed({ projectId: ProjectId.make("proj-scratch") }),
    } as unknown as ManagedProjectFolders.ManagedProjectFolders["Service"]);
    const fakeServerSettingsLayer = Layer.succeed(ServerSettings.ServerSettingsService, {
      getSettings: Effect.die("unused"),
    } as unknown as ServerSettings.ServerSettingsService["Service"]);
    const fakeProviderRegistryLayer = Layer.succeed(ProviderRegistry.ProviderRegistry, {
      getProviders: Effect.succeed([]),
    } as unknown as ProviderRegistry.ProviderRegistry["Service"]);

    const depsLayer = Layer.mergeAll(
      fakeProviderLayer,
      fakeCacheLayer,
      fakeOrchestratorLayer,
      fakeProjectsLayer,
      fakeThreadManagementLayer,
      fakeThreadLaunchLayer,
      fakeManagedFoldersLayer,
      fakeServerSettingsLayer,
      fakeProviderRegistryLayer,
    );

    const program = Effect.gen(function* () {
      const talkToFleet = yield* TalkToFleetService;
      const routes = HttpRouter.add(
        "GET",
        "/ws/talk-to-fleet",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const socket = yield* request.upgrade;
          yield* talkToFleet.runSocket(socket).pipe(Effect.scoped);
          return HttpServerResponse.empty();
        }),
      );
      yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
      const server = yield* HttpServer.HttpServer;
      const address = server.address as NetAddress.InetAddress;
      const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
      const url = `ws://${host}:${address.port}/ws/talk-to-fleet`;

      yield* Effect.promise(async () => {
        const client1 = connectClient(url, { type: "config", greet: true });
        try {
          const ready = await client1.nextEvent();
          expect(ready.type).toBe("ready");
          if (ready.type !== "ready") throw new Error("Expected ready event");
          const sessionId = ready.sessionId;
          expect(ready.provider).toBe("phonic-mock");

          const initialPhase = await client1.nextEvent();
          expect(initialPhase).toMatchObject({ type: "phase", phase: "listening" });

          // Uplink 16kHz PCM frame
          const uplink = encodeTalkToFleetAudioFrame(
            TALK_TO_FLEET_FRAME_CLIENT_AUDIO,
            0,
            new Uint8Array([1, 2, 3, 4]),
          );
          client1.socket.send(uplink);
          await uplinkArrived.promise;
          expect(uplinkChunks.length).toBe(1);
          expect(Array.from(uplinkChunks[0]!)).toEqual([1, 2, 3, 4]);

          // Downlink 24kHz audio + speaking turnId bump
          activeCallbacks?.onAssistantSpeakingChanged(true);
          expect(await client1.nextEvent()).toMatchObject({ type: "phase", phase: "speaking" });
          activeCallbacks?.onAudio(new Uint8Array([9, 8, 7, 6]));
          const audioFrame = await client1.next();
          expect(audioFrame.kind).toBe("audio");
          if (audioFrame.kind === "audio") {
            expect(audioFrame.turnId).toBe(2);
            expect(Array.from(audioFrame.pcm)).toEqual([9, 8, 7, 6]);
          }

          // User barge-in emits interrupt with new turnId
          activeCallbacks?.onUserInterrupted();
          const interrupt = await client1.nextEvent();
          expect(interrupt).toMatchObject({ type: "interrupt", turnId: 3 });
          expect(await client1.nextEvent()).toMatchObject({ type: "phase", phase: "listening" });

          // Tool call emits running & done cards and posts output back to provider
          activeCallbacks?.onToolCall("call-1", "browne_threads", { action: "list" });
          const thinkingPhase = await client1.nextEvent();
          expect(thinkingPhase).toMatchObject({ type: "phase", phase: "thinking" });
          const statusDetail = await client1.nextEvent();
          expect(statusDetail).toMatchObject({ type: "status_detail" });
          const runningCard = await client1.nextEvent();
          expect(runningCard).toMatchObject({
            type: "card",
            card: { kind: "tool", id: "tool:call-1", status: "running" },
          });
          const doneCard = await client1.nextEvent();
          expect(doneCard).toMatchObject({
            type: "card",
            card: { kind: "tool", id: "tool:call-1", status: "done" },
          });
          const clearDetail = await client1.nextEvent();
          expect(clearDetail).toMatchObject({ type: "status_detail", message: null });
          expect(toolOutputs.length).toBe(1);

          // Disconnect without hangup, trigger an event while offline, and reconnect with lastEventSeq
          const lastSeqBeforeDrop = clearDetail.seq;
          const closedClient1 = Promise.withResolvers<void>();
          client1.socket.addEventListener("close", () => closedClient1.resolve(), { once: true });
          client1.socket.close();
          await closedClient1.promise;
          expect(closedCount).toBe(0);

          activeCallbacks?.onTranscript("fleet", "Missed while offline");

          const client2 = connectClient(url, {
            type: "config",
            sessionId,
            lastEventSeq: lastSeqBeforeDrop,
          });
          try {
            const readyResume = await client2.nextEvent();
            expect(readyResume).toMatchObject({ type: "ready", sessionId });
            const replayedTranscript = await client2.nextEvent();
            expect(replayedTranscript).toMatchObject({
              type: "transcript",
              speaker: "fleet",
              delta: "Missed while offline",
            });
            const phaseAfterResume = await client2.nextEvent();
            expect(phaseAfterResume.type).toBe("phase");

            // Approve action over WebSocket dispatches orchestrator command directly
            client2.socket.send(
              JSON.stringify({
                type: "approve",
                threadId: "thread-1",
                requestId: "req-1",
                decision: "accept",
              }),
            );
            const approvedCard = await client2.nextEvent();
            expect(approvedCard).toMatchObject({
              type: "card",
              card: { kind: "approval", requestId: "req-1", status: "approved" },
            });
            expect(dispatchedCommands[0]).toMatchObject({
              type: "runtime-request.respond",
              threadId: ThreadId.make("thread-1"),
              requestId: RuntimeRequestId.make("req-1"),
              decision: "accept",
            });
            expect(systemNotes.some((n) => n.includes("approved request"))).toBe(true);

            // Hangup terminates session and closes provider
            client2.socket.send(JSON.stringify({ type: "hangup" }));
            const ended = await client2.nextEvent();
            expect(ended).toMatchObject({ type: "session_ended", reason: "hangup" });
            expect(closedCount).toBe(1);
          } finally {
            client2.socket.close();
          }
        } finally {
          client1.socket.close();
        }
      });
    });

    return program.pipe(
      Effect.provide(
        Layer.mergeAll(
          TalkToFleetService.layer.pipe(Layer.provide(depsLayer)),
          NodeHttpServer.layerTest,
        ),
      ),
    );
  },
);
