import { AuthOrchestrationOperateScope, TALK_TO_FLEET_STREAM_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { TalkToFleetService } from "./TalkToFleetService.ts";

export const talkToFleetRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const talkToFleet = yield* TalkToFleetService;

    return HttpRouter.add(
      "GET",
      TALK_TO_FLEET_STREAM_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth
          .authenticateWebSocketUpgrade(request, "media")
          .pipe(Effect.result);
        if (session._tag === "Failure") return HttpServerResponse.empty({ status: 401 });
        if (!session.success.scopes.includes(AuthOrchestrationOperateScope)) {
          return HttpServerResponse.empty({ status: 403 });
        }

        const parsedUrl = new URL(request.originalUrl, "http://localhost");
        const queryThreadId = parsedUrl.searchParams.get("threadId")?.trim() || undefined;
        const socket = yield* request.upgrade;
        yield* talkToFleet.runSocket(socket, queryThreadId).pipe(Effect.scoped);
        return HttpServerResponse.empty();
      }),
    );
  }),
);
