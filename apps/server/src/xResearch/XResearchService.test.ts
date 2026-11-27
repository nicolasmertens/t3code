import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  extractCitedXPosts,
  formatEtTimestamp,
  make as makeXResearchService,
  parseGrokStreamingJson,
  parseXPostTarget,
  XResearchService,
} from "./XResearchService.ts";

it("parses X/Twitter post URLs, variants, and bare numeric IDs", () => {
  expect(parseXPostTarget("20")).toEqual({
    id: "20",
    canonicalUrl: "https://x.com/i/web/status/20",
  });
  expect(parseXPostTarget("https://x.com/expo/status/2082084407972708384?s=20")).toEqual({
    id: "2082084407972708384",
    handle: "expo",
    canonicalUrl: "https://x.com/expo/status/2082084407972708384",
  });
  expect(parseXPostTarget("https://twitter.com/jack/status/20/photo/1")).toEqual({
    id: "20",
    handle: "jack",
    canonicalUrl: "https://x.com/jack/status/20",
  });
  expect(parseXPostTarget("x.com/i/web/status/123456")).toEqual({
    id: "123456",
    canonicalUrl: "https://x.com/i/web/status/123456",
  });
  expect(parseXPostTarget("https://vxtwitter.com/xai/status/999")).toEqual({
    id: "999",
    handle: "xai",
    canonicalUrl: "https://x.com/xai/status/999",
  });
  expect(parseXPostTarget("https://x.com/expo")).toBeNull();
  expect(parseXPostTarget("https://github.com/expo/expo/issues/1")).toBeNull();
  expect(parseXPostTarget("   ")).toBeNull();
});

it("formats timestamps in America/New_York (ET)", () => {
  const formatted = formatEtTimestamp("2006-03-21T20:50:14.000Z");
  expect(formatted).toBeDefined();
  expect(formatted).toMatch(/Mar 21, 2006.*3:50 PM ET/);
});

it("extracts unique cited X post URLs and ignores /i/web links", () => {
  const citations = extractCitedXPosts(
    [
      "See https://x.com/expo/status/111?s=20 and https://twitter.com/expo/status/111",
      "Also https://x.com/i/status/222 and https://x.com/JacobHammerle/status/333.",
    ].join("\n"),
  );
  expect(citations).toEqual([
    { url: "https://x.com/expo/status/111", id: "111", citedHandle: "expo" },
    { url: "https://x.com/JacobHammerle/status/333", id: "333", citedHandle: "JacobHammerle" },
  ]);
});

it("parses Grok streaming-json events into answer, toolsUsed, and stopReason", () => {
  const parsed = parseGrokStreamingJson(
    [
      JSON.stringify({ type: "thought", data: "Searching X" }),
      JSON.stringify({ type: "text", data: "Findings: " }),
      JSON.stringify({
        type: "tool_call_update",
        toolName: "X search:",
        rawOutput: { name: "x_keyword_search" },
      }),
      JSON.stringify({
        type: "tool_call_update",
        toolName: "X search:",
        rawOutput: { name: "x_thread_fetch" },
      }),
      JSON.stringify({ type: "text", data: "done." }),
      JSON.stringify({ type: "end", stopReason: "end_turn" }),
    ].join("\n"),
  );
  expect(parsed).toEqual({
    answer: "Findings: done.",
    toolsUsed: ["x_keyword_search", "x_thread_fetch"],
    stopReason: "end_turn",
  });
});

