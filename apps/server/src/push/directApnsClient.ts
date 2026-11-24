// @effect-diagnostics nodeBuiltinImport:off -- Uses Node built-in HTTP/2 and crypto for Direct-APNs JWT signing and delivery.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  MAX_SUMMARY_TEXT_LENGTH,
  truncateText,
  type DirectApnsLiveActivityAlert,
  type DirectApnsNotificationPayload,
} from "./directApnsAggregate.ts";

const LIVE_ACTIVITY_NAME = "AgentActivity";
const STALE_AFTER_SECONDS = 10 * 60;
const DISMISS_AFTER_SECONDS = 5 * 60;
const CONTENTLESS_DISMISS_AFTER_SECONDS = 15;
export const MAX_LIVE_ACTIVITY_PAYLOAD_BYTES = 4096;
const MIN_FITTED_TEXT_LENGTH = 8;
const APNS_JWT_REFRESH_WINDOW_SECONDS = 45 * 60;
const APNS_REQUEST_TIMEOUT_MS = 10_000;

export type DirectApnsEnvironment = "sandbox" | "production";
type DirectApnsLiveActivityEvent = "update" | "end";

interface DirectApnsLiveActivityRequest {
  readonly token: string;
  readonly event: DirectApnsLiveActivityEvent;
  readonly priority: "5" | "10";
  readonly payload: unknown;
}

interface DirectApnsPushNotificationRequest {
  readonly token: string;
  readonly priority: "10";
  readonly payload: unknown;
}

export interface DirectApnsDeliveryResult {
  readonly ok: boolean;
  readonly status: number;
  readonly reason?: string;
  readonly apnsId: string | null;
}

export interface DirectApnsHttp2TransportInput {
  readonly environment: DirectApnsEnvironment;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface DirectApnsClient {
  readonly getJwt: (nowSeconds: number) => string;
  readonly sendLiveActivity: (input: {
    readonly environment: DirectApnsEnvironment;
    readonly bundleId: string;
    readonly request: DirectApnsLiveActivityRequest;
    readonly nowSeconds?: number;
  }) => Effect.Effect<DirectApnsDeliveryResult>;
  readonly sendPushNotification: (input: {
    readonly environment: DirectApnsEnvironment;
    readonly bundleId: string;
    readonly request: DirectApnsPushNotificationRequest;
    readonly nowSeconds?: number;
  }) => Effect.Effect<DirectApnsDeliveryResult>;
  readonly close: () => void;
}

const decodeApnsErrorResponseJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      reason: Schema.optional(Schema.String),
    }),
  ),
);

function apnsReasonFromBody(body: string): string | undefined {
  if (body.trim().length === 0) {
    return undefined;
  }
  return Option.match(decodeApnsErrorResponseJson(body), {
    onNone: () => body,
    onSome: (parsed) => parsed.reason ?? body,
  });
}

function contentState(state: RelayAgentActivityAggregateState) {
  return {
    name: LIVE_ACTIVITY_NAME,
    props: JSON.stringify(state),
  };
}

function liveActivityAlertPayload(alert: DirectApnsLiveActivityAlert) {
  return {
    alert: {
      title: alert.title,
      body: alert.body,
      sound: "default",
    },
  };
}

type MakeLiveActivityRequestInput =
  | {
      readonly token: string;
      readonly nowEpochSeconds: number;
      readonly event: "end";
      readonly state: RelayAgentActivityAggregateState | null;
      readonly alert?: DirectApnsLiveActivityAlert | null;
    }
  | {
      readonly token: string;
      readonly nowEpochSeconds: number;
      readonly event: "update";
      readonly state: RelayAgentActivityAggregateState;
      readonly alert?: DirectApnsLiveActivityAlert | null;
    };

function buildLiveActivityRequest(
  input: MakeLiveActivityRequestInput,
): DirectApnsLiveActivityRequest {
  const timestamp = input.nowEpochSeconds;
  if (input.event === "end") {
    return {
      token: input.token,
      event: input.event,
      priority: "10",
      payload: {
        aps: {
          timestamp,
          event: "end",
          ...(input.state ? { "content-state": contentState(input.state) } : {}),
          ...(input.alert ? liveActivityAlertPayload(input.alert) : {}),
          "dismissal-date":
            timestamp + (input.state ? DISMISS_AFTER_SECONDS : CONTENTLESS_DISMISS_AFTER_SECONDS),
        },
      },
    };
  }

  return {
    token: input.token,
    event: input.event,
    priority: !input.alert ? "5" : "10",
    payload: {
      aps: {
        timestamp,
        event: input.event,
        ...(input.alert ? liveActivityAlertPayload(input.alert) : {}),
        "content-state": contentState(input.state),
        "stale-date": timestamp + STALE_AFTER_SECONDS,
      },
    },
  };
}

