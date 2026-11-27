import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as XResearchService from "../../../xResearch/XResearchService.ts";

const QuotedPostSchema = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  text: Schema.String,
  url: Schema.String,
});

const SyndicationPostSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  handle: Schema.String,
  authorName: Schema.String,
  createdAtEt: Schema.optionalKey(Schema.String),
  text: Schema.String,
  favoriteCount: Schema.optionalKey(Schema.Number),
  conversationCount: Schema.optionalKey(Schema.Number),
  quotedPost: Schema.optionalKey(QuotedPostSchema),
  mediaUrls: Schema.Array(Schema.String),
});

const VerifiedCitationSchema = Schema.Struct({
  url: Schema.String,
  id: Schema.String,
  citedHandle: Schema.String,
  verified: Schema.Boolean,
  actualHandle: Schema.optionalKey(Schema.String),
  authorMatches: Schema.optionalKey(Schema.Boolean),
  createdAtEt: Schema.optionalKey(Schema.String),
  textSnippet: Schema.optionalKey(Schema.String),
});

const XResearchTool = Tool.make("x_research", {
  description:
    "Search and synthesize public X (Twitter) posts via the local Grok subscription ($0 X API). Prefer over web fetch for X topics, sentiment, or discussions.",
  parameters: Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)).annotate({
      description: "Topic, question, or X search query.",
    }),
    depth: Schema.optional(
      Schema.Literals(["quick", "deep"]).annotate({
        description: "quick (default, Grok 4.7 Fast) or deep (Grok 4.7).",
      }),
    ),
    verifyCitations: Schema.optional(
      Schema.Boolean.annotate({
        description: "Verify cited X post URLs via free syndication. Default true.",
      }),
    ),
  }),
  success: Schema.Struct({
    answer: Schema.String,
    model: Schema.String,
    depth: Schema.Literals(["quick", "deep"]),
    toolsUsed: Schema.Array(Schema.String),
    verifiedPosts: Schema.Array(VerifiedCitationSchema),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [XResearchService.XResearchService],
})
  .annotate(Tool.Title, "Research on X")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const XReadPostTool = Tool.make("x_read_post", {
  description:
    "Read a public X (Twitter) post by URL or ID via free syndication ($0 X API), with optional Grok thread replies. Prefer over web fetch for x.com links.",
  parameters: Schema.Struct({
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).annotate({
      description: "X/Twitter post URL or numeric status ID.",
    }),
    includeThread: Schema.optional(
      Schema.Boolean.annotate({
        description: "Also fetch thread context and replies via Grok. Default false.",
      }),
    ),
  }),
  success: Schema.Struct({
    id: Schema.String,
    url: Schema.String,
    source: Schema.Literals(["syndication", "grok", "syndication+grok"]),
    post: Schema.optionalKey(SyndicationPostSchema),
    threadSummary: Schema.optionalKey(Schema.String),
    toolsUsed: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [XResearchService.XResearchService],
})
  .annotate(Tool.Title, "Read X post")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const XResearchToolkit = Toolkit.make(XResearchTool, XReadPostTool);
