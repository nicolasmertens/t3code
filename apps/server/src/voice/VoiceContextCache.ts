// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - Wall-clock timestamps format the NY planner clock and cache age.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

const CACHE_REFRESH_INTERVAL = Duration.seconds(120);
const SSH_TIMEOUT_MS = 3_500;
const WIKI_DIR_DEFAULT = NodePath.join(NodeOS.homedir(), "wiki");
const MAX_BRIEFING_BYTES = 26_000;

export interface CachedExternalSourceStatus {
  readonly status: "ok" | "offline" | "empty";
  readonly fetchedAt: string;
  readonly detail?: string;
}

export interface CachedExternalSnapshot {
  readonly builtAt: string;
  readonly planSummary: string;
  readonly planStatus: CachedExternalSourceStatus;
  readonly mailSummary: string;
  readonly mailStatus: CachedExternalSourceStatus;
  readonly wikiSummary: string;
  readonly wikiStatus: CachedExternalSourceStatus;
}

export interface LiveBrowneThreadDigest {
  readonly id: string;
  readonly title: string;
  readonly projectTitle: string;
  readonly status: string;
  readonly attention: "approval" | "input" | null;
  readonly updatedAt: string;
}

export interface LiveBrowneSnapshot {
  readonly projects: ReadonlyArray<string>;
  readonly attentionThreads: ReadonlyArray<LiveBrowneThreadDigest>;
  readonly activeThreads: ReadonlyArray<LiveBrowneThreadDigest>;
  readonly scopedThread?: {
    readonly id: string;
    readonly title: string;
    readonly projectTitle: string;
    readonly recentMessages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  };
}

export interface VoiceBriefingResult {
  readonly text: string;
  readonly builtAt: string;
  readonly degradedSources: ReadonlyArray<string>;
}

interface NowJsonShape {
  readonly primary_focus?: string;
  readonly ambitions?: ReadonlyArray<string>;
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

interface PostroomSearchResultShape {
  readonly shown?: ReadonlyArray<{
    readonly id?: string;
    readonly subject?: string;
    readonly receivedAt?: string;
    readonly preview?: string;
    readonly _account?: string;
    readonly from?: ReadonlyArray<{ readonly email?: string; readonly name?: string }>;
  }>;
}

export function formatNyTime(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

async function execLimited(
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs = SSH_TIMEOUT_MS,
): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> {
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
          ? err.stderr
          : typeof err.message === "string"
            ? err.message
            : "command failed",
    };
  }
}

async function collectRecentWikiFiles(
  root: string,
  limit = 10,
): Promise<ReadonlyArray<{ readonly path: string; readonly mtimeMs: number }>> {
  const candidates: Array<{ readonly path: string; readonly mtimeMs: number }> = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 3 || candidates.length >= 250) return;
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
        try {
          const stat = await NodeFSP.stat(fullPath);
          candidates.push({ path: fullPath, mtimeMs: stat.mtimeMs });
        } catch {
          // ignore transient file
        }
      }
    }
  };
  await walk(root, 0);
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates.slice(0, limit);
}

export async function fetchPlanDigest(
  runExec = execLimited,
): Promise<{ readonly summary: string; readonly status: CachedExternalSourceStatus }> {
  const fetchedAt = formatNyTime();
  const res = await runExec("ssh", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=3",
    "journal",
    "cat /srv/journal/planner/primary/now.json",
  ]);
  if (!res.ok || !res.stdout.trim().startsWith("{")) {
    return {
      summary: "Plan unavailable (journal host offline or unreachable).",
      status: { status: "offline", fetchedAt, detail: res.stderr.trim().slice(0, 120) },
    };
  }
  try {
    const parsed = JSON.parse(res.stdout) as NowJsonShape;
    const lines: string[] = [];
    if (parsed.primary_focus) {
      lines.push(`Focus: ${parsed.primary_focus.trim()}`);
    }
    if (parsed.ambitions && parsed.ambitions.length > 0) {
      lines.push(`Ambitions: ${parsed.ambitions.slice(0, 4).join(" | ")}`);
    }
    if (parsed.tasks && parsed.tasks.length > 0) {
      lines.push("Open tasks:");
      for (const task of parsed.tasks.slice(0, 12)) {
        const deadline = task.deadline ? ` (due ${task.deadline})` : "";
        const status = task.status ? ` [${task.status}]` : "";
        if (task.title) lines.push(`- ${task.title.trim()}${deadline}${status}`);
      }
    }
    if (parsed.waiting && parsed.waiting.length > 0) {
      lines.push("Waiting items:");
      for (const item of parsed.waiting.slice(0, 8)) {
        const deadline = item.deadline ? ` (${item.deadline})` : "";
        if (item.title) lines.push(`- ${item.title.trim()}${deadline}`);
      }
    }
    return {
      summary: lines.length > 0 ? lines.join("\n") : "No active plan items.",
      status: { status: lines.length > 0 ? "ok" : "empty", fetchedAt },
    };
  } catch {
    return {
      summary: "Plan unreadable (invalid JSON from journal).",
      status: { status: "offline", fetchedAt, detail: "invalid now.json" },
    };
  }
}

