// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - Invokes SSH fleet tools and wall-clock timestamps.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  RuntimeRequestId,
  type TalkToFleetCard,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type { VoiceToolDefinition } from "./RealtimeVoiceProvider.ts";
import {
  formatNyDate,
  formatNyTime,
  type LiveBrowneSnapshot,
  type LiveBrowneThreadDigest,
  type VoiceContextCache,
} from "./VoiceContextCache.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const SSH_TOOL_TIMEOUT_MS = 6_000;
const DEFAULT_WIKI_DIR = NodePath.join(NodeOS.homedir(), "wiki");
const FLEET_VOICE_DIR_MAC = "/Users/nico/system-architecture/services/fleet-voice";

const CURRENT_THREAD_ALIASES = new Set([
  "this",
  "current",
  "main",
  "this thread",
  "current thread",
  "main session",
  "main thread",
  "deze",
  "deze thread",
  "deze sessie",
  "huidige",
  "huidige sessie",
  "huidige thread",
]);

export interface VoiceExecResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VoiceToolsDeps {
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly threadManagement: ThreadManagement.ThreadManagementService["Service"];
  readonly threadLaunch: ThreadLaunch.ThreadLaunchService["Service"];
  readonly projectStore: ProjectStore.ProjectStoreV2["Service"];
  readonly managedFolders: ManagedProjectFolders.ManagedProjectFolders["Service"];
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly providerRegistry: ProviderRegistry.ProviderRegistry["Service"];
  readonly contextCache: VoiceContextCache["Service"];
  readonly execCommand?: (
    command: string,
    args: ReadonlyArray<string>,
    timeoutMs?: number,
  ) => Promise<VoiceExecResult>;
  readonly wikiDir?: string;
}

export interface VoiceToolExecutionResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly sourceAge?: string;
}

export interface ExecuteVoiceToolInput {
  readonly deps: VoiceToolsDeps;
  readonly callId: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly scopedThreadId?: string | undefined;
  readonly emitCard: (card: TalkToFleetCard) => void;
  readonly trackThread: (threadId: string, title?: string) => void;
}