function fitsLiveActivityLimit(request: DirectApnsLiveActivityRequest): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(request.payload)).byteLength <=
    MAX_LIVE_ACTIVITY_PAYLOAD_BYTES
  );
}

export function makeLiveActivityRequest(
  input: MakeLiveActivityRequestInput,
): DirectApnsLiveActivityRequest {
  let request = buildLiveActivityRequest(input);
  const state = input.state;
  if (state === null) {
    return request;
  }
  const fit = (maxTextLength: number, rowCount: number) =>
    buildLiveActivityRequest({
      ...input,
      state: {
        ...state,
        activities: state.activities.slice(0, rowCount).map((row) => ({
          ...row,
          projectTitle: truncateText(row.projectTitle, maxTextLength),
          threadTitle: truncateText(row.threadTitle, maxTextLength),
          modelTitle: truncateText(row.modelTitle, maxTextLength),
        })),
      },
      alert: input.alert
        ? {
            title: truncateText(input.alert.title, maxTextLength),
            body: truncateText(input.alert.body, maxTextLength),
          }
        : null,
    });
  let rowCount = state.activities.length;
  let maxTextLength = MAX_SUMMARY_TEXT_LENGTH;
  while (
    !fitsLiveActivityLimit(request) &&
    (rowCount > 0 || maxTextLength > MIN_FITTED_TEXT_LENGTH)
  ) {
    if (maxTextLength > MIN_FITTED_TEXT_LENGTH) {
      maxTextLength = Math.floor(maxTextLength * 0.8);
    } else {
      rowCount -= 1;
      maxTextLength = MAX_SUMMARY_TEXT_LENGTH;
    }
    request = fit(maxTextLength, rowCount);
  }
  return request;
}

export function makePushNotificationRequest(input: {
  readonly token: string;
  readonly notification: DirectApnsNotificationPayload;
}): DirectApnsPushNotificationRequest {
  const threadIdHeader =
    input.notification.threadId.length > 0
      ? `${input.notification.environmentId}/${input.notification.threadId}`
      : "t3-agent-alerts";
  return {
    token: input.token,
    priority: "10",
    payload: {
      aps: {
        alert: {
          title: input.notification.title,
          body: input.notification.body,
        },
        sound: "default",
        "thread-id": threadIdHeader,
      },
      // Expo iOS exposes userInfo.body as notification.content.data for remote pushes.
      body: {
        environmentId: input.notification.environmentId,
        threadId: input.notification.threadId,
        deepLink: input.notification.deepLink,
      },
    },
  };
}

export function isPermanentInvalidToken(result: DirectApnsDeliveryResult): boolean {
  return (
    result.status === 410 ||
    (result.status === 400 &&
      (result.reason === "BadDeviceToken" || result.reason === "DeviceTokenNotForTopic"))
  );
}

export function createApnsJwtSigner(input: {
  readonly keyId: string;
  readonly teamId: string;
  readonly privateKeyPem: string;
}): (nowSeconds: number) => string {
  const privateKey = NodeCrypto.createPrivateKey(input.privateKeyPem);
  let cached: { readonly jwt: string; readonly issuedAtSeconds: number } | null = null;

  return (nowSeconds: number) => {
    if (
      cached !== null &&
      nowSeconds >= cached.issuedAtSeconds &&
      nowSeconds - cached.issuedAtSeconds < APNS_JWT_REFRESH_WINDOW_SECONDS
    ) {
      return cached.jwt;
    }
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: input.keyId })).toString(
      "base64url",
    );
    const payload = Buffer.from(JSON.stringify({ iss: input.teamId, iat: nowSeconds })).toString(
      "base64url",
    );
    const signingInput = `${header}.${payload}`;
    const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const jwt = `${signingInput}.${signature}`;
    cached = { jwt, issuedAtSeconds: nowSeconds };
    return jwt;
  };
}

function apnsOrigin(environment: DirectApnsEnvironment): string {
  return environment === "production"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
}

