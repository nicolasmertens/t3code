// @effect-diagnostics nodeBuiltinImport:off -- Uses Node crypto to generate test P-256 ECDSA keys and verify JWT signatures.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { makeAggregateState } from "./directApnsAggregate.ts";
import {
  createApnsJwtSigner,
  createDirectApnsClient,
  MAX_LIVE_ACTIVITY_PAYLOAD_BYTES,
  makeLiveActivityRequest,
  type DirectApnsDeliveryResult,
  type DirectApnsHttp2TransportInput,
} from "./directApnsClient.ts";
import { loadDirectApnsConfig } from "./directApnsConfig.ts";
import * as DirectApnsService from "./DirectApnsService.ts";

const NOW_ISO = "2026-10-18T10:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const ENV_ID = EnvironmentId.make("env-1");
const THREAD_1 = ThreadId.make("thread-1");
const THREAD_2 = ThreadId.make("thread-2");

function generateTestApnsKeyPair() {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  };
}

function makeActivityState(
  overrides: Partial<RelayAgentActivityState> = {},
): RelayAgentActivityState {
  return {
    environmentId: ENV_ID,
    threadId: THREAD_1,
    projectTitle: "t3code",
    threadTitle: "Build Browne",
    phase: "running",
    headline: "Working",
    modelTitle: "GPT-5",
    updatedAt: NOW_ISO,
    deepLink: `/threads/${ENV_ID}/${THREAD_1}`,
    ...overrides,
  };
}

describe("directApnsClient", () => {
  it("signs valid ES256 APNs JWTs and reuses cached token within 45 minutes", () => {
    const { privateKeyPem, publicKey } = generateTestApnsKeyPair();
    const getJwt = createApnsJwtSigner({
      keyId: "Z5KG8Z5T78",
      teamId: "33QSRBWAD4",
      privateKeyPem,
    });

    const t0 = 1_760_000_000;
    const token1 = getJwt(t0);
    const token2 = getJwt(t0 + 44 * 60);
    const token3 = getJwt(t0 + 45 * 60);

    assert.equal(token1, token2);
    assert.notEqual(token1, token3);

    const parts = token1.split(".");
    assert.equal(parts.length, 3);
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as {
      readonly alg: string;
      readonly kid: string;
    };
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as {
      readonly iss: string;
      readonly iat: number;
    };
    assert.deepEqual(header, { alg: "ES256", kid: "Z5KG8Z5T78" });
    assert.deepEqual(payload, { iss: "33QSRBWAD4", iat: t0 });

    const verified = NodeCrypto.verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(encodedSignature, "base64url"),
    );
    assert.isTrue(verified);
  });

  it("fits Live Activity payloads within APNs 4 KB byte limit", () => {
    const longTitle = "Very long thread title that exceeds normal display length ".repeat(40);
    const state = makeAggregateState({
      activeStates: [
        makeActivityState({ threadId: ThreadId.make("t1"), threadTitle: longTitle }),
        makeActivityState({ threadId: ThreadId.make("t2"), threadTitle: longTitle }),
        makeActivityState({ threadId: ThreadId.make("t3"), threadTitle: longTitle }),
        makeActivityState({ threadId: ThreadId.make("t4"), threadTitle: longTitle }),
        makeActivityState({ threadId: ThreadId.make("t5"), threadTitle: longTitle }),
      ],
      terminalState: null,
      nowMs: NOW_MS,
      appTitle: "Browne",
    });
    assert.isNotNull(state);
    const request = makeLiveActivityRequest({
      token: "a".repeat(64),
      nowEpochSeconds: Math.floor(NOW_MS / 1_000),
      event: "update",
      state: state!,
      alert: { title: longTitle, body: longTitle },
    });
    const encodedSize = new TextEncoder().encode(JSON.stringify(request.payload)).byteLength;
    assert.isAtMost(encodedSize, MAX_LIVE_ACTIVITY_PAYLOAD_BYTES);
  });
});