export const VOICE_TOOL_DEFINITIONS: ReadonlyArray<VoiceToolDefinition> = [
  {
    name: "browne_threads",
    description:
      "Inspect, steer/message, or start Browne coding/agent threads. When a main session is open beside this voice chat, omitting 'thread_id' and 'title' for 'read' or 'send' automatically targets that main session.",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: ["list", "read", "send", "create"],
          description: "Operation on Browne threads.",
        },
        thread_id: {
          type: "string",
          description:
            "Target Browne thread ID for read or send (optional when scoped to main session or if title is given).",
        },
        project_name: {
          type: "string",
          description: "Project title or keyword when creating a thread.",
        },
        title: {
          type: "string",
          description: "Thread title when creating, or title search hint for read/send.",
        },
        prompt: {
          type: "string",
          description: "Message text to send or initial task prompt when creating.",
        },
        limit: {
          type: "integer",
          description: "Max threads to return for 'list' (default 10).",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "browne_approvals",
    description:
      "List pending runtime approval or permission requests in Browne, or respond ('accept' or 'decline') when Nick explicitly instructs an approval decision.",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: ["list", "respond"],
          description: "List pending approvals or respond to one.",
        },
        thread_id: {
          type: "string",
          description:
            "Thread ID with the pending request (optional when responding to the scoped main session).",
        },
        request_id: {
          type: "string",
          description:
            "Specific runtime request ID (optional if the thread has one pending request).",
        },
        decision: {
          type: "string",
          enum: ["accept", "decline"],
          description: "Approval decision when action is 'respond'.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "fleet_search",
    description:
      "Live search across Fleet sources when the preloaded briefing is insufficient: 'all', 'wiki', 'mail', 'plan', 'messages' (WhatsApp & iMessage), 'calendar', 'meetings' (Mac meeting transcripts & screen), 'calls', 'contacts', 'notes', or 'screen'.",
    parameters: {
      properties: {
        source: {
          type: "string",
          enum: [
            "all",
            "wiki",
            "mail",
            "plan",
            "messages",
            "calendar",
            "meetings",
            "calls",
            "contacts",
            "notes",
            "screen",
          ],
          description: "Knowledge or live personal source to query.",
        },
        query: {
          type: "string",
          description: "Search keywords or phrase.",
        },
        since: {
          type: "string",
          description:
            "Optional time window filter (e.g. 'today', 'gisteren', 'last 2 weeks', '2026-11-20').",
        },
        limit: {
          type: "integer",
          description: "Maximum matches to return (default 5).",
        },
      },
      required: ["source", "query"],
    },
  },
  {
    name: "fleet_plan",
    description:
      "Read a fresh planner snapshot from journal/plan.db or add a new task or waiting item when Nick asks.",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: ["read", "add"],
          description: "Read current plan state or add an item.",
        },
        title: {
          type: "string",
          description: "Title for the new task or waiting item when action is 'add'.",
        },
        kind: {
          type: "string",
          enum: ["task", "waiting"],
          description: "Item kind when adding ('task' or 'waiting').",
        },
        owner: {
          type: "string",
          description: "Optional owner/counterparty for a waiting item.",
        },
        deadline: {
          type: "string",
          description: "Optional deadline string (e.g. 2026-12-01).",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "fleet_delegate",
    description:
      "Delegate deep research, analysis, code edits, or multi-step work to a new Browne agent thread and report back once started.",
    parameters: {
      properties: {
        task: {
          type: "string",
          description: "Clear self-contained prompt/instructions for the Browne agent thread.",
        },
        project_name: {
          type: "string",
          description: "Optional project name or folder keyword.",
        },
        title: {
          type: "string",
          description: "Concise short human title for the delegated thread.",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "fleet_capture",
    description:
      "Capture a quick note/fact for the wiki librarian on maxbook, or a waiting/task item in journal/plan.db.",
    parameters: {
      properties: {
        text: {
          type: "string",
          description: "The note, fact, or follow-up item text to save.",
        },
        kind: {
          type: "string",
          enum: ["note", "waiting", "task"],
          description:
            "Storage target: 'note' (wiki librarian) or 'waiting'/'task' (journal planner).",
        },
        owner: {
          type: "string",
          description: "Optional owner when kind is 'waiting'.",
        },
        deadline: {
          type: "string",
          description: "Optional deadline when kind is 'waiting' or 'task'.",
        },
      },
      required: ["text"],
    },
  },
];

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

async function defaultExecCommand(
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs = SSH_TOOL_TIMEOUT_MS,
): Promise<VoiceExecResult> {
  try {
    const result = await execFileAsync(command, [...args], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    return { ok: true, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    const err = error as {
      readonly stdout?: unknown;
      readonly stderr?: unknown;
      readonly message?: unknown;
    };
    return {
      ok: false,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr:
        typeof err.stderr === "string" && err.stderr.trim().length > 0
          ? err.stderr.trim()
          : typeof err.message === "string"
            ? err.message
            : "command failed",
    };
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function summarizeToolTitle(name: string, args: Readonly<Record<string, unknown>>): string {
  switch (name) {
    case "browne_threads": {
      const action = asNonEmptyString(args.action) ?? "list";
      if (action === "create") {
        return `New thread: ${asNonEmptyString(args.title) ?? asNonEmptyString(args.project_name) ?? "task"}`;
      }
      if (action === "send") {
        return `Message thread ${asNonEmptyString(args.title) ?? asNonEmptyString(args.thread_id) ?? "main session"}`.trim();
      }
      if (action === "read") {
        return `Read thread ${asNonEmptyString(args.title) ?? asNonEmptyString(args.thread_id) ?? "main session"}`.trim();
      }
      return "Check Browne threads";
    }
    case "browne_approvals":
      return args.action === "respond" ? "Respond to approval" : "Check pending approvals";
    case "fleet_search": {
      const source = asNonEmptyString(args.source) ?? "fleet";
      const query = asNonEmptyString(args.query) ?? "";
      return `Search ${source}: ${query.slice(0, 40)}`;
    }
    case "fleet_plan":
      return args.action === "add"
        ? `Add to plan: ${(asNonEmptyString(args.title) ?? "").slice(0, 36)}`
        : "Read journal plan";
    case "fleet_delegate":
      return `Delegate: ${(asNonEmptyString(args.title) ?? asNonEmptyString(args.task) ?? "task").slice(0, 40)}`;
    case "fleet_capture":
      return `Save ${asNonEmptyString(args.kind) ?? "note"}`;
    default:
      return name;
  }
}

function isoFromDateTime(dt: DateTime.Utc): string {
  return new Date(DateTime.toEpochMillis(dt)).toISOString();
}

function summarizeProjectionActivity(
  projection: OrchestrationV2ThreadProjection,
  limit = 10,
): string[] {
  const summaries: string[] = [];
  const rawItems = projection.visibleTurnItems ?? projection.turnItems ?? [];
  for (const entry of rawItems) {
    const item = "item" in entry ? entry.item : entry;
    if (!item || typeof item !== "object" || !("type" in item)) continue;
    switch (item.type) {
      case "command_execution": {
        const exit = typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : "";
        summaries.push(`cmd${exit}: ${item.input.replace(/\s+/gu, " ").trim().slice(0, 140)}`);
        break;
      }
      case "file_change":
        summaries.push(`edit: ${item.fileName}`);
        break;
      case "dynamic_tool":
        summaries.push(`tool: ${item.toolName ?? "custom"}`);
        break;
      case "subagent": {
        const prompt = item.prompt.replace(/\s+/gu, " ").trim().slice(0, 100);
        summaries.push(`subagent: ${prompt}`);
        break;
      }
      case "proposed_plan":
        summaries.push(`plan: ${item.markdown.replace(/\s+/gu, " ").trim().slice(0, 120)}`);
        break;
      case "error":
        summaries.push(`error: ${item.failure.message.slice(0, 120)}`);
        break;
      case "approval_request":
        summaries.push(
          `approval (${item.requestKind}): ${(item.prompt ?? item.reason ?? "").slice(0, 100)}`,
        );
        break;
      case "user_input_request":
        summaries.push(`question: ${item.questions[0]?.question.slice(0, 100) ?? "pending"}`);
        break;
      default:
        break;
    }
  }
  return summaries.slice(-limit);
}

export function extractBoostedKeywordsFromSnapshot(live: LiveBrowneSnapshot): string[] {
  const keywords: string[] = [];
  const seen = new Set<string>();
  const addTerm = (raw: string) => {
    const trimmed = raw.trim().replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/gu, "");
    if (trimmed.length < 3 || trimmed.length > 32) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    keywords.push(trimmed);
  };
  const addPhraseAndWords = (text: string) => {
    addTerm(text);
    for (const token of text.split(/[\s/:.,()[\]]+/u)) {
      addTerm(token);
    }
  };

  for (const project of live.projects) {
    addPhraseAndWords(project);
  }
  if (live.scopedThread) {
    addPhraseAndWords(live.scopedThread.title);
  }
  for (const thread of live.activeThreads.slice(0, 6)) {
    addPhraseAndWords(thread.title);
  }
  return keywords.slice(0, 25);
}

export const readLiveBrowneSnapshot = Effect.fn("voice.readLiveBrowneSnapshot")(function* (
  deps: Pick<VoiceToolsDeps, "orchestrator" | "projectStore">,
  scopedThreadId?: string,
) {
  const [snapshot, projects] = yield* Effect.all([
    deps.orchestrator.getShellSnapshot().pipe(
      Effect.orElseSucceed(() => ({
        schemaVersion: 1,
        snapshotSequence: 0,
        threads: [],
        archivedThreads: [],
      })),
    ),
    deps.projectStore.listShells().pipe(Effect.orElseSucceed(() => [])),
  ]);

  const projectById = new Map(projects.map((p) => [p.id, p.title]));
  const sortedThreads = [...snapshot.threads].sort(
    (left, right) =>
      DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
  );

  const toDigest = (thread: (typeof sortedThreads)[number]): LiveBrowneThreadDigest => ({
    id: thread.id,
    title: thread.title,
    projectTitle: projectById.get(thread.projectId) ?? "No project",
    status: thread.status,
    attention:
      thread.pendingRuntimeRequest === null
        ? null
        : thread.pendingRuntimeRequest.kind === "user_input"
          ? "input"
          : "approval",
    updatedAt: isoFromDateTime(thread.updatedAt),
  });

  const attentionThreads = sortedThreads
    .filter((thread) => thread.pendingRuntimeRequest !== null)
    .slice(0, 10)
    .map(toDigest);

  const activeThreads = sortedThreads.slice(0, 10).map(toDigest);

  let scopedThread: LiveBrowneSnapshot["scopedThread"] | undefined;
  const trimmedScopedId = scopedThreadId?.trim();
  if (trimmedScopedId) {
    const shell = snapshot.threads.find((t) => t.id === trimmedScopedId);
    const projection = yield* deps.orchestrator
      .getThreadProjection(ThreadId.make(trimmedScopedId))
      .pipe(Effect.orElseSucceed(() => null));
    if (projection !== null) {
      scopedThread = {
        id: projection.thread.id,
        title: projection.thread.title,
        projectTitle: projectById.get(projection.thread.projectId) ?? "No project",
        status: shell?.status ?? "idle",
        branch: projection.thread.branch,
        worktreePath: projection.thread.worktreePath,
        pendingRequests: projection.runtimeRequests
          .filter((req) => req.status === "pending")
          .map((req) => ({ id: req.id, kind: req.kind })),
        recentActivity: summarizeProjectionActivity(projection, 10),
        recentMessages: projection.messages
          .filter((msg) => msg.text.trim().length > 0)
          .slice(-16)
          .map((msg) => ({ role: msg.role, text: msg.text })),
      };
    }
  }

  return {
    projects: projects.map((p) => p.title),
    attentionThreads,
    activeThreads,
    ...(scopedThread ? { scopedThread } : {}),
  } satisfies LiveBrowneSnapshot;
});

async function searchLocalWiki(
  wikiDir: string,
  query: string,
  limit: number,
): Promise<VoiceToolExecutionResult> {
  const fetchedAt = formatNyTime();
  const terms = query
    .toLowerCase()
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  if (terms.length === 0) {
    return { ok: false, error: "Provide a search query for wiki." };
  }

  const hits: Array<{
    readonly path: string;
    readonly title: string;
    readonly score: number;
    readonly excerpt: string;
  }> = [];

  const walk = async (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const fullPath = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const content = await NodeFSP.readFile(fullPath, "utf8").catch(() => "");
        if (!content) continue;
        const lowerRel = NodePath.relative(wikiDir, fullPath).toLowerCase();
        const lowerBody = content.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (lowerRel.includes(term)) score += 3;
          if (lowerBody.includes(term)) score += 1;
        }
        if (score === 0) continue;
        const lines = content.split("\n");
        const heading =
          lines.find((line) => line.startsWith("# "))?.replace(/^#\s+/u, "") ?? entry.name;
        const matchedLineIndex = lines.findIndex((line) =>
          terms.some((term) => line.toLowerCase().includes(term)),
        );
        const start = Math.max(0, matchedLineIndex - 1);
        const excerpt = lines
          .slice(start, start + 5)
          .join("\n")
          .trim()
          .slice(0, 480);
        hits.push({
          path: NodePath.relative(wikiDir, fullPath),
          title: heading,
          score,
          excerpt,
        });
      }
    }
  };

  await walk(wikiDir, 0);
  hits.sort((left, right) => right.score - left.score);
  return {
    ok: true,
    sourceAge: fetchedAt,
    data: {
      query,
      matches: hits.slice(0, limit).map(({ path, title, excerpt }) => ({ path, title, excerpt })),
    },
  };
}

interface PostroomJson {
  readonly shown?: ReadonlyArray<{
    readonly id?: string;
    readonly subject?: string;
    readonly receivedAt?: string;
    readonly preview?: string;
    readonly from?: ReadonlyArray<{ readonly email?: string; readonly name?: string }>;
  }>;
}

async function searchMaxbookMail(
  exec: NonNullable<VoiceToolsDeps["execCommand"]>,
  query: string,
  limit: number,
  since?: string,
): Promise<VoiceToolExecutionResult> {
  const fetchedAt = formatNyTime();
  const trimmedQuery = query.trim();
  const sinceArg =
    since && /^\d{4}-\d{2}-\d{2}$/u.test(since.trim())
      ? `--since ${since.trim()}`
      : trimmedQuery.length === 0
        ? `--since ${formatNyDate(new Date(Date.now() - 7 * 86_400_000))}`
        : "";
  const queryArg = trimmedQuery.length > 0 ? shellQuote(trimmedQuery) : "";
  const cmd = ["~/dev/40-bin/postroom-search --json", `--limit ${limit}`, sinceArg, queryArg]
    .filter((part) => part.length > 0)
    .join(" ");

  const res = await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "maxbook", cmd]);
  if (!res.ok || !res.stdout.trim().startsWith("{")) {
    return {
      ok: false,
      sourceAge: fetchedAt,
      error: `MaxBook offline or Postroom unreachable (${res.stderr.slice(0, 100) || "no response"}).`,
    };
  }
  try {
    const parsed = JSON.parse(res.stdout) as PostroomJson;
    const matches = (parsed.shown ?? []).slice(0, limit).map((row) => ({
      from: row.from?.[0]?.name || row.from?.[0]?.email || "Unknown",
      date: (row.receivedAt ?? "").slice(0, 16).replace("T", " "),
      subject: row.subject ?? "(no subject)",
      preview: (row.preview ?? "").replace(/\s+/gu, " ").trim().slice(0, 220),
    }));
    return {
      ok: true,
      sourceAge: fetchedAt,
      data: { query, matches },
    };
  } catch {
    return {
      ok: false,
      sourceAge: fetchedAt,
      error: "Postroom returned invalid JSON.",
    };
  }
}

function mapOwnerSearchSource(source: string): string {
  switch (source) {
    case "all":
      return "";
    case "messages":
      return "messages";
    case "calendar":
      return "calendar";
    case "meetings":
      return "meetings";
    case "calls":
      return "calls";
    case "contacts":
      return "contacts";
    case "notes":
      return "notes";
    case "screen":
      return "screen";
    default:
      return source;
  }
}

async function searchOwnerFleet(
  exec: NonNullable<VoiceToolsDeps["execCommand"]>,
  input: {
    readonly query: string;
    readonly source: string;
    readonly since?: string;
    readonly limit: number;
  },
): Promise<VoiceToolExecutionResult> {
  const fetchedAt = formatNyTime();
  const payload = Buffer.from(
    JSON.stringify({
      query: input.query,
      source: mapOwnerSearchSource(input.source),
      since: input.since ?? null,
      limit: input.limit,
    }),
    "utf8",
  ).toString("base64");
  const script = Buffer.from(
    [
      "import asyncio, base64, json, os, sys",
      `sys.path.insert(0, ${JSON.stringify(FLEET_VOICE_DIR_MAC)})`,
      "import owner_search",
      "args = json.loads(base64.b64decode(os.environ['VOICE_SEARCH_ARGS']).decode())",
      "res = asyncio.run(owner_search.fleet_search(args['query'], since=args['since'], source=args['source'], limit=args['limit']))",
      "print(json.dumps(res, ensure_ascii=False))",
    ].join("\n"),
    "utf8",
  ).toString("base64");

  const res = await exec("ssh", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=4",
    "maxbook",
    `VOICE_SEARCH_ARGS=${shellQuote(payload)} python3 -c 'import base64; exec(base64.b64decode("${script}").decode())'`,
  ]);
  if (!res.ok || !res.stdout.trim().startsWith("{")) {
    return {
      ok: false,
      sourceAge: fetchedAt,
      error: `MaxBook offline or Fleet search unreachable (${res.stderr.slice(0, 100) || "no response"}).`,
    };
  }
  try {
    const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
    return {
      ok: true,
      sourceAge: fetchedAt,
      data: parsed,
    };
  } catch {
    return {
      ok: false,
      sourceAge: fetchedAt,
      error: "Fleet search returned invalid JSON.",
    };
  }
}

interface NowJsonPayload {
  readonly primary_focus?: string;
  readonly tasks?: ReadonlyArray<{
    readonly id?: string;
    readonly title?: string;
    readonly deadline?: string | null;
    readonly status?: string;
  }>;
  readonly waiting?: ReadonlyArray<{
    readonly id?: string;
    readonly title?: string;
    readonly deadline?: string | null;
  }>;
  readonly mail?: ReadonlyArray<{
    readonly id?: string;
    readonly title?: string;
    readonly deadline?: string | null;
  }>;
}

async function readFreshPlan(
  exec: NonNullable<VoiceToolsDeps["execCommand"]>,
  filterQuery?: string,
): Promise<VoiceToolExecutionResult> {
  const fetchedAt = formatNyTime();
  const res = await exec("ssh", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=4",
    "journal",
    "cat /srv/journal/planner/primary/now.json",
  ]);
  if (!res.ok || !res.stdout.trim().startsWith("{")) {
    return {
      ok: false,
      sourceAge: fetchedAt,
      error: `Journal host offline or unreachable (${res.stderr.slice(0, 100) || "no response"}).`,
    };
  }
  try {
    const parsed = JSON.parse(res.stdout) as NowJsonPayload;
    const q = filterQuery?.trim().toLowerCase() ?? "";
    const match = (text?: string) => !q || (text ?? "").toLowerCase().includes(q);
    return {
      ok: true,
      sourceAge: fetchedAt,
      data: {
        primaryFocus: parsed.primary_focus ?? null,
        tasks: (parsed.tasks ?? []).filter((t) => match(t.title)).slice(0, 12),
        waiting: (parsed.waiting ?? []).filter((w) => match(w.title)).slice(0, 10),
        mail: (parsed.mail ?? []).filter((m) => match(m.title)).slice(0, 6),
      },
    };
  } catch {
    return {
      ok: false,
      sourceAge: fetchedAt,
      error: "Journal planner returned invalid JSON.",
    };
  }
}