it.effect("reads a public X post via free syndication without invoking Grok", () => {
  let grokCalls = 0;
  const mockProcessRunner = Layer.mock(ProcessRunner.ProcessRunner)({
    run: () => {
      grokCalls += 1;
      return Effect.die("Grok should not run when syndication succeeds");
    },
  });
  const mockFetch: typeof fetch = async (input) => {
    expect(String(input)).toContain("cdn.syndication.twimg.com/tweet-result?id=20&token=a");
    return new Response(
      JSON.stringify({
        id_str: "20",
        text: "just setting up my twttr",
        created_at: "2006-03-21T20:50:14.000Z",
        favorite_count: 324577,
        conversation_count: 12000,
        user: { screen_name: "jack", name: "jack" },
        mediaDetails: [{ media_url_https: "https://pbs.twimg.com/media/test.jpg" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const layer = Layer.effect(
    XResearchService,
    makeXResearchService({ fetch: mockFetch, homeDir: "/nonexistent", env: {} }),
  ).pipe(Layer.provide(mockProcessRunner), Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    const service = yield* XResearchService;
    const result = yield* service.readPost({ url: "https://x.com/jack/status/20" });
    expect(result.source).toBe("syndication");
    expect(result.id).toBe("20");
    expect(result.url).toBe("https://x.com/jack/status/20");
    expect(result.post?.handle).toBe("jack");
    expect(result.post?.text).toBe("just setting up my twttr");
    expect(result.post?.createdAtEt).toMatch(/ET$/);
    expect(result.post?.mediaUrls).toEqual(["https://pbs.twimg.com/media/test.jpg"]);
    expect(grokCalls).toBe(0);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "runs Grok X search with configured binary, no bwrap sandbox, and verifies cited URLs",
  () => {
    let capturedInput: ProcessRunner.ProcessRunInput | undefined;
    const mockProcessRunner = Layer.mock(ProcessRunner.ProcessRunner)({
      run: (input) => {
        capturedInput = input;
        return Effect.succeed({
          stdout: [
            JSON.stringify({
              type: "tool_call_update",
              rawOutput: { name: "x_keyword_search" },
            }),
            JSON.stringify({
              type: "text",
              data: [
                "1. https://x.com/expo/status/101 - verified post",
                "2. https://x.com/fakeuser/status/102 - wrong handle",
                "3. https://x.com/ghost/status/404 - missing post",
              ].join("\n"),
            }),
            JSON.stringify({ type: "end", stopReason: "end_turn" }),
          ].join("\n"),
          stderr: "",
          code: 0 as never,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        });
      },
    });

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("id=101")) {
        return new Response(
          JSON.stringify({
            id_str: "101",
            text: "Expo SDK 56 widgets are live!",
            created_at: "2026-07-18T12:13:00.000Z",
            user: { screen_name: "expo", name: "Expo" },
          }),
          { status: 200 },
        );
      }
      if (url.includes("id=102")) {
        return new Response(
          JSON.stringify({
            id_str: "102",
            text: "Real post by someone else",
            created_at: "2026-07-19T12:00:00.000Z",
            user: { screen_name: "realauthor", name: "Real" },
          }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const settingsLayer = ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make("grok")]: {
          driver: ProviderDriverKind.make("grok"),
          enabled: true,
          config: { binaryPath: "/custom/bin/grok" },
        },
      },
    });

    const layer = Layer.effect(
      XResearchService,
      makeXResearchService({ fetch: mockFetch, homeDir: "/nonexistent", env: {} }),
    ).pipe(
      Layer.provide(mockProcessRunner),
      Layer.provide(settingsLayer),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const service = yield* XResearchService;
      const result = yield* service.research({ query: "Expo widgets" });

      expect(capturedInput?.command).toBe("/custom/bin/grok");
      expect(capturedInput?.args).toContain("grok-4.7-build-fast");
      expect(capturedInput?.args).not.toContain("--sandbox");
      expect(capturedInput?.args).toContain("--disallowed-tools");
      expect(capturedInput?.env?.GROK_OAUTH2_REFERRER).toBe("t3code");

      expect(result.model).toBe("grok-4.7-build-fast");
      expect(result.depth).toBe("quick");
      expect(result.toolsUsed).toEqual(["x_keyword_search"]);
      expect(result.verifiedPosts).toEqual([
        {
          url: "https://x.com/expo/status/101",
          id: "101",
          citedHandle: "expo",
          verified: true,
          actualHandle: "expo",
          authorMatches: true,
          createdAtEt: formatEtTimestamp("2026-07-18T12:13:00.000Z"),
          textSnippet: "Expo SDK 56 widgets are live!",
        },
        {
          url: "https://x.com/fakeuser/status/102",
          id: "102",
          citedHandle: "fakeuser",
          verified: true,
          actualHandle: "realauthor",
          authorMatches: false,
          createdAtEt: formatEtTimestamp("2026-07-19T12:00:00.000Z"),
          textSnippet: "Real post by someone else",
        },
        {
          url: "https://x.com/ghost/status/404",
          id: "404",
          citedHandle: "ghost",
          verified: false,
        },
      ]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("surfaces clear guidance when Grok CLI is unauthenticated", () => {
  const mockProcessRunner = Layer.mock(ProcessRunner.ProcessRunner)({
    run: () =>
      Effect.succeed({
        stdout: "",
        stderr: "Error: not authenticated. Please run `grok login`.",
        code: 1 as never,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });
  const layer = Layer.effect(
    XResearchService,
    makeXResearchService({ homeDir: "/nonexistent", env: {} }),
  ).pipe(Layer.provide(mockProcessRunner), Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    const service = yield* XResearchService;
    const error = yield* Effect.flip(service.research({ query: "test", depth: "deep" }));
    expect(error._tag).toBe("XResearchUnavailableError");
    expect(error.message).toContain("grok login");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "falls back to Grok when syndication fails and enriches with thread when requested",
  () => {
    const mockProcessRunner = Layer.mock(ProcessRunner.ProcessRunner)({
      run: (input) => {
        expect(input.args).toContain("grok-4.7-build-fast");
        return Effect.succeed({
          stdout: [
            JSON.stringify({ type: "tool_call_update", rawOutput: { name: "x_thread_fetch" } }),
            JSON.stringify({ type: "text", data: "Thread summary with replies." }),
            JSON.stringify({ type: "end", stopReason: "end_turn" }),
          ].join("\n"),
          stderr: "",
          code: 0 as never,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        });
      },
    });
    let mode: "fail" | "succeed" = "fail";
    const mockFetch: typeof fetch = async () => {
      if (mode === "fail") {
        return new Response("Not found", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          id_str: "555",
          text: "Parent post text",
          created_at: "2026-10-01T15:00:00.000Z",
          user: { screen_name: "builder", name: "Builder" },
        }),
        { status: 200 },
      );
    };
    const layer = Layer.effect(
      XResearchService,
      makeXResearchService({ fetch: mockFetch, homeDir: "/nonexistent", env: {} }),
    ).pipe(Layer.provide(mockProcessRunner), Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const service = yield* XResearchService;
      const fallbackResult = yield* service.readPost({ url: "https://x.com/builder/status/555" });
      expect(fallbackResult.source).toBe("grok");
      expect(fallbackResult.threadSummary).toBe("Thread summary with replies.");
      expect(fallbackResult.toolsUsed).toEqual(["x_thread_fetch"]);

      mode = "succeed";
      const enrichedResult = yield* service.readPost({
        url: "https://x.com/builder/status/555",
        includeThread: true,
      });
      expect(enrichedResult.source).toBe("syndication+grok");
      expect(enrichedResult.post?.text).toBe("Parent post text");
      expect(enrichedResult.threadSummary).toBe("Thread summary with replies.");
    }).pipe(Effect.provide(layer));
  },
);
