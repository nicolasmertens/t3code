import { describe, expect, it } from "@effect/vitest";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, vi } from "vite-plus/test";

import {
  __resetDirectPushTargetsForTest,
  mergeDirectAgentActivityAggregates,
  readAgentActivitySnapshotDirect,
  registerDeviceDirect,
  registerLiveActivityDirect,
  setDirectPushTargets,
  unregisterDeviceDirect,
} from "./directPushClient";

describe("directPushClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetDirectPushTargetsForTest();
    vi.restoreAllMocks();
  });

  it.effect("registers and unregisters devices and live activities with bearer auth", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly url: string;
        readonly method: string | undefined;
        readonly headers: Record<string, string>;
        readonly body: string | undefined;
      }> = [];
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method,
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      setDirectPushTargets([
        {
          environmentId: "env-1" as EnvironmentId,
          httpBaseUrl: "https://server-one.ts.net/",
          httpAuthorization: { _tag: "Bearer", token: "tok-1" },
          bearerToken: "tok-1",
        },
      ]);

      const deviceRegistered = yield* registerDeviceDirect({
        deviceId: "dev-1",
        label: "NiPhone17",
        platform: "ios",
        iosMajorVersion: 19,
        bundleId: "com.nicolasmertens.browne",
        apsEnvironment: "sandbox",
        pushToken: "apns-tok-1",
        preferences: {
          liveActivitiesEnabled: true,
          notificationsEnabled: true,
          notifyOnApproval: true,
          notifyOnInput: true,
          notifyOnCompletion: true,
          notifyOnFailure: true,
        },
      });
      const liveActivityRegistered = yield* registerLiveActivityDirect({
        deviceId: "dev-1",
        activityPushToken: "la-tok-1",
      });
      yield* unregisterDeviceDirect("dev-1");

      expect(deviceRegistered).toBe(true);
      expect(liveActivityRegistered).toBe(true);
      expect(calls).toHaveLength(3);
      expect(calls[0]).toMatchObject({
        url: "https://server-one.ts.net/api/direct-push/devices",
        method: "POST",
        headers: {
          authorization: "Bearer tok-1",
          "content-type": "application/json",
        },
      });
      expect(calls[1]).toMatchObject({
        url: "https://server-one.ts.net/api/direct-push/live-activities",
        method: "POST",
        headers: {
          authorization: "Bearer tok-1",
          "content-type": "application/json",
        },
      });
      expect(calls[2]).toMatchObject({
        url: "https://server-one.ts.net/api/direct-push/devices/dev-1",
        method: "DELETE",
        headers: {
          authorization: "Bearer tok-1",
        },
      });
    }),
  );

  it.effect("signs DPoP proofs when target authorization uses DPoP", () => {
    const createProof = vi.fn(() => Effect.succeed("dpop-proof-xyz"));
    const capturedHeaders: Array<Record<string, string>> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    setDirectPushTargets([
      {
        environmentId: "env-dpop" as EnvironmentId,
        httpBaseUrl: "https://dpop.ts.net",
        httpAuthorization: {
          _tag: "Dpop",
          accessToken: "dpop-access-1",
          expiresAtEpochMs: 9_999_999_999_999,
        },
        bearerToken: null,
      },
    ]);

    const signerLayer = Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, {
      createProof,
    } as never);

    return Effect.gen(function* () {
      const registered = yield* registerLiveActivityDirect({
        deviceId: "dev-dpop",
        activityPushToken: "la-tok-dpop",
      });

      expect(registered).toBe(true);
      expect(createProof).toHaveBeenCalledWith({
        method: "POST",
        url: "https://dpop.ts.net/api/direct-push/live-activities",
        accessToken: "dpop-access-1",
      });
      expect(capturedHeaders[0]).toEqual({
        authorization: "DPoP dpop-access-1",
        dpop: "dpop-proof-xyz",
        "content-type": "application/json",
      });
    }).pipe(Effect.provide(signerLayer));
  });

  it.effect(
    "merges multi-host snapshots by phase priority and updatedAt and survives failing hosts",
    () =>
      Effect.gen(function* () {
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.startsWith("https://host-down.ts.net")) {
            return new Response("Not Found", { status: 404 });
          }
          if (url.startsWith("https://host-error.ts.net")) {
            throw new Error("Connection reset");
          }
          if (url.startsWith("https://host-a.ts.net")) {
            return new Response(
              JSON.stringify({
                aggregate: {
                  title: "Browne",
                  subtitle: "Agent work in progress",
                  activeCount: 1,
                  updatedAt: "2026-11-24T12:00:00.000Z",
                  activities: [
                    {
                      environmentId: "env-a" as EnvironmentId,
                      threadId: "thread-completed" as ThreadId,
                      projectTitle: "repo-a",
                      threadTitle: "Completed older",
                      modelTitle: "GPT-5",
                      phase: "completed",
                      status: "Completed",
                      updatedAt: "2026-11-24T12:00:00.000Z",
                      deepLink: "/threads/env-a/thread-completed",
                    },
                    {
                      environmentId: "env-a" as EnvironmentId,
                      threadId: "thread-running" as ThreadId,
                      projectTitle: "repo-a",
                      threadTitle: "Running work",
                      modelTitle: "GPT-5",
                      phase: "running",
                      status: "Working",
                      updatedAt: "2026-11-24T11:59:00.000Z",
                      deepLink: "/threads/env-a/thread-running",
                    },
                  ],
                },
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              aggregate: {
                title: "Browne",
                subtitle: "Agent work in progress",
                activeCount: 2,
                updatedAt: "2026-11-24T12:05:00.000Z",
                activities: [
                  {
                    environmentId: "env-b" as EnvironmentId,
                    threadId: "thread-approval" as ThreadId,
                    projectTitle: "repo-b",
                    threadTitle: "Needs approval",
                    modelTitle: "Claude",
                    phase: "waiting_for_approval",
                    status: "Approval needed",
                    updatedAt: "2026-11-24T12:04:00.000Z",
                    deepLink: "/threads/env-b/thread-approval",
                  },
                  {
                    environmentId: "env-b" as EnvironmentId,
                    threadId: "thread-failed" as ThreadId,
                    projectTitle: "repo-b",
                    threadTitle: "Failed task",
                    modelTitle: "Claude",
                    phase: "failed",
                    status: "Failed",
                    updatedAt: "2026-11-24T12:03:00.000Z",
                    deepLink: "/threads/env-b/thread-failed",
                  },
                  {
                    environmentId: "env-b" as EnvironmentId,
                    threadId: "thread-run-2" as ThreadId,
                    projectTitle: "repo-b",
                    threadTitle: "Running task 2",
                    modelTitle: "Claude",
                    phase: "running",
                    status: "Working",
                    updatedAt: "2026-11-24T12:05:00.000Z",
                    deepLink: "/threads/env-b/thread-run-2",
                  },
                  {
                    environmentId: "env-b" as EnvironmentId,
                    threadId: "thread-extra" as ThreadId,
                    projectTitle: "repo-b",
                    threadTitle: "Oldest extra",
                    modelTitle: "Claude",
                    phase: "completed",
                    status: "Completed",
                    updatedAt: "2026-11-24T11:00:00.000Z",
                    deepLink: "/threads/env-b/thread-extra",
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }) as typeof fetch;

        setDirectPushTargets([
          {
            environmentId: "env-down" as EnvironmentId,
            httpBaseUrl: "https://host-down.ts.net",
            httpAuthorization: { _tag: "Bearer", token: "t0" },
            bearerToken: "t0",
          },
          {
            environmentId: "env-error" as EnvironmentId,
            httpBaseUrl: "https://host-error.ts.net",
            httpAuthorization: { _tag: "Bearer", token: "t1" },
            bearerToken: "t1",
          },
          {
            environmentId: "env-a" as EnvironmentId,
            httpBaseUrl: "https://host-a.ts.net",
            httpAuthorization: { _tag: "Bearer", token: "ta" },
            bearerToken: "ta",
          },
          {
            environmentId: "env-b" as EnvironmentId,
            httpBaseUrl: "https://host-b.ts.net",
            httpAuthorization: { _tag: "Bearer", token: "tb" },
            bearerToken: "tb",
          },
        ]);

        const snapshot = yield* readAgentActivitySnapshotDirect();
        expect(snapshot).not.toBeNull();
        expect(snapshot?.aggregate?.title).toBe("Browne");
        expect(snapshot?.aggregate?.activeCount).toBe(3);
        expect(snapshot?.aggregate?.activities.map((row) => row.threadId)).toEqual([
          "thread-approval",
          "thread-failed",
          "thread-run-2",
          "thread-running",
          "thread-completed",
        ]);

        expect(mergeDirectAgentActivityAggregates([null, null])).toEqual({ aggregate: null });
      }),
  );
});