function createNodeHttp2Transport() {
  const sessions = new Map<DirectApnsEnvironment, NodeHttp2.ClientHttp2Session>();

  const getSession = (environment: DirectApnsEnvironment): NodeHttp2.ClientHttp2Session => {
    const existing = sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) {
      return existing;
    }
    const created = NodeHttp2.connect(apnsOrigin(environment));
    const drop = () => {
      if (sessions.get(environment) === created) {
        sessions.delete(environment);
      }
    };
    created.once("close", drop);
    created.once("error", () => {
      drop();
      created.destroy();
    });
    sessions.set(environment, created);
    return created;
  };

  const send = (input: DirectApnsHttp2TransportInput): Promise<DirectApnsDeliveryResult> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (result: DirectApnsDeliveryResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const session = getSession(input.environment);
      let req: NodeHttp2.ClientHttp2Stream;
      try {
        req = session.request({
          [NodeHttp2.constants.HTTP2_HEADER_METHOD]: "POST",
          [NodeHttp2.constants.HTTP2_HEADER_PATH]: input.path,
          "content-type": "application/json",
          ...input.headers,
        });
      } catch (error) {
        finish({
          ok: false,
          status: 0,
          reason: error instanceof Error ? error.message : String(error),
          apnsId: null,
        });
        return;
      }

      let status = 0;
      let apnsId: string | null = null;
      const chunks: Array<Buffer> = [];

      req.setTimeout(APNS_REQUEST_TIMEOUT_MS, () => {
        req.close(NodeHttp2.constants.NGHTTP2_CANCEL);
        finish({ ok: false, status: 0, reason: "timeout", apnsId });
      });

      req.on("response", (headers) => {
        const rawStatus = headers[NodeHttp2.constants.HTTP2_HEADER_STATUS];
        status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus ?? 0);
        const rawApnsId = headers["apns-id"];
        apnsId = typeof rawApnsId === "string" ? rawApnsId : null;
      });

      req.on("data", (chunk: Buffer | string) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });

      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const reason = apnsReasonFromBody(body);
        finish({
          ok: status >= 200 && status < 300,
          status,
          ...(reason === undefined ? {} : { reason }),
          apnsId,
        });
      });

      req.on("error", (error) => {
        sessions.delete(input.environment);
        finish({
          ok: false,
          status,
          reason: error instanceof Error ? error.message : String(error),
          apnsId,
        });
      });

      req.end(input.body);
    });

  const close = () => {
    for (const session of sessions.values()) {
      if (!session.destroyed) {
        session.close();
      }
    }
    sessions.clear();
  };

  return { send, close };
}

function serializeJsonBody(payload: unknown): string {
  return JSON.stringify(payload);
}

export function createDirectApnsClient(
  config: {
    readonly keyId: string;
    readonly teamId: string;
    readonly privateKeyPem: string;
  },
  options?: {
    readonly transport?: {
      readonly send: (input: DirectApnsHttp2TransportInput) => Promise<DirectApnsDeliveryResult>;
      readonly close?: () => void;
    };
  },
): DirectApnsClient {
  const getJwt = createApnsJwtSigner(config);
  const ownedTransport = options?.transport ? null : createNodeHttp2Transport();
  const transport = options?.transport ?? ownedTransport!;

  const sendLiveActivity: DirectApnsClient["sendLiveActivity"] = Effect.fn(
    "directApnsClient.sendLiveActivity",
  )(function* (input) {
    const nowSeconds = input.nowSeconds ?? Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    const jwt = getJwt(nowSeconds);
    const body = serializeJsonBody(input.request.payload);
    const result = yield* Effect.promise(() =>
      transport.send({
        environment: input.environment,
        path: `/3/device/${input.request.token}`,
        headers: {
          authorization: `bearer ${jwt}`,
          "apns-priority": input.request.priority,
          "apns-push-type": "liveactivity",
          "apns-topic": `${input.bundleId}.push-type.liveactivity`,
        },
        body,
      }),
    );
    return result;
  });

  const sendPushNotification: DirectApnsClient["sendPushNotification"] = Effect.fn(
    "directApnsClient.sendPushNotification",
  )(function* (input) {
    const nowSeconds = input.nowSeconds ?? Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    const jwt = getJwt(nowSeconds);
    const body = serializeJsonBody(input.request.payload);
    const result = yield* Effect.promise(() =>
      transport.send({
        environment: input.environment,
        path: `/3/device/${input.request.token}`,
        headers: {
          authorization: `bearer ${jwt}`,
          "apns-priority": input.request.priority,
          "apns-push-type": "alert",
          "apns-topic": input.bundleId,
        },
        body,
      }),
    );
    return result;
  });

  return {
    getJwt,
    sendLiveActivity,
    sendPushNotification,
    close: () => {
      transport.close?.();
    },
  };
}
