import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as DiscussEmailsService from "./DiscussEmailsService.ts";
import * as FleetPanelService from "./FleetPanelService.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "fleetPanel",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* FleetPanelService.FleetPanelService;
    const discussEmails = yield* DiscussEmailsService.DiscussEmailsService;

    return handlers
      .handle(
        "context",
        Effect.fn("environment.fleetPanel.context")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.getContext(args.payload).pipe(
            traceLocalHandlerWork,
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "action",
        Effect.fn("environment.fleetPanel.action")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.runAction(args.payload).pipe(
            traceLocalHandlerWork,
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "prepareDiscussEmails",
        Effect.fn("environment.fleetPanel.prepareDiscussEmails")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* discussEmails
            .prepareDiscussEmails(args.payload)
            .pipe(traceLocalHandlerWork);
        }),
      );
  }),
);
