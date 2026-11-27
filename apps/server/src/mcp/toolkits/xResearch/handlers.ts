import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as XResearchService from "../../../xResearch/XResearchService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { XResearchToolkit } from "./tools.ts";

const mapXResearchError = <A, R>(
  effect: Effect.Effect<A, XResearchService.XResearchError, R>,
): Effect.Effect<A, OrchestratorMcpFailure, R> =>
  effect.pipe(
    Effect.catchTags({
      XResearchInvalidInputError: (error) =>
        Effect.fail(
          new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
        ),
      XResearchUnavailableError: (error) =>
        Effect.fail(
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
    }),
  );

const handlers = {
  x_research: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* XResearchService.XResearchService;
      return yield* service.research(input).pipe(mapXResearchError);
    }),
  ),
  x_read_post: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* XResearchService.XResearchService;
      return yield* service.readPost(input).pipe(mapXResearchError);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof XResearchToolkit.tools>;

export const layer = McpToolAccess.toLayer(XResearchToolkit, handlers);
