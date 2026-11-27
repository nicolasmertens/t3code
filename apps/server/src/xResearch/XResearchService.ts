import * as NodeOS from "node:os";

import type { ServerSettings as ContractsServerSettings } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

export type XResearchDepth = "quick" | "deep";

export interface XPostTarget {
  readonly id: string;
  readonly handle?: string;
  readonly canonicalUrl: string;
}

export interface XSyndicationPost {
  readonly id: string;
  readonly url: string;
  readonly handle: string;
  readonly authorName: string;
  readonly createdAtEt?: string;
  readonly text: string;
  readonly favoriteCount?: number;
  readonly conversationCount?: number;
  readonly quotedPost?: {
    readonly id: string;
    readonly handle: string;
    readonly text: string;
    readonly url: string;
  };
  readonly mediaUrls: ReadonlyArray<string>;
}

export interface XVerifiedCitation {
  readonly url: string;
  readonly id: string;
  readonly citedHandle: string;
  readonly verified: boolean;
  readonly actualHandle?: string;
  readonly authorMatches?: boolean;
  readonly createdAtEt?: string;
  readonly textSnippet?: string;
}

export interface XResearchResult {
  readonly answer: string;
  readonly model: string;
  readonly depth: XResearchDepth;
  readonly toolsUsed: ReadonlyArray<string>;
  readonly verifiedPosts: ReadonlyArray<XVerifiedCitation>;
}

export interface XReadPostResult {
  readonly id: string;
  readonly url: string;
  readonly source: "syndication" | "grok" | "syndication+grok";
  readonly post?: XSyndicationPost;
  readonly threadSummary?: string;
  readonly toolsUsed?: ReadonlyArray<string>;
}

export class XResearchInvalidInputError extends Schema.TaggedError<XResearchInvalidInputError>()(
  "XResearchInvalidInputError",
  {
    message: Schema.String,
  },
) {}

export class XResearchUnavailableError extends Schema.TaggedError<XResearchUnavailableError>()(
  "XResearchUnavailableError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type XResearchError = XResearchInvalidInputError | XResearchUnavailableError;

export class XResearchService extends Context.Service<
  XResearchService,
  {
    readonly research: (input: {
      readonly query: string;
      readonly depth?: XResearchDepth | undefined;
      readonly verifyCitations?: boolean | undefined;
    }) => Effect.Effect<XResearchResult, XResearchError>;

    readonly readPost: (input: {
      readonly url: string;
      readonly includeThread?: boolean | undefined;
    }) => Effect.Effect<XReadPostResult, XResearchError>;
  }
>()("t3/xResearch/XResearchService") {}

const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const T3_CODE_OAUTH_REFERRER = "t3code";
const GROK_QUICK_MODEL = "grok-4.7-build-fast";
const GROK_DEEP_MODEL = "grok-4.7";
const GROK_QUICK_TIMEOUT_MS = 90_000;
const GROK_DEEP_TIMEOUT_MS = 150_000;
const SYNDICATION_TIMEOUT_MS = 8_000;
const CITATION_VERIFY_TIMEOUT_MS = 4_000;
const MAX_VERIFIED_CITATIONS = 8;
const MAX_TEXT_SNIPPET_CHARS = 240;

const GROK_DISALLOWED_TOOLS = [
  "run_terminal_command",
  "read_file",
  "search_replace",
  "list_dir",
  "grep",
  "kill_command_or_subagent",
  "todo_write",
  "get_command_or_subagent_output",
  "scheduler_create",
  "scheduler_delete",
  "scheduler_list",
  "monitor",
  "search_tool",
  "use_tool",
  "workflow",
  "enter_plan_mode",
  "exit_plan_mode",
  "ask_user_question",
  "send_feedback",
  "image_gen",
  "image_edit",
  "image_to_video",
  "reference_to_video",
  "write",
].join(",");

const GROK_X_RESEARCH_SYSTEM_PROMPT = [
  "You are a concise, read-only X (Twitter) research assistant inside Browne.",
  "Use your native X search tools (x_keyword_search, x_semantic_search, x_user_search, x_thread_fetch).",
  "Do NOT use general web search unless the question explicitly needs non-X web context.",
  "Format every cited post with @handle, America/New_York date/time, exact https://x.com/<handle>/status/<id> URL, and a concise takeaway.",
  "Never fabricate status URLs, handles, or quotes. Only cite posts actually returned by your X tools.",
].join(" ");

const ET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const ALLOWED_X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "fxtwitter.com",
  "www.fxtwitter.com",
  "vxtwitter.com",
  "www.vxtwitter.com",
  "fixupx.com",
  "www.fixupx.com",
]);