describe("DirectApnsService", () => {
  it.effect("loads APNs config from env vars and key file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "direct-apns-cfg-" });
      const { privateKeyPem } = generateTestApnsKeyPair();
      const keyPath = path.join(dir, "AuthKey_TEST.p8");
      yield* fs.writeFileString(keyPath, privateKeyPem);

      const config = yield* loadDirectApnsConfig({
        T3CODE_DIRECT_APNS_KEY_PATH: keyPath,
        T3CODE_DIRECT_APNS_KEY_ID: "Z5KG8Z5T78",
        T3CODE_DIRECT_APNS_TEAM_ID: "33QSRBWAD4",
      });
      assert.isNotNull(config);
      assert.equal(config?.bundleId, "com.nicolasmertens.browne");
      assert.equal(config?.appTitle, "Browne");

      const unconfigured = yield* loadDirectApnsConfig({});
      assert.isNull(unconfigured);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "persists devices, replays active snapshot on Live Activity register, avoids double-buzz, ends Live Activity on completion, and prunes invalid tokens",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "direct-apns-svc-" });
        const { privateKeyPem } = generateTestApnsKeyPair();
        const deliveries: Array<DirectApnsHttp2TransportInput> = [];
        let nextResponse: DirectApnsDeliveryResult = {
          ok: true,
          status: 200,
          apnsId: "apns-1",
        };

        const config = {
          keyPath: "/tmp/test.p8",
          keyId: "Z5KG8Z5T78",
          teamId: "33QSRBWAD4",
          bundleId: "com.nicolasmertens.browne",
          appTitle: "Browne",
          privateKeyPem,
        };
        const client = createDirectApnsClient(config, {
          transport: {
            send: async (req) => {
              deliveries.push(req);
              return nextResponse;
            },
          },
        });

        const makeService = () =>
          DirectApnsService.make({ config, client }).pipe(
            Effect.provide(
              ServerConfig.layerTest(process.cwd(), baseDir).pipe(
                Layer.provideMerge(NodeServices.layer),
              ),
            ),
          );

        const service1 = yield* makeService();
        assert.isTrue(service1.isConfigured);

        yield* service1.registerDevice({
          deviceId: "iphone-1",
          label: "NiPhone17",
          platform: "ios",
          iosMajorVersion: 19,
          bundleId: "com.nicolasmertens.browne",
          apsEnvironment: "sandbox",
          pushToken: "push-tok-1",
          preferences: {
            liveActivitiesEnabled: true,
            notificationsEnabled: true,
            notifyOnApproval: true,
            notifyOnInput: true,
            notifyOnCompletion: true,
            notifyOnFailure: true,
          },
        });

        // Start a running thread and register a Live Activity token — triggers immediate replay update.
        yield* service1.publishThreadState({
          environmentId: ENV_ID,
          threadId: THREAD_1,
          state: makeActivityState({ threadId: THREAD_1, phase: "running" }),
        });
        yield* service1.registerLiveActivity({
          deviceId: "iphone-1",
          activityPushToken: "la-tok-1",
        });

        assert.equal(deliveries.length, 1);
        assert.equal(deliveries[0]?.environment, "sandbox");
        assert.equal(
          deliveries[0]?.headers["apns-topic"],
          "com.nicolasmertens.browne.push-type.liveactivity",
        );
        assert.equal(deliveries[0]?.path, "/3/device/la-tok-1");

        // Re-instantiate service to prove persisted devices survive restart.
        const service2 = yield* makeService();
        yield* service2.publishThreadState({
          environmentId: ENV_ID,
          threadId: THREAD_1,
          state: makeActivityState({ threadId: THREAD_1, phase: "running" }),
        });

        // Completing the only thread should send:
        // 1) One alert push notification (`apns-push-type: alert`), AND
        // 2) One silent Live Activity `end` update (`aps.alert` omitted because push already alerted!).
        deliveries.length = 0;
        yield* service2.publishThreadState({
          environmentId: ENV_ID,
          threadId: THREAD_1,
          state: makeActivityState({
            threadId: THREAD_1,
            phase: "completed",
            headline: "Done",
            updatedAt: NOW_ISO,
          }),
        });

        assert.equal(deliveries.length, 2);
        const pushReq = deliveries.find((d) => d.headers["apns-push-type"] === "alert");
        const laEndReq = deliveries.find((d) => d.headers["apns-push-type"] === "liveactivity");
        assert.isDefined(pushReq);
        assert.isDefined(laEndReq);
        assert.equal(pushReq?.path, "/3/device/push-tok-1");
        assert.equal(laEndReq?.path, "/3/device/la-tok-1");
        const laBody = JSON.parse(laEndReq!.body) as {
          readonly aps: {
            readonly event: string;
            readonly alert?: unknown;
            readonly "content-state"?: { readonly props: string };
          };
        };
        assert.equal(laBody.aps.event, "end");
        assert.isUndefined(laBody.aps.alert);
        const aggregate = JSON.parse(
          laBody.aps["content-state"]!.props,
        ) as RelayAgentActivityAggregateState;
        assert.equal(aggregate.title, "Browne");
        assert.equal(aggregate.activeCount, 0);

        // Next update sees no active Live Activity token left after `end`, and tests 410 push token pruning.
        deliveries.length = 0;
        yield* service2.publishThreadState({
          environmentId: ENV_ID,
          threadId: THREAD_2,
          state: makeActivityState({ threadId: THREAD_2, phase: "running" }),
        });
        assert.equal(deliveries.length, 0);

        nextResponse = { ok: false, status: 410, reason: "Unregistered", apnsId: null };
        yield* service2.publishThreadState({
          environmentId: ENV_ID,
          threadId: THREAD_2,
          state: makeActivityState({
            threadId: THREAD_2,
            phase: "waiting_for_approval",
            headline: "Approval",
          }),
        });
        assert.equal(deliveries.length, 1);

        // Subsequent alert should NOT send to the pruned push token.
        deliveries.length = 0;
        nextResponse = { ok: true, status: 200, apnsId: "apns-2" };
        yield* service2.publishThreadState({
          environmentId: ENV_ID,
          threadId: THREAD_2,
          state: makeActivityState({
            threadId: THREAD_2,
            phase: "completed",
            headline: "Done",
          }),
        });
        assert.equal(deliveries.length, 0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
