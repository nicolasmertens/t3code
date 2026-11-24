import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentScopeRequiredError,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import {
  RelayDeviceRegistrationRequest,
  RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { requestUrl } from "../requestUrl.ts";
import { DirectApnsService } from "./DirectApnsService.ts";

const DIRECT_PUSH_JSON_MAX_BODY_BYTES = 64 * 1024;
const DIRECT_PUSH_DEVICES_PREFIX = "/api/direct-push/devices";
const DIRECT_PUSH_LIVE_ACTIVITIES_PATH = "/api/direct-push/live-activities";
const DIRECT_PUSH_AGENT_ACTIVITY_PATH = "/api/direct-push/agent-activity";
const NO_STORE = { "cache-control": "no-store" } as const;

const decodeDeviceRegistration = Schema.decodeUnknownEffect(RelayDeviceRegistrationRequest);
const decodeLiveActivityRegistration = Schema.decodeUnknownEffect(
  RelayLiveActivityRegistrationRequest,
);

const authenticateDirectPushScope = Effect.fnUntraced(function* (scope: AuthEnvironmentScope) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
  return session;
});

function withAuthErrorResponses<R>(
  effect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    EnvironmentAuthInvalidError | EnvironmentInternalError | EnvironmentScopeRequiredError,
    R
  >,
) {
  return effect.pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  );
}

const readJsonBody = Effect.fn("directApnsHttp.readJsonBody")(function* <A, R>(
  decoder: (value: unknown) => Effect.Effect<A, Schema.SchemaError, R>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const raw = yield* request.json.pipe(
    Effect.provideService(
      HttpIncomingMessage.MaxBodySize,
      ByteSize.bytes(DIRECT_PUSH_JSON_MAX_BODY_BYTES),
    ),
    Effect.result,
  );
  if (Result.isFailure(raw)) {
    return null;
  }
  const decoded = yield* decoder(raw.success).pipe(Effect.result);
  if (Result.isFailure(decoded)) {
    return null;
  }
  return decoded.success;
});

function extractDeviceId(pathname: string): string | null {
  const prefixWithSlash = `${DIRECT_PUSH_DEVICES_PREFIX}/`;
  if (!pathname.startsWith(prefixWithSlash)) {
    return null;
  }
  try {
    const deviceId = decodeURIComponent(pathname.slice(prefixWithSlash.length)).trim();
    return deviceId.length > 0 && !deviceId.includes("/") ? deviceId : null;
  } catch {
    return null;
  }
}

const notConfiguredResponse = () =>
  HttpServerResponse.jsonUnsafe(
    { ok: false, configured: false },
    { status: 503, headers: NO_STORE },
  );

const badRequestResponse = () =>
  HttpServerResponse.jsonUnsafe(
    { ok: false, message: "Invalid direct push request payload." },
    { status: 400, headers: NO_STORE },
  );

const registerDeviceRoute = HttpRouter.add(
  "POST",
  DIRECT_PUSH_DEVICES_PREFIX,
  withAuthErrorResponses(
    Effect.gen(function* () {
      yield* authenticateDirectPushScope(AuthOrchestrationOperateScope);
      const body = yield* readJsonBody(decodeDeviceRegistration);
      if (body === null) {
        return badRequestResponse();
      }
      const directApns = yield* DirectApnsService;
      if (!directApns.isConfigured) {
        return notConfiguredResponse();
      }
      const response = yield* directApns.registerDevice(body);
      return HttpServerResponse.jsonUnsafe(response, { status: 200, headers: NO_STORE });
    }),
  ),
);

const unregisterDeviceRoute = HttpRouter.add(
  "DELETE",
  `${DIRECT_PUSH_DEVICES_PREFIX}/*`,
  withAuthErrorResponses(
    Effect.gen(function* () {
      yield* authenticateDirectPushScope(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = requestUrl(request);
      const deviceId = Option.isSome(url) ? extractDeviceId(url.value.pathname) : null;
      if (deviceId === null) {
        return badRequestResponse();
      }
      const directApns = yield* DirectApnsService;
      const response = yield* directApns.unregisterDevice(deviceId);
      return HttpServerResponse.jsonUnsafe(response, { status: 200, headers: NO_STORE });
    }),
  ),
);

const registerLiveActivityRoute = HttpRouter.add(
  "POST",
  DIRECT_PUSH_LIVE_ACTIVITIES_PATH,
  withAuthErrorResponses(
    Effect.gen(function* () {
      yield* authenticateDirectPushScope(AuthOrchestrationOperateScope);
      const body = yield* readJsonBody(decodeLiveActivityRegistration);
      if (body === null) {
        return badRequestResponse();
      }
      const directApns = yield* DirectApnsService;
      if (!directApns.isConfigured) {
        return notConfiguredResponse();
      }
      const response = yield* directApns.registerLiveActivity(body);
      return HttpServerResponse.jsonUnsafe(response, { status: 200, headers: NO_STORE });
    }),
  ),
);

const getAgentActivitySnapshotRoute = HttpRouter.add(
  "GET",
  DIRECT_PUSH_AGENT_ACTIVITY_PATH,
  withAuthErrorResponses(
    Effect.gen(function* () {
      yield* authenticateDirectPushScope(AuthOrchestrationReadScope);
      const directApns = yield* DirectApnsService;
      if (!directApns.isConfigured) {
        return notConfiguredResponse();
      }
      const response = yield* directApns.getSnapshot();
      return HttpServerResponse.jsonUnsafe(response, { status: 200, headers: NO_STORE });
    }),
  ),
);

export const layer = Layer.mergeAll(
  registerDeviceRoute,
  unregisterDeviceRoute,
  registerLiveActivityRoute,
  getAgentActivitySnapshotRoute,
);