const BARE_ID_PATTERN = /^\d{1,25}$/;
const SCHEMELESS_X_URL_PATTERN =
  /^(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx)\.com\//i;
const WEB_STATUS_PATH_PATTERN = /^\/i\/(?:web\/)?status\/(\d{1,25})(?:\/.*)?$/i;
const HANDLE_STATUS_PATH_PATTERN = /^\/([A-Za-z0-9_]{1,30})\/status(?:es)?\/(\d{1,25})(?:\/.*)?$/i;
const CITATION_URL_PATTERN =
  /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,30})\/status\/(\d{1,25})/gi;

export function formatEtTimestamp(rawDate: string | number | Date): string | undefined {
  const epochMs =
    typeof rawDate === "number"
      ? rawDate
      : rawDate instanceof Date
        ? rawDate.getTime()
        : Date.parse(rawDate);
  if (!Number.isFinite(epochMs)) {
    return undefined;
  }
  return `${ET_FORMATTER.format(epochMs)} ET`;
}

export function parseXPostTarget(rawUrl: string): XPostTarget | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  if (BARE_ID_PATTERN.test(trimmed)) {
    return {
      id: trimmed,
      canonicalUrl: `https://x.com/i/web/status/${trimmed}`,
    };
  }
  const normalized = SCHEMELESS_X_URL_PATTERN.test(trimmed) ? `https://${trimmed}` : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (!ALLOWED_X_HOSTS.has(parsed.hostname.toLowerCase())) {
    return null;
  }
  const webStatusMatch = WEB_STATUS_PATH_PATTERN.exec(parsed.pathname);
  if (webStatusMatch?.[1]) {
    const id = webStatusMatch[1];
    return {
      id,
      canonicalUrl: `https://x.com/i/web/status/${id}`,
    };
  }
  const handleStatusMatch = HANDLE_STATUS_PATH_PATTERN.exec(parsed.pathname);
  if (handleStatusMatch?.[1] && handleStatusMatch[2]) {
    const handle = handleStatusMatch[1];
    const id = handleStatusMatch[2];
    if (handle.toLowerCase() === "i") {
      return {
        id,
        canonicalUrl: `https://x.com/i/web/status/${id}`,
      };
    }
    return {
      id,
      handle,
      canonicalUrl: `https://x.com/${handle}/status/${id}`,
    };
  }
  return null;
}