export async function fetchMailDigest(
  runExec = execLimited,
): Promise<{ readonly summary: string; readonly status: CachedExternalSourceStatus }> {
  const fetchedAt = formatNyTime();
  const res = await runExec("ssh", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=3",
    "maxbook",
    "~/dev/40-bin/postroom-search --json --limit 15 ''",
  ]);
  if (!res.ok || !res.stdout.trim().startsWith("{")) {
    return {
      summary: "Postroom mail unavailable (maxbook offline or asleep).",
      status: { status: "offline", fetchedAt, detail: "maxbook offline" },
    };
  }
  try {
    const parsed = JSON.parse(res.stdout) as PostroomSearchResultShape;
    const rows = parsed.shown ?? [];
    if (rows.length === 0) {
      return {
        summary: "No recent emails returned by Postroom.",
        status: { status: "empty", fetchedAt },
      };
    }
    const lines = rows.slice(0, 15).map((row) => {
      const from = row.from?.[0]?.name || row.from?.[0]?.email || "Unknown";
      const date = (row.receivedAt ?? "").slice(0, 16).replace("T", " ");
      const subject = (row.subject ?? "(no subject)").replace(/\s+/g, " ").trim();
      const preview = (row.preview ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      return `- [${date || "recent"}] ${from}: ${subject}${preview ? `: ${preview}` : ""}`;
    });
    return {
      summary: lines.join("\n"),
      status: { status: "ok", fetchedAt },
    };
  } catch {
    return {
      summary: "Postroom mail unreadable (parse failure).",
      status: { status: "offline", fetchedAt, detail: "parse error" },
    };
  }
}

export async function fetchWikiDigest(
  wikiDir = WIKI_DIR_DEFAULT,
): Promise<{ readonly summary: string; readonly status: CachedExternalSourceStatus }> {
  const fetchedAt = formatNyTime();
  const files = await collectRecentWikiFiles(wikiDir, 8);
  if (files.length === 0) {
    return {
      summary: "No local wiki files found.",
      status: { status: "empty", fetchedAt },
    };
  }
  const sections: string[] = [];
  for (const file of files) {
    try {
      const content = await NodeFSP.readFile(file.path, "utf8");
      const rel = NodePath.relative(wikiDir, file.path);
      const compact = content.replace(/\r\n/g, "\n").trim();
      const tail = compact.length > 420 ? compact.slice(-420) : compact;
      sections.push(`### ${rel}\n${tail}`);
    } catch {
      // skip unreadable entry
    }
  }
  return {
    summary: sections.join("\n\n") || "No readable wiki snippets.",
    status: { status: sections.length > 0 ? "ok" : "empty", fetchedAt },
  };
}