const resolveLaunchProjectAndModel = Effect.fn("voice.resolveLaunchProjectAndModel")(function* (
  deps: VoiceToolsDeps,
  projectName?: string,
) {
  const projects = yield* deps.projectStore.listShells();
  const query = projectName?.trim().toLowerCase();
  const matchedProject = query
    ? (projects.find((project) => project.title.toLowerCase() === query) ??
      projects.find((project) => project.title.toLowerCase().includes(query)) ??
      projects.find((project) => project.workspaceRoot.toLowerCase().includes(query)))
    : undefined;

  const project = matchedProject
    ? {
        id: matchedProject.id,
        title: matchedProject.title,
        legacy: matchedProject,
      }
    : {
        id: (yield* deps.managedFolders.ensureScratchProject).projectId,
        title: "No project",
        legacy: null,
      };

  const [settings, providers] = yield* Effect.all([
    deps.serverSettings.getSettings,
    deps.providerRegistry.getProviders,
  ]);

  const projectSettings = resolveProjectSettings(settings, project.id, project.legacy).settings;
  const resolved = resolveNewThreadModelSelection({
    defaultSelection: projectSettings.defaultModelSelection,
    fallbackSelection: projectSettings.fallbackModelSelection,
    providers,
    settings,
    projectId: project.id,
    now: Date.now(),
  });

  return {
    projectId: project.id,
    projectTitle: project.title,
    modelSelection: resolved.selection,
  };
});