export function extractCitedXPosts(
  text: string,
  limit = MAX_VERIFIED_CITATIONS,
): ReadonlyArray<{ readonly url: string; readonly id: string; readonly citedHandle: string }> {
  const results: Array<{
    readonly url: string;
    readonly id: string;
    readonly citedHandle: string;
  }> = [];
  const seenIds = new Set<string>();
  CITATION_URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_URL_PATTERN.exec(text)) !== null) {
    const citedHandle = match[1];
    const id = match[2];
    if (!citedHandle || !id || citedHandle.toLowerCase() === "i" || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    results.push({
      url: `https://x.com/${citedHandle}/status/${id}`,
      id,
      citedHandle,
    });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

export function parseGrokStreamingJson(stdout: string): {
  readonly answer: string;
  readonly toolsUsed: ReadonlyArray<string>;
  readonly stopReason?: string | undefined;
  readonly errorMessage?: string | undefined;
} {
  const textParts: Array<string> = [];
  const toolsUsed = new Set<string>();
  let stopReason: string | undefined;
  let errorMessage: string | undefined;

  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Predicate.isReadonlyObject(event)) continue;
    const type = event.type;
    if (type === "text" && typeof event.data === "string") {
      textParts.push(event.data);
    } else if (type === "tool_call_update") {
      const rawOutput = Predicate.isReadonlyObject(event.rawOutput) ? event.rawOutput : undefined;
      const toolName =
        typeof rawOutput?.name === "string" && rawOutput.name.trim().length > 0
          ? rawOutput.name.trim()
          : typeof event.toolName === "string" && event.toolName.trim().length > 0
            ? event.toolName.trim().replace(/:$/u, "")
            : undefined;
      if (toolName !== undefined) {
        toolsUsed.add(toolName);
      }
    } else if (type === "end" && typeof event.stopReason === "string") {
      stopReason = event.stopReason;
    } else if (type === "error" && typeof event.message === "string") {
      errorMessage = event.message;
    }
  }

  return {
    answer: textParts.join("").trim(),
    toolsUsed: [...toolsUsed],
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function parseSyndicationPayload(payload: unknown, fallbackId: string): XSyndicationPost | null {
  if (!Predicate.isReadonlyObject(payload)) {
    return null;
  }
  if (payload.__typename === "TweetTombstone") {
    return null;
  }
  const user = Predicate.isReadonlyObject(payload.user) ? payload.user : undefined;
  const screenName = typeof user?.screen_name === "string" ? user.screen_name.trim() : "";
  const authorName = typeof user?.name === "string" ? user.name.trim() : screenName;
  const id =
    typeof payload.id_str === "string" && payload.id_str.trim().length > 0
      ? payload.id_str.trim()
      : fallbackId;
  const noteTweet = Predicate.isReadonlyObject(payload.note_tweet) ? payload.note_tweet : undefined;
  const noteText = typeof noteTweet?.text === "string" ? noteTweet.text.trim() : "";
  const bodyText = typeof payload.text === "string" ? payload.text.trim() : "";
  const text = noteText || bodyText;
  if (!screenName || !text) {
    return null;
  }
  const createdAtEt =
    typeof payload.created_at === "string" ? formatEtTimestamp(payload.created_at) : undefined;
  const favoriteCount =
    typeof payload.favorite_count === "number" && Number.isFinite(payload.favorite_count)
      ? payload.favorite_count
      : undefined;
  const conversationCount =
    typeof payload.conversation_count === "number" && Number.isFinite(payload.conversation_count)
      ? payload.conversation_count
      : undefined;

  let quotedPost: XSyndicationPost["quotedPost"];
  if (Predicate.isReadonlyObject(payload.quoted_tweet)) {
    const quoted = parseSyndicationPayload(payload.quoted_tweet, id);
    if (quoted) {
      quotedPost = {
        id: quoted.id,
        handle: quoted.handle,
        text: quoted.text,
        url: quoted.url,
      };
    }
  }

  const mediaUrls: Array<string> = [];
  if (Array.isArray(payload.mediaDetails)) {
    for (const entry of payload.mediaDetails) {
      if (
        Predicate.isReadonlyObject(entry) &&
        typeof entry.media_url_https === "string" &&
        entry.media_url_https.length > 0
      ) {
        mediaUrls.push(entry.media_url_https);
      }
    }
  }

  return {
    id,
    url: `https://x.com/${screenName}/status/${id}`,
    handle: screenName,
    authorName: authorName || screenName,
    ...(createdAtEt === undefined ? {} : { createdAtEt }),
    text,
    ...(favoriteCount === undefined ? {} : { favoriteCount }),
    ...(conversationCount === undefined ? {} : { conversationCount }),
    ...(quotedPost === undefined ? {} : { quotedPost }),
    mediaUrls,
  };
}

function collapseSnippet(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= MAX_TEXT_SNIPPET_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_TEXT_SNIPPET_CHARS - 3).trimEnd()}...`;
}

function findConfiguredGrokBinary(settings: ContractsServerSettings): string | undefined {
  const entries = Object.entries(settings.providerInstances);
  // Prefer the canonical "grok" instance when multiple Grok instances exist.
  const ordered = [
    ...entries.filter(([id]) => id === "grok"),
    ...entries.filter(([id]) => id !== "grok"),
  ];
  for (const [, instance] of ordered) {
    if (instance.driver !== "grok" || instance.enabled === false) continue;
    if (!Predicate.isReadonlyObject(instance.config)) continue;
    if (instance.config.enabled === false) continue;
    if (typeof instance.config.binaryPath === "string") {
      const candidate = instance.config.binaryPath.trim();
      if (candidate.length > 0) {
        return candidate;
      }
    }
  }
  return undefined;
}

export interface XResearchServiceOptions {
  readonly fetch?: typeof fetch | undefined;
  readonly homeDir?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly cwd?: string | undefined;
}

export const make = Effect.fn("XResearchService.make")(function* (
  options: XResearchServiceOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverSettingsOption = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseEnv = options.env ?? process.env;
  const homeDir = options.homeDir ?? NodeOS.homedir();
  const spawnCwd = options.cwd ?? NodeOS.tmpdir();

  const resolveGrokBinary = Effect.fn("XResearchService.resolveGrokBinary")(function* () {
    if (Option.isSome(serverSettingsOption)) {
      const settings = yield* serverSettingsOption.value.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (settings !== undefined) {
        const configured = findConfiguredGrokBinary(settings);
        if (configured !== undefined) {
          return configured;
        }
      }
    }
    const envBin = baseEnv.BROWNE_GROK_BIN?.trim();
    if (envBin) {
      return envBin;
    }
    for (const candidateName of ["grok", "grok.exe"] as const) {
      const candidate = path.join(homeDir, ".grok", "bin", candidateName);
      const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        return candidate;
      }
    }
    return "grok";
  });

  const fetchSyndicationPost = Effect.fn("XResearchService.fetchSyndicationPost")(function* (
    id: string,
    timeoutMs: number,
  ) {
    const endpoint = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&token=a`;
    const payload = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetchImpl(endpoint, {
          headers: {
            Accept: "application/json",
            "User-Agent": "Browne/1.0",
          },
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
        if (!response.ok) {
          throw new Error(`Syndication HTTP ${response.status}`);
        }
        return (await response.json()) as unknown;
      },
      catch: (cause) =>
        new XResearchUnavailableError({
          message: `Failed to fetch X post ${id} via syndication.`,
          cause,
        }),
    });
    const post = parseSyndicationPayload(payload, id);
    if (post === null) {
      return yield* new XResearchUnavailableError({
        message: `X post ${id} was not found or is not publicly available via syndication.`,
      });
    }
    return post;
  });

  const runGrokXSearch = Effect.fn("XResearchService.runGrokXSearch")(function* (input: {
    readonly prompt: string;
    readonly depth: XResearchDepth;
  }) {
    const binary = yield* resolveGrokBinary();
    const model = input.depth === "deep" ? GROK_DEEP_MODEL : GROK_QUICK_MODEL;
    const reasoningEffort = input.depth === "deep" ? "medium" : "low";
    const maxTurns = input.depth === "deep" ? "6" : "4";
    const timeoutMs = input.depth === "deep" ? GROK_DEEP_TIMEOUT_MS : GROK_QUICK_TIMEOUT_MS;

    const runResult = yield* processRunner
      .run({
        command: binary,
        args: [
          "-p",
          input.prompt,
          "-m",
          model,
          "--reasoning-effort",
          reasoningEffort,
          "--system-prompt-override",
          GROK_X_RESEARCH_SYSTEM_PROMPT,
          "--disallowed-tools",
          GROK_DISALLOWED_TOOLS,
          "--permission-mode",
          "dontAsk",
          "--output-format",
          "streaming-json",
          "--max-turns",
          maxTurns,
          "--no-memory",
          "--no-subagents",
          "--no-plan",
          "--cwd",
          spawnCwd,
        ],
        spawnCwd,
        timeout: timeoutMs,
        env: {
          ...baseEnv,
          [GROK_OAUTH2_REFERRER_ENV]: T3_CODE_OAUTH_REFERRER,
        },
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError((cause) => {
          if (cause._tag === "ProcessSpawnError") {
            return new XResearchUnavailableError({
              message: `Could not launch Grok CLI (${binary}). Ensure Grok Build is installed and logged in via grok.com.`,
              cause,
            });
          }
          if (cause._tag === "ProcessTimeoutError") {
            return new XResearchUnavailableError({
              message: `Grok X search timed out after ${Math.round(timeoutMs / 1000)}s.`,
              cause,
            });
          }
          return new XResearchUnavailableError({
            message: cause.message,
            cause,
          });
        }),
      );

    const parsed = parseGrokStreamingJson(runResult.stdout);
    const combinedOutput = `${parsed.errorMessage ?? ""}\n${runResult.stderr}\n${runResult.stdout}`;
    if (
      /not authenticated|please run [`'"]?grok login|login required/i.test(combinedOutput) &&
      !parsed.answer
    ) {
      return yield* new XResearchUnavailableError({
        message:
          "Grok CLI is not signed in. Run `grok login` with your grok.com subscription to enable X research.",
      });
    }
    if (runResult.code !== 0 && !parsed.answer) {
      const detail =
        parsed.errorMessage || runResult.stderr.trim() || `exit code ${runResult.code}`;
      return yield* new XResearchUnavailableError({
        message: `Grok X search failed: ${detail}`,
      });
    }
    if (!parsed.answer) {
      return yield* new XResearchUnavailableError({
        message: parsed.errorMessage || "Grok X search returned an empty response.",
      });
    }

    return {
      answer: parsed.answer,
      model,
      toolsUsed: parsed.toolsUsed,
    };
  });

  const verifyCitation = Effect.fn("XResearchService.verifyCitation")(function* (citation: {
    readonly url: string;
    readonly id: string;
    readonly citedHandle: string;
  }): Effect.fn.Return<XVerifiedCitation> {
    const exit = yield* Effect.exit(fetchSyndicationPost(citation.id, CITATION_VERIFY_TIMEOUT_MS));
    if (Exit.isFailure(exit)) {
      return {
        url: citation.url,
        id: citation.id,
        citedHandle: citation.citedHandle,
        verified: false,
      };
    }
    const post = exit.value;
    return {
      url: citation.url,
      id: citation.id,
      citedHandle: citation.citedHandle,
      verified: true,
      actualHandle: post.handle,
      authorMatches: post.handle.toLowerCase() === citation.citedHandle.toLowerCase(),
      ...(post.createdAtEt === undefined ? {} : { createdAtEt: post.createdAtEt }),
      textSnippet: collapseSnippet(post.text),
    };
  });

  const research: XResearchService["Service"]["research"] = Effect.fn("XResearchService.research")(
    function* (input) {
      const query = input.query.trim();
      if (!query) {
        return yield* new XResearchInvalidInputError({
          message: "Provide a non-empty query for X research.",
        });
      }
      const depth: XResearchDepth = input.depth === "deep" ? "deep" : "quick";
      const verifyCitations = input.verifyCitations ?? true;
      const searchLimit = depth === "deep" ? "up to 5 focused searches" : "2-3 focused searches";

      const prompt = [
        `Research this question on X using your native X search tools (${searchLimit}):`,
        query,
        "Return a concise synthesis with concrete takeaways and cite relevant public posts (@handle, America/New_York date/time, exact https://x.com/<handle>/status/<id> URL).",
      ].join("\n\n");

      const grok = yield* runGrokXSearch({ prompt, depth });
      const citations = verifyCitations ? extractCitedXPosts(grok.answer) : [];
      const verifiedPosts =
        citations.length === 0
          ? []
          : yield* Effect.forEach(citations, verifyCitation, { concurrency: 4 });

      return {
        answer: grok.answer,
        model: grok.model,
        depth,
        toolsUsed: grok.toolsUsed,
        verifiedPosts,
      } satisfies XResearchResult;
    },
  );

  const readPost: XResearchService["Service"]["readPost"] = Effect.fn("XResearchService.readPost")(
    function* (input) {
      const target = parseXPostTarget(input.url);
      if (target === null) {
        return yield* new XResearchInvalidInputError({
          message: `Could not parse an X/Twitter post URL or numeric status ID from "${input.url.trim()}".`,
        });
      }
      const includeThread = input.includeThread === true;
      const syndicationExit = yield* Effect.exit(
        fetchSyndicationPost(target.id, SYNDICATION_TIMEOUT_MS),
      );
      const post = Exit.isSuccess(syndicationExit) ? syndicationExit.value : undefined;

      if (post !== undefined && !includeThread) {
        return {
          id: post.id,
          url: post.url,
          source: "syndication",
          post,
        } satisfies XReadPostResult;
      }

      const canonicalUrl = post?.url ?? target.canonicalUrl;
      const grokPrompt = includeThread
        ? `Fetch X post ${canonicalUrl} (ID ${target.id}) and its thread/notable replies using x_thread_fetch and X search. Summarize the post, any parent context, and key replies with @handles, America/New_York dates, and exact x.com status URLs.`
        : `Fetch X post ${canonicalUrl} (ID ${target.id}) using x_thread_fetch or X search. Return the author @handle, America/New_York date/time, exact post text, and URL.`;

      const grokExit = yield* Effect.exit(runGrokXSearch({ prompt: grokPrompt, depth: "quick" }));

      if (Exit.isSuccess(grokExit)) {
        const grok = grokExit.value;
        return {
          id: post?.id ?? target.id,
          url: post?.url ?? target.canonicalUrl,
          source: post ? "syndication+grok" : "grok",
          ...(post === undefined ? {} : { post }),
          threadSummary: grok.answer,
          toolsUsed: grok.toolsUsed,
        } satisfies XReadPostResult;
      }

      if (post !== undefined) {
        const squashed = Cause.squash(grokExit.cause);
        const detail = squashed instanceof Error ? squashed.message : String(squashed);
        return {
          id: post.id,
          url: post.url,
          source: "syndication",
          post,
          threadSummary: `Thread replies unavailable: ${detail}`,
        } satisfies XReadPostResult;
      }

      return yield* Effect.failCause(grokExit.cause);
    },
  );

  return XResearchService.of({
    research,
    readPost,
  });
});

export const layer = Layer.effect(XResearchService, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
