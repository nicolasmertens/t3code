import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import {
  XResearchInvalidInputError,
  XResearchService,
  XResearchUnavailableError,
} from "../../../xResearch/XResearchService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as XResearchHandlers from "./handlers.ts";
import { XResearchToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment-x-research-test");
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "x-research-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "x-research-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const readOnlyClientScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "client:readonly",
  thread: undefined,
  client: {
    sessionId: "session-readonly",
    label: "Read-only client",
    access: "read-only",
  },
  capabilities: new Set(),
  issuedAt: 1,
};

const planThreadScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider:plan-thread",
  thread: {
    threadId: ThreadId.make("thread-plan"),
    providerSessionId: "provider:plan-thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 1,
};

const mockService = Layer.mock(XResearchService)({
  research: ({ query, depth, verifyCitations }) =>
    query === "fail"
      ? Effect.fail(new XResearchUnavailableError({ message: "Grok CLI unavailable." }))
      : Effect.succeed({
          answer: `Synthesis for ${query}`,
          model: depth === "deep" ? "grok-4.7" : "grok-4.7-build-fast",
          depth: depth ?? "quick",
          toolsUsed: ["x_keyword_search"],
          verifiedPosts:
            verifyCitations === false
              ? []
              : [
                  {
                    url: "https://x.com/expo/status/101",
                    id: "101",
                    citedHandle: "expo",
                    verified: true,
                    actualHandle: "expo",
                    authorMatches: true,
                    createdAtEt: "Jul 18, 2026, 8:13 AM ET",
                    textSnippet: "Expo widgets",
                  },
                ],
        }),
  readPost: ({ url, includeThread }) =>
    url === "bad-url"
      ? Effect.fail(new XResearchInvalidInputError({ message: "Invalid X URL." }))
      : Effect.succeed({
          id: "20",
          url: "https://x.com/jack/status/20",
          source: includeThread ? "syndication+grok" : "syndication",
          post: {
            id: "20",
            url: "https://x.com/jack/status/20",
            handle: "jack",
            authorName: "jack",
            createdAtEt: "Mar 21, 2006, 3:50 PM ET",
            text: "just setting up my twttr",
            mediaUrls: [],
          },
          ...(includeThread ? { threadSummary: "Replies summary" } : {}),
        }),
});

const layerTest = McpHttpServer.toolkitRegistration(XResearchToolkit, XResearchHandlers.layer).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provide(mockService),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-x-research-test-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("registers x_research and x_read_post and allows read-only and plan callers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
        "x_read_post",
        "x_research",
      ]);

      const readResult = yield* server
        .callTool({ name: "x_read_post", arguments: { url: "https://x.com/jack/status/20" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, readOnlyClientScope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(readResult.isError).toBe(false);
      expect(readResult.structuredContent).toMatchObject({
        id: "20",
        source: "syndication",
        post: { handle: "jack" },
      });

      const researchResult = yield* server
        .callTool({
          name: "x_research",
          arguments: { query: "Expo widgets", depth: "deep" },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, planThreadScope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(researchResult.isError).toBe(false);
      expect(researchResult.structuredContent).toMatchObject({
        answer: "Synthesis for Expo widgets",
        model: "grok-4.7",
        depth: "deep",
        toolsUsed: ["x_keyword_search"],
      });
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("maps invalid URL and Grok unavailability into structured OrchestratorMcpFailure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;

      const invalidUrlResult = yield* server
        .callTool({ name: "x_read_post", arguments: { url: "bad-url" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, planThreadScope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(invalidUrlResult.isError).toBe(true);
      const invalidPayload = JSON.parse(
        (invalidUrlResult.content[0] as { readonly text: string }).text,
      ) as { code: string; message: string };
      expect(invalidPayload).toEqual({
        _tag: "OrchestratorMcpFailure",
        code: "invalid_request",
        message: "Invalid X URL.",
      });

      const unavailableResult = yield* server
        .callTool({ name: "x_research", arguments: { query: "fail" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, planThreadScope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(unavailableResult.isError).toBe(true);
      const unavailablePayload = JSON.parse(
        (unavailableResult.content[0] as { readonly text: string }).text,
      ) as { code: string; message: string };
      expect(unavailablePayload).toEqual({
        _tag: "OrchestratorMcpFailure",
        code: "orchestration_error",
        message: "Grok CLI unavailable.",
      });
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("wires real XResearchService.layer in McpHttpServer.layerXResearchToolkit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
        "x_read_post",
        "x_research",
      ]);
    }),
  ).pipe(
    Effect.provide(
      McpHttpServer.layerXResearchToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-x-research-wire-" })),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