export function capBriefingBytes(text: string, maxBytes = MAX_BRIEFING_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "\n\n[Briefing truncated to fit live voice budget.]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  const clipped = Buffer.from(text.slice(0, budget), "utf8")
    .subarray(0, budget)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${clipped}${suffix}`;
}

export function buildVoiceBriefing(input: {
  readonly external: CachedExternalSnapshot;
  readonly live: LiveBrowneSnapshot;
  readonly now?: Date;
}): VoiceBriefingResult {
  const nowStr = formatNyTime(input.now);
  const degradedSources: string[] = [];
  if (input.external.planStatus.status === "offline") degradedSources.push("journal");
  if (input.external.mailStatus.status === "offline") degradedSources.push("maxbook");
  if (input.external.wikiStatus.status === "offline") degradedSources.push("wiki");

  const parts: string[] = [];
  parts.push(`Current time (America/New_York): ${nowStr}`);
  if (degradedSources.length > 0) {
    parts.push(
      `Degraded offline sources: ${degradedSources.join(", ")}. Never guess data from them.`,
    );
  }

  parts.push("## Live Browne State");
  parts.push(
    `Projects: ${input.live.projects.length > 0 ? input.live.projects.join(", ") : "(none)"}`,
  );

  if (input.live.attentionThreads.length > 0) {
    parts.push("Threads needing attention:");
    for (const thread of input.live.attentionThreads.slice(0, 8)) {
      parts.push(
        `- [${thread.attention ?? thread.status}] ${thread.title} (${thread.projectTitle})`,
      );
    }
  } else {
    parts.push("Threads needing attention: none.");
  }

  if (input.live.activeThreads.length > 0) {
    parts.push("Recent active threads:");
    for (const thread of input.live.activeThreads.slice(0, 8)) {
      parts.push(`- [${thread.status}] ${thread.title} (${thread.projectTitle})`);
    }
  }

  if (input.live.scopedThread) {
    parts.push(
      `## Current Thread Context: ${input.live.scopedThread.title} (${input.live.scopedThread.projectTitle})`,
    );
    for (const msg of input.live.scopedThread.recentMessages.slice(-6)) {
      const compact = msg.text.replace(/\s+/g, " ").trim().slice(0, 320);
      parts.push(`${msg.role}: ${compact}`);
    }
  }

  parts.push(
    `## Planner Digest (journal, fetched ${input.external.planStatus.fetchedAt}, status: ${input.external.planStatus.status})`,
  );
  parts.push(input.external.planSummary);

  parts.push(
    `## Recent Mail Headlines (maxbook Postroom, fetched ${input.external.mailStatus.fetchedAt}, status: ${input.external.mailStatus.status})`,
  );
  parts.push(input.external.mailSummary);

  parts.push(`## Recent Wiki Highlights (local, fetched ${input.external.wikiStatus.fetchedAt})`);
  parts.push(input.external.wikiSummary);

  return {
    text: capBriefingBytes(parts.join("\n\n")),
    builtAt: input.external.builtAt,
    degradedSources,
  };
}

export class VoiceContextCache extends Context.Service<
  VoiceContextCache,
  {
    readonly getSnapshot: Effect.Effect<CachedExternalSnapshot>;
    readonly refreshNow: Effect.Effect<CachedExternalSnapshot>;
  }
>()("t3/voice/VoiceContextCache") {
  static readonly layer = Layer.effect(
    VoiceContextCache,
    Effect.gen(function* () {
      const initial: CachedExternalSnapshot = {
        builtAt: new Date().toISOString(),
        planSummary: "Loading planner digest...",
        planStatus: { status: "empty", fetchedAt: formatNyTime() },
        mailSummary: "Loading recent mail...",
        mailStatus: { status: "empty", fetchedAt: formatNyTime() },
        wikiSummary: "Loading wiki highlights...",
        wikiStatus: { status: "empty", fetchedAt: formatNyTime() },
      };
      const snapshotRef = yield* Ref.make(initial);

      const refreshNow = Effect.gen(function* () {
        const [plan, mail, wiki] = yield* Effect.promise(() =>
          Promise.all([fetchPlanDigest(), fetchMailDigest(), fetchWikiDigest()]),
        );
        const next: CachedExternalSnapshot = {
          builtAt: new Date().toISOString(),
          planSummary: plan.summary,
          planStatus: plan.status,
          mailSummary: mail.summary,
          mailStatus: mail.status,
          wikiSummary: wiki.summary,
          wikiStatus: wiki.status,
        };
        yield* Ref.set(snapshotRef, next);
        return next;
      });

      // Keep cache warm in memory without blocking server startup.
      yield* refreshNow.pipe(
        Effect.ignore,
        Effect.repeat(Schedule.spaced(CACHE_REFRESH_INTERVAL)),
        Effect.forkScoped,
      );

      return VoiceContextCache.of({
        getSnapshot: Ref.get(snapshotRef),
        refreshNow,
      });
    }),
  );
}