export function executeVoiceTool(
  input: ExecuteVoiceToolInput,
): Effect.Effect<VoiceToolExecutionResult> {
  const { deps, callId, name, args, scopedThreadId, emitCard, trackThread } = input;
  const cardId = `tool:${callId}`;
  const title = summarizeToolTitle(name, args);
  const exec = deps.execCommand ?? defaultExecCommand;

  return Effect.gen(function* () {
    emitCard({
      kind: "tool",
      id: cardId,
      tool: name,
      title,
      status: "running",
      updatedAt: new Date().toISOString(),
    });

    const outcome: VoiceToolExecutionResult = yield* Effect.gen(function* () {
      switch (name) {
        case "browne_threads": {
          const action = asNonEmptyString(args.action) ?? "list";
          if (action === "list") {
            const limit = asPositiveLimit(args.limit, 10, 20);
            const [snapshot, projects] = yield* Effect.all([
              deps.orchestrator.getShellSnapshot(),
              deps.projectStore.listShells(),
            ]);
            const projectById = new Map(projects.map((p) => [p.id, p.title]));
            const sorted = [...snapshot.threads]
              .sort(
                (left, right) =>
                  DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
              )
              .slice(0, limit);
            return {
              ok: true,
              sourceAge: formatNyTime(),
              data: {
                threads: sorted.map((thread) => ({
                  threadId: thread.id,
                  title: thread.title,
                  projectTitle: projectById.get(thread.projectId) ?? "No project",
                  status: thread.status,
                  pendingRequest:
                    thread.pendingRuntimeRequest === null
                      ? null
                      : {
                          requestId: thread.pendingRuntimeRequest.id,
                          kind: thread.pendingRuntimeRequest.kind,
                        },
                  latestMessage: thread.latestVisibleMessage?.text.slice(0, 180) ?? null,
                })),
              },
            };
          }

          if (action === "create") {
            const prompt = asNonEmptyString(args.prompt);
            if (!prompt) {
              return { ok: false, error: "Provide 'prompt' when creating a thread." };
            }
            const rawTitle = asNonEmptyString(args.title);
            const threadTitle = rawTitle ?? prompt.slice(0, 60);
            const { projectId, projectTitle, modelSelection } = yield* resolveLaunchProjectAndModel(
              deps,
              asNonEmptyString(args.project_name),
            );
            if (modelSelection === null) {
              return { ok: false, error: "No enabled AI provider/model is available on Browne." };
            }
            const commandId = CommandId.make(`voice:${NodeCrypto.randomUUID()}`);
            const launchResult = yield* deps.threadLaunch.launch({
              commandId,
              projectId,
              title: threadTitle,
              ...(rawTitle ? { titleRenamed: true } : {}),
              modelSelection,
              runtimeMode: "auto",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              initialMessage: {
                messageId: MessageId.make(`voice:${NodeCrypto.randomUUID()}`),
                text: prompt,
                attachments: [],
              },
              createdBy: "user",
              creationSource: "mobile",
            });
            trackThread(launchResult.threadId, launchResult.projection.thread.title);
            emitCard({
              kind: "thread",
              id: `thread:${launchResult.threadId}`,
              threadId: launchResult.threadId,
              title: launchResult.projection.thread.title,
              projectTitle,
              status: "created",
              summary: prompt.slice(0, 120),
              updatedAt: new Date().toISOString(),
            });
            return {
              ok: true,
              sourceAge: formatNyTime(),
              data: {
                threadId: launchResult.threadId,
                title: launchResult.projection.thread.title,
                projectTitle,
                status: "started",
              },
            };
          }

          // Resolve threadId directly, by title search, or default to scoped main session.
          const rawThreadId = asNonEmptyString(args.thread_id);
          const rawHint = asNonEmptyString(args.title);
          const effectiveThreadId =
            rawThreadId ??
            (scopedThreadId && (!rawHint || CURRENT_THREAD_ALIASES.has(rawHint.toLowerCase()))
              ? scopedThreadId
              : undefined);
          const [snapshot, projects] = yield* Effect.all([
            deps.orchestrator.getShellSnapshot(),
            deps.projectStore.listShells(),
          ]);
          const targetShell = effectiveThreadId
            ? snapshot.threads.find((t) => t.id === effectiveThreadId)
            : rawHint
              ? snapshot.threads.find((t) => t.title.toLowerCase().includes(rawHint.toLowerCase()))
              : undefined;

          if (!targetShell) {
            return {
              ok: false,
              error: effectiveThreadId
                ? `Thread ${effectiveThreadId} not found.`
                : "Specify a matching thread_id or thread title.",
            };
          }

          const projectTitle =
            projects.find((p) => p.id === targetShell.projectId)?.title ?? "No project";
          trackThread(targetShell.id, targetShell.title);

          if (action === "read") {
            const projection = yield* deps.orchestrator.getThreadProjection(targetShell.id);
            return {
              ok: true,
              sourceAge: formatNyTime(),
              data: {
                threadId: projection.thread.id,
                title: projection.thread.title,
                projectTitle,
                status: targetShell.status,
                branch: projection.thread.branch,
                worktreePath: projection.thread.worktreePath,
                pendingRequests: projection.runtimeRequests
                  .filter((req) => req.status === "pending")
                  .map((req) => ({ requestId: req.id, kind: req.kind })),
                recentActivity: summarizeProjectionActivity(projection, 10),
                recentMessages: projection.messages
                  .filter((msg) => msg.text.trim().length > 0)
                  .slice(-16)
                  .map((msg) => ({
                    role: msg.role,
                    text: msg.text.slice(0, 1_000),
                  })),
              },
            };
          }

          if (action === "send") {
            const prompt = asNonEmptyString(args.prompt);
            if (!prompt) {
              return { ok: false, error: "Provide 'prompt' to send to the thread." };
            }
            const sendResult = yield* deps.threadManagement.sendToThread({
              projectId: targetShell.projectId,
              commandId: CommandId.make(`voice:${NodeCrypto.randomUUID()}`),
              threadId: targetShell.id,
              messageId: MessageId.make(`voice:${NodeCrypto.randomUUID()}`),
              text: prompt,
              attachments: [],
              mode: "auto",
              createdBy: "user",
              creationSource: "mobile",
            });
            emitCard({
              kind: "thread",
              id: `thread:${targetShell.id}`,
              threadId: targetShell.id,
              title: targetShell.title,
              projectTitle,
              status: "steered",
              summary: prompt.slice(0, 120),
              updatedAt: new Date().toISOString(),
            });
            return {
              ok: true,
              sourceAge: formatNyTime(),
              data: {
                threadId: targetShell.id,
                title: targetShell.title,
                delivery: sendResult.delivery,
              },
            };
          }

          return { ok: false, error: `Unsupported action '${action}' on browne_threads.` };
        }

        case "browne_approvals": {
          const action = asNonEmptyString(args.action) ?? "list";
          const [snapshot, projects] = yield* Effect.all([
            deps.orchestrator.getShellSnapshot(),
            deps.projectStore.listShells(),
          ]);
          const projectById = new Map(projects.map((p) => [p.id, p.title]));

          if (action === "list") {
            const pending = snapshot.threads.filter((t) => t.pendingRuntimeRequest !== null);
            const items = pending.map((thread) => {
              const req = thread.pendingRuntimeRequest!;
              const card: TalkToFleetCard = {
                kind: "approval",
                id: `approval:${req.id}`,
                threadId: thread.id,
                requestId: req.id,
                threadTitle: thread.title,
                summary: `${req.kind} approval needed (${projectById.get(thread.projectId) ?? "No project"})`,
                status: "pending",
                updatedAt: new Date().toISOString(),
              };
              emitCard(card);
              trackThread(thread.id, thread.title);
              return {
                threadId: thread.id,
                threadTitle: thread.title,
                projectTitle: projectById.get(thread.projectId) ?? "No project",
                requestId: req.id,
                kind: req.kind,
              };
            });
            return {
              ok: true,
              sourceAge: formatNyTime(),
              data: { pending: items },
            };
          }

          if (action === "respond") {
            const rawThreadId = asNonEmptyString(args.thread_id) ?? scopedThreadId;
            const decision = asNonEmptyString(args.decision);
            if (!rawThreadId || (decision !== "accept" && decision !== "decline")) {
              return {
                ok: false,
                error: "Provide thread_id and decision ('accept' or 'decline').",
              };
            }
            const threadShell = snapshot.threads.find((t) => t.id === rawThreadId);
            const requestId =
              asNonEmptyString(args.request_id) ?? threadShell?.pendingRuntimeRequest?.id;
            if (!requestId) {
              return { ok: false, error: "No matching pending approval request found for thread." };
            }
            const commandId = CommandId.make(`voice:${NodeCrypto.randomUUID()}`);
            yield* deps.orchestrator.dispatch({
              type: "runtime-request.respond",
              commandId,
              threadId: ThreadId.make(rawThreadId),
              requestId: RuntimeRequestId.make(requestId),
              decision,
            });
            const threadTitle = threadShell?.title ?? "Thread";
            trackThread(rawThreadId, threadTitle);
            emitCard({
              kind: "approval",
              id: `approval:${requestId}`,
              threadId: rawThreadId,
              requestId,
              threadTitle,
              summary: `Decision: ${decision}`,
              status: decision === "accept" ? "approved" : "declined",
              updatedAt: new Date().toISOString(),
            });
            return {
              ok: true,
              sourceAge: formatNyTime(),
              data: { threadId: rawThreadId, requestId, decision },
            };
          }

          return { ok: false, error: `Unsupported action '${action}' on browne_approvals.` };
        }

        case "fleet_search": {
          const source = asNonEmptyString(args.source) ?? "all";
          const query = asNonEmptyString(args.query) ?? "";
          const since = asNonEmptyString(args.since);
          const limit = asPositiveLimit(args.limit, 5, 15);
          if (source === "wiki") {
            return yield* Effect.promise(() =>
              searchLocalWiki(deps.wikiDir ?? DEFAULT_WIKI_DIR, query, limit),
            );
          }
          if (source === "mail") {
            return yield* Effect.promise(() => searchMaxbookMail(exec, query, limit, since));
          }
          if (source === "plan") {
            return yield* Effect.promise(() => readFreshPlan(exec, query));
          }
          if (source === "all") {
            const [remote, wiki] = yield* Effect.promise(() =>
              Promise.all([
                searchOwnerFleet(exec, {
                  query,
                  source: "all",
                  ...(since ? { since } : {}),
                  limit,
                }),
                query.length > 0
                  ? searchLocalWiki(deps.wikiDir ?? DEFAULT_WIKI_DIR, query, Math.min(limit, 5))
                  : Promise.resolve({
                      ok: true,
                      data: { matches: [] },
                    } as VoiceToolExecutionResult),
              ]),
            );
            if (!remote.ok && !wiki.ok) {
              return remote;
            }
            return {
              ok: true,
              sourceAge: formatNyTime(),
              data: {
                query,
                fleet: remote.ok ? remote.data : { error: remote.error },
                wiki: wiki.ok ? wiki.data : { error: wiki.error },
              },
            };
          }
          if (
            source === "messages" ||
            source === "calendar" ||
            source === "meetings" ||
            source === "calls" ||
            source === "contacts" ||
            source === "notes" ||
            source === "screen"
          ) {
            return yield* Effect.promise(() =>
              searchOwnerFleet(exec, { query, source, ...(since ? { since } : {}), limit }),
            );
          }
          return { ok: false, error: `Unsupported search source '${source}'.` };
        }

        case "fleet_plan": {
          const action = asNonEmptyString(args.action) ?? "read";
          if (action === "read") {
            return yield* Effect.promise(() => readFreshPlan(exec));
          }
          if (action === "add") {
            const itemTitle = asNonEmptyString(args.title);
            if (!itemTitle) {
              return { ok: false, error: "Provide 'title' when adding to plan." };
            }
            const kind = asNonEmptyString(args.kind) === "waiting" ? "waiting" : "task";
            const parts = [
              "python3 /opt/life-planner/plan.py add",
              "--actor browne",
              `--title ${shellQuote(itemTitle)}`,
              `--kind ${kind}`,
              "--source browne-voice",
            ];
            const owner = asNonEmptyString(args.owner);
            const deadline = asNonEmptyString(args.deadline);
            if (owner) parts.push(`--owner ${shellQuote(owner)}`);
            if (deadline) parts.push(`--deadline ${shellQuote(deadline)}`);

            const res = yield* Effect.promise(() =>
              exec("ssh", [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=4",
                "journal",
                parts.join(" "),
              ]),
            );
            if (!res.ok) {
              return {
                ok: false,
                sourceAge: formatNyTime(),
                error: `Journal offline (${res.stderr.slice(0, 100) || "could not add item"}).`,
              };
            }
            yield* deps.contextCache.refreshNow.pipe(Effect.ignore, Effect.forkDetach);
            return {
              ok: true,
              sourceAge: formatNyTime(),
              data: {
                added: true,
                kind,
                title: itemTitle,
                owner: owner ?? null,
                deadline: deadline ?? null,
              },
            };
          }
          return { ok: false, error: `Unsupported fleet_plan action '${action}'.` };
        }

        case "fleet_delegate": {
          const task = asNonEmptyString(args.task);
          if (!task) {
            return { ok: false, error: "Provide 'task' instructions to delegate." };
          }
          const rawTitle = asNonEmptyString(args.title);
          const threadTitle = rawTitle ?? task.slice(0, 60);
          const { projectId, projectTitle, modelSelection } = yield* resolveLaunchProjectAndModel(
            deps,
            asNonEmptyString(args.project_name),
          );
          if (modelSelection === null) {
            return { ok: false, error: "No enabled AI provider/model is available on Browne." };
          }
          const launchResult = yield* deps.threadLaunch.launch({
            commandId: CommandId.make(`voice:${NodeCrypto.randomUUID()}`),
            projectId,
            title: threadTitle,
            ...(rawTitle ? { titleRenamed: true } : {}),
            modelSelection,
            runtimeMode: "auto",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId: MessageId.make(`voice:${NodeCrypto.randomUUID()}`),
              text: task,
              attachments: [],
            },
            createdBy: "user",
            creationSource: "mobile",
          });
          trackThread(launchResult.threadId, launchResult.projection.thread.title);
          emitCard({
            kind: "thread",
            id: `thread:${launchResult.threadId}`,
            threadId: launchResult.threadId,
            title: launchResult.projection.thread.title,
            projectTitle,
            status: "created",
            summary: task.slice(0, 120),
            updatedAt: new Date().toISOString(),
          });
          return {
            ok: true,
            sourceAge: formatNyTime(),
            data: {
              threadId: launchResult.threadId,
              title: launchResult.projection.thread.title,
              projectTitle,
              status: "started",
            },
          };
        }

        case "fleet_capture": {
          const text = asNonEmptyString(args.text);
          if (!text) {
            return { ok: false, error: "Provide 'text' to capture." };
          }
          const kind = asNonEmptyString(args.kind) ?? "note";
          if (kind === "waiting" || kind === "task") {
            const parts = [
              "python3 /opt/life-planner/plan.py add",
              "--actor browne",
              `--title ${shellQuote(text)}`,
              `--kind ${kind}`,
              "--source browne-voice",
            ];
            const owner = asNonEmptyString(args.owner);
            const deadline = asNonEmptyString(args.deadline);
            if (owner) parts.push(`--owner ${shellQuote(owner)}`);
            if (deadline) parts.push(`--deadline ${shellQuote(deadline)}`);
            const res = yield* Effect.promise(() =>
              exec("ssh", [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=4",
                "journal",
                parts.join(" "),
              ]),
            );
            if (!res.ok) {
              return {
                ok: false,
                sourceAge: formatNyTime(),
                error: `Journal offline (${res.stderr.slice(0, 100) || "capture failed"}).`,
              };
            }
            yield* deps.contextCache.refreshNow.pipe(Effect.ignore, Effect.forkDetach);
            return {
              ok: true,
              sourceAge: formatNyTime(),
              data: { captured: true, target: `journal/${kind}`, text },
            };
          }

          const res = yield* Effect.promise(() =>
            exec("ssh", [
              "-o",
              "BatchMode=yes",
              "-o",
              "ConnectTimeout=4",
              "maxbook",
              `python3 ~/system-architecture/services/wiki-librarian/remember.py --kind fact --source browne-voice ${shellQuote(text)}`,
            ]),
          );
          if (!res.ok) {
            return {
              ok: false,
              sourceAge: formatNyTime(),
              error: `MaxBook offline or librarian failed (${res.stderr.slice(0, 100) || "no response"}).`,
            };
          }
          return {
            ok: true,
            sourceAge: formatNyTime(),
            data: { captured: true, target: "maxbook/librarian", text },
          };
        }

        default:
          return { ok: false, error: `Unknown tool '${name}'.` };
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed<VoiceToolExecutionResult>({
          ok: false,
          error: cause.toString().slice(0, 180),
        }),
      ),
    );

    emitCard({
      kind: "tool",
      id: cardId,
      tool: name,
      title,
      status: outcome.ok ? "done" : "error",
      ...(outcome.ok ? {} : { detail: outcome.error ?? "Tool call failed." }),
      ...(outcome.sourceAge ? { sourceAge: outcome.sourceAge } : {}),
      updatedAt: new Date().toISOString(),
    });

    return outcome;
  });
}
