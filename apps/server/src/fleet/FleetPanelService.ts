// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  type FleetAttachmentSummary,
  type FleetBrownePayload,
  type FleetDegradedSensor,
  type FleetHostEntry,
  type FleetLibrarianCard,
  type FleetLibrarianPayload,
  type FleetMailMessage,
  type FleetMailPayload,
  type FleetOpenBotDirector,
  type FleetOpenBotsPayload,
  type FleetPanelActionInput,
  type FleetPanelActionResult,
  type FleetPanelContextInput,
  type FleetPanelContextResult,
  type FleetPlanPayload,
  type FleetPlanTask,
  type FleetPulsePayload,
  type FleetStandingRule,
  type FleetTrayItem,
  type FleetTrayPayload,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

const CACHE_TTL_MS = 25_000;
const EXEC_TIMEOUT_MS = 3_500;
const METRICS_TIMEOUT_MS = 500;

const FLEET_MANIFEST_PATH =
  "/home/nico/.t3/projects/fleet-architecture/registry/fleet-manifest.yaml";
const WIKI_ROOT = "/home/nico/wiki";
const RULES_ROOT = "/home/nico/.grok/rules";
const MEETING_RECORDINGS_ROOT = "/home/nico/meeting-recordings";
const FLEET_FILES_BIN = "/home/nico/dev/40-bin/fleet-files";
const BOT_BIN = "/home/nico/dev/40-bin/bot";
const BROWNE_METRICS_URL = "http://100.96.0.18:3783/api/browne/metrics";

const ALLOWLISTED_DOMAINS = [
  "fluvius.be",
  "zksprojects.be",
  "arnino.be",
  "vdo-architecten.be",
  "vestad.be",
  "water-link.be",
] as const;

const KEYWORD_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "have",
  "will",
  "just",
  "what",
  "when",
  "where",
  "which",
  "about",
  "could",
  "would",
  "should",
  "thread",
  "agents",
  "home",
  "nico",
  "work",
  "van",
  "een",
  "het",
  "dat",
  "met",
  "voor",
  "niet",
  "maar",
  "zijn",
  "deze",
  "aan",
  "ook",
  "naar",
  "over",
]);

const FINANCE_FRONTIER_PATTERN =
  /\b(finance|accounting|boekhoud\w*|odoo|btw|vat|tax|ledger|reconcil\w*|bank|peppol|yuki|invoice|factuur|facturen|cfo|cash\s*flow|balans|krediet\w*|lening|budget|controller)\b/i;

const PARKED_VENTURE_PATTERNS: ReadonlyArray<{ readonly name: string; readonly regex: RegExp }> = [
  { name: "1Test.me", regex: /\b1test(?:\.me)?\b/i },
  { name: "Siteroutes", regex: /\bsiteroutes\b/i },
  { name: "Humble Tools", regex: /\bhumble[-\s]?tools\b/i },
  { name: "Buzz", regex: /\b(buzz\s*room|buzz\s*feed)\b/i },
];

const FALLBACK_HOSTS: ReadonlyArray<FleetHostEntry> = [
  { alias: "agents", role: "agent_exec", ok: true, detail: "Primary execution host" },
  { alias: "maxbook", role: "workstation_edge", ok: true, detail: "Workstation edge & capture" },
  { alias: "macmini", role: "mac_executor", ok: true, detail: "Mac executor & relay" },
  { alias: "nicbook", role: "travel_laptop", ok: true, detail: "Travel laptop" },
  { alias: "journal", role: "planner_truth", ok: true, detail: "plan.db & ingest" },
  { alias: "erp", role: "odoo_erp", ok: true, detail: "Odoo 19 & Peppol" },
];

interface DirectorSeed {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly domain: string;
  readonly lane: "groene-laan" | "finance-gate" | "specialist";
  readonly keywords: ReadonlyArray<string>;
}

const DIRECTOR_ROSTER: ReadonlyArray<DirectorSeed> = [
  {
    id: "mrtns-victor",
    name: "MRTNS Victor",
    role: "Real Estate & External Follow-up",
    domain: "Properties, tenants, contractors",
    lane: "groene-laan",
    keywords: [
      "mrtns",
      "vastgoed",
      "fluvius",
      "arnino",
      "zks",
      "vdo",
      "vestad",
      "water",
      "vs12",
      "fl140",
      "gs21",
      "kds27",
      "ls7",
    ],
  },
  {
    id: "mrtns-cfo",
    name: "MRTNS - CFO",
    role: "Finance Sparring (read-only)",
    domain: "Odoo facts & controller prep; handoffs go to Opus/Astra",
    lane: "finance-gate",
    keywords: [
      "finance",
      "odoo",
      "btw",
      "vat",
      "bank",
      "cashflow",
      "invoice",
      "factuur",
      "boekhouding",
      "cfo",
      "credit",
      "krediet",
    ],
  },
  {
    id: "sys-architect",
    name: "Sys Architect",
    role: "Architecture & Service Ownership",
    domain: "Fleet services, Browne, T3 Code, pipelines",
    lane: "specialist",
    keywords: [
      "browne",
      "t3",
      "architecture",
      "fleet",
      "service",
      "systemd",
      "mcp",
      "pipeline",
      "daemon",
    ],
  },
  {
    id: "sysadmin",
    name: "SysAdmin",
    role: "Hosts, SSH, Tailscale & Containers",
    domain: "agents, maxbook, journal, macmini, disk/RAM",
    lane: "groene-laan",
    keywords: [
      "ssh",
      "tailscale",
      "docker",
      "systemd",
      "disk",
      "restart",
      "host",
      "deploy",
      "build",
    ],
  },
  {
    id: "annie-mation",
    name: "Annie Mation",
    role: "Visual & Motion Director",
    domain: "Video, UI motion, screenshots & demos",
    lane: "groene-laan",
    keywords: ["video", "animation", "demo", "ui", "visual", "design", "browser"],
  },
  {
    id: "rob-otten",
    name: "Rob Otten",
    role: "Automation & Scraping Runner",
    domain: "Routine collection, scripts, browser jobs",
    lane: "specialist",
    keywords: ["scrape", "automation", "cron", "sync", "collect", "script"],
  },
  {
    id: "clipper",
    name: "Clipper",
    role: "Research & Media Capture",
    domain: "Web captures, articles, X & reference clips",
    lane: "specialist",
    keywords: ["research", "article", "clip", "docs", "link", "social"],
  },
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function runExec(
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs = EXEC_TIMEOUT_MS,
): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> {
  try {
    const result = await execFileAsync(command, [...args], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
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
          : err.message instanceof Error || typeof err.message === "string"
            ? String(err.message)
            : "command failed",
    };
  }
}

export function extractThreadKeywords(input: {
  readonly threadTitle?: string | undefined;
  readonly projectName?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly query?: string | undefined;
  readonly recentText?: string | undefined;
}): string[] {
  const parts = [
    input.query ?? "",
    input.threadTitle ?? "",
    input.projectName ?? "",
    input.workspaceRoot ? NodePath.basename(input.workspaceRoot) : "",
    input.recentText ?? "",
  ];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const part of parts) {
    const tokens = part
      .toLowerCase()
      .split(/[^a-z0-9-]+/gu)
      .map((token) => token.replace(/^-+|-+$/gu, ""))
      .filter((token) => token.length >= 3 && !KEYWORD_STOPWORDS.has(token));
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      keywords.push(token);
      if (keywords.length >= 12) {
        return keywords;
      }
    }
  }
  return keywords;
}

export function detectFinanceFrontierRequired(text: string): boolean {
  return FINANCE_FRONTIER_PATTERN.test(text);
}

export function detectParkedVentureDrift(text: string): string | undefined {
  for (const venture of PARKED_VENTURE_PATTERNS) {
    if (venture.regex.test(text)) {
      return `Possible drift toward parked venture (${venture.name}); primary focus is MRTNS Real Estate, System Architecture, and Browne.`;
    }
  }
  return undefined;
}

export function computeEtTimeBoundary(now: Date): FleetPlanPayload["timeBoundary"] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hourRaw = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minuteRaw = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const etTime = `${String(hourRaw).padStart(2, "0")}:${String(minuteRaw).padStart(2, "0")} ET`;
  const isTrainingDay = weekday === "Mon" || weekday === "Wed" || weekday === "Fri";
  const isWeekday = isTrainingDay || weekday === "Tue" || weekday === "Thu";
  const targetMinutes = isTrainingDay ? 16 * 60 + 20 : 17 * 60 + 20;
  const currentMinutes = hourRaw * 60 + minuteRaw;
  const diff = targetMinutes - currentMinutes;
  const isStopSoon = isWeekday && diff <= 45 && currentMinutes <= 19 * 60;
  const label = !isWeekday
    ? `${weekday} weekend - flexible family rhythm`
    : isTrainingDay
      ? `${weekday} hard stop 16:20 (training)`
      : `${weekday} hard stop 17:20 (William pickup)`;
  return {
    etTime,
    label,
    isStopSoon,
    isTrainingDay,
  };
}

export function parseWikiCard(
  filePath: string,
  content: string,
  mtimeMs: number,
  nowMs = Date.now(),
): FleetLibrarianCard {
  const slugBase = NodePath.basename(filePath, ".md");
  let slug = slugBase;
  let updatedAt: string | undefined;

  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/u);
  if (frontmatterMatch?.[1]) {
    for (const line of frontmatterMatch[1].split("\n")) {
      const slugMatch = line.match(/^slug:\s*(.+)$/u);
      if (slugMatch?.[1]) {
        slug = slugMatch[1].trim().replace(/^["']|["']$/gu, "");
      }
      const updatedMatch = line.match(/^(?:last_updated|updated|date):\s*(.+)$/u);
      if (updatedMatch?.[1]) {
        updatedAt = updatedMatch[1].trim().replace(/^["']|["']$/gu, "");
      }
    }
  }

  const headingMatch = content.match(/^#\s+(.+)$/mu);
  const title = headingMatch?.[1]?.trim() ?? slug;

  const nextActionMatch =
    content.match(/##\s*(?:Next|Active goals|TODO)[^\n]*\n+[-*]\s+(.+)/iu) ??
    content.match(/-\s+\[\s\]\s+(.+)/u);
  const nextAction = nextActionMatch?.[1]?.trim().slice(0, 140);

  let referenceMs = Number.isFinite(mtimeMs) ? mtimeMs : 0;
  if (updatedAt) {
    const parsed = Date.parse(updatedAt);
    if (!Number.isNaN(parsed)) {
      referenceMs = parsed;
    }
  } else if (mtimeMs > 0) {
    updatedAt = new Date(mtimeMs).toISOString().slice(0, 10);
  }

  let freshness: FleetLibrarianCard["freshness"] = "unknown";
  if (referenceMs > 0) {
    const ageDays = (nowMs - referenceMs) / (1000 * 60 * 60 * 24);
    freshness = ageDays <= 45 ? "verified" : "stale";
  }

  return {
    slug,
    title,
    path: filePath,
    freshness,
    ...(updatedAt ? { updatedAt } : {}),
    ...(nextAction ? { nextAction } : {}),
  };
}

export function scrubBriefSecrets(text: string): string {
  return text
    .replace(
      /-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]+ PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|gho_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{12,})\b/g,
      "[REDACTED_TOKEN]",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1[REDACTED_TOKEN]")
    .replace(
      /\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?)[^\s"']{6,}/gi,
      "$1[REDACTED]",
    );
}

export function extractTrayItemsFromText(
  text: string,
  savedDecisions: Record<string, "pending" | "approved" | "rejected">,
): FleetTrayItem[] {
  const items: FleetTrayItem[] = [];
  const seen = new Set<string>();

  const signudocMatches = text.matchAll(
    /https?:\/\/[^\s)]+signudoc[^\s)]*|\bHAND[-:\s#]+[A-Za-z0-9_-]+/gi,
  );
  for (const match of signudocMatches) {
    const raw = match[0].trim();
    const id = `hand-${raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .slice(0, 48)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      kind: "hand_atom",
      title: raw.startsWith("http") ? "SignuDoc 30s HAND link" : `SignuDoc atom ${raw}`,
      detail: raw,
      ...(raw.startsWith("http") ? { url: raw } : {}),
      copyText: raw,
      decision: savedDecisions[id] ?? "pending",
    });
  }

  const lines = text.split("\n").map((line) => line.trim());
  for (const line of lines) {
    if (/^(?:Approval|Akkoord|Goedkeuring|Decision needed)\s*[:-]/iu.test(line)) {
      const clean = line.slice(0, 140);
      const id = `approval-${clean
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .slice(0, 40)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({
        id,
        kind: "approval",
        title: clean,
        detail: "Pending RvB sign-off",
        copyText: clean,
        decision: savedDecisions[id] ?? "pending",
      });
    } else if (/^(?:Outbound|Draft reply|Concept-antwoord)\s*[:-]/iu.test(line)) {
      const clean = line.slice(0, 180);
      const id = `outbound-${clean
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .slice(0, 40)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({
        id,
        kind: "outbound",
        title: "Outbound draft snippet",
        detail: clean,
        copyText: clean.replace(/^(?:Outbound|Draft reply|Concept-antwoord)\s*[:-]\s*/iu, ""),
        decision: savedDecisions[id] ?? "pending",
      });
    }
    if (items.length >= 8) break;
  }

  return items;
}

export function parseFleetManifestHosts(yamlText: string): FleetHostEntry[] {
  const hosts: FleetHostEntry[] = [];
  const lines = yamlText.split("\n");
  let inHosts = false;
  let currentAlias: string | null = null;
  let currentRole = "fleet_node";
  let currentNotes = "";

  const flush = () => {
    if (!currentAlias) return;
    hosts.push({
      alias: currentAlias,
      role: currentRole,
      ok: true,
      ...(currentNotes ? { detail: currentNotes.slice(0, 96) } : {}),
    });
    currentAlias = null;
    currentRole = "fleet_node";
    currentNotes = "";
  };

  for (const line of lines) {
    if (/^hosts:\s*$/u.test(line)) {
      inHosts = true;
      continue;
    }
    if (inHosts && /^[a-zA-Z_][a-zA-Z0-9_-]*:\s*/u.test(line)) {
      flush();
      break;
    }
    if (!inHosts) continue;
    const hostMatch = line.match(/^  ([a-z0-9_-]+):\s*$/u);
    if (hostMatch?.[1]) {
      flush();
      currentAlias = hostMatch[1];
      continue;
    }
    const roleMatch = line.match(/^\s+role:\s*"?([^"\n]+)"?/u);
    if (roleMatch?.[1]) currentRole = roleMatch[1].trim();
    const notesMatch = line.match(/^\s+notes:\s*"?([^"\n]+)"?/u);
    if (notesMatch?.[1]) currentNotes = notesMatch[1].trim();
  }
  flush();

  return hosts.length > 0 ? hosts : [...FALLBACK_HOSTS];
}

interface PersistedPanelState {
  frozen?: boolean;
}

interface PersistedTrayState {
  decisions?: Record<string, "pending" | "approved" | "rejected">;
  locks?: Record<string, { readonly lockedAt: string; readonly summary: string }>;
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await NodeFSP.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  await NodeFSP.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function collectProjectionText(projection: unknown): {
  readonly recentText: string;
  readonly itemCount: number;
  readonly estimatedTokens: number;
  readonly shackleNumber: number;
  readonly toolReceipts: number;
  readonly verifiedSources: string[];
  readonly threadTitle?: string | undefined;
  readonly threadSettled: boolean;
} {
  if (!projection || typeof projection !== "object") {
    return {
      recentText: "",
      itemCount: 0,
      estimatedTokens: 0,
      shackleNumber: 1,
      toolReceipts: 0,
      verifiedSources: [],
      threadSettled: false,
    };
  }
  const proj = projection as {
    readonly thread?: {
      readonly title?: string;
      readonly settledOverride?: string | null;
      readonly settledAt?: unknown;
    };
    readonly messages?: ReadonlyArray<{ readonly text?: string; readonly role?: string }>;
    readonly turnItems?: ReadonlyArray<{ readonly type?: string; readonly item?: unknown }>;
    readonly contextHandoffs?: ReadonlyArray<unknown>;
  };
  const messages = Array.isArray(proj.messages) ? proj.messages : [];
  const turnItems = Array.isArray(proj.turnItems) ? proj.turnItems : [];
  const handoffs = Array.isArray(proj.contextHandoffs) ? proj.contextHandoffs : [];

  const messageTexts = messages
    .slice(-12)
    .map((m) => (typeof m.text === "string" ? m.text : ""))
    .filter((t) => t.length > 0);
  const recentText = messageTexts.join("\n").slice(0, 8_000);
  const charCount = messages.reduce(
    (sum, m) => sum + (typeof m.text === "string" ? m.text.length : 0),
    0,
  );
  let toolReceipts = 0;
  for (const item of turnItems) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.type === "string" &&
      item.type.includes("tool")
    ) {
      toolReceipts += 1;
    }
  }
  const verifiedSources: string[] = [];
  const pathMatches = recentText.matchAll(/(?:\/home\/nico\/[^\s)]+|https?:\/\/[^\s)]+)/gu);
  for (const match of pathMatches) {
    if (!verifiedSources.includes(match[0])) {
      verifiedSources.push(match[0]);
    }
    if (verifiedSources.length >= 6) break;
  }
  const settled =
    proj.thread?.settledOverride === "settled" ||
    (proj.thread?.settledOverride !== "active" && proj.thread?.settledAt != null);

  return {
    recentText,
    itemCount: turnItems.length + messages.length,
    estimatedTokens: Math.round(charCount / 4),
    shackleNumber: handoffs.length + 1,
    toolReceipts,
    verifiedSources,
    threadTitle: typeof proj.thread?.title === "string" ? proj.thread.title : undefined,
    threadSettled: settled,
  };
}

interface NowJsonShape {
  readonly mail?: ReadonlyArray<{
    readonly id?: string;
    readonly title?: string;
    readonly deadline?: string | null;
  }>;
  readonly blocks?: ReadonlyArray<{
    readonly id?: string;
    readonly title?: string;
    readonly tier?: string;
    readonly reason?: string;
  }>;
  readonly t1_not_in_window?: ReadonlyArray<{
    readonly id?: string;
    readonly title?: string;
    readonly reason?: string;
  }>;
  readonly waiting?: ReadonlyArray<{
    readonly id?: string;
    readonly title?: string;
    readonly owner?: string;
    readonly deadline?: string | null;
    readonly status?: string;
  }>;
}

interface PostroomSearchResultShape {
  readonly shown?: ReadonlyArray<{
    readonly id?: string;
    readonly subject?: string;
    readonly from?: ReadonlyArray<{ readonly email?: string; readonly name?: string }>;
    readonly receivedAt?: string;
    readonly preview?: string;
    readonly _account?: string;
    readonly mailboxIds?: Record<string, boolean>;
  }>;
}

async function listRecentFiles(dir: string, limit: number): Promise<FleetAttachmentSummary[]> {
  try {
    const entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    const files: Array<{ readonly name: string; readonly path: string; readonly mtimeMs: number }> =
      [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const fullPath = NodePath.join(dir, entry.name);
      const stat = await NodeFSP.stat(fullPath).catch(() => null);
      if (!stat) continue;
      files.push({ name: entry.name, path: fullPath, mtimeMs: stat.mtimeMs });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files.slice(0, limit).map((f) => ({
      name: f.name,
      path: f.path,
      updatedAt: new Date(f.mtimeMs).toISOString().slice(0, 16).replace("T", " "),
    }));
  } catch {
    return [];
  }
}

async function scanWikiCards(
  keywords: ReadonlyArray<string>,
  financeRequired: boolean,
): Promise<{
  readonly cards: FleetLibrarianCard[];
  readonly rules: FleetStandingRule[];
}> {
  const dirs = ["domains", "entities", "projects", "properties", "objectives"];
  const scored: Array<{ readonly score: number; readonly card: FleetLibrarianCard }> = [];
  const lowerKws = keywords.map((k) => k.toLowerCase());

  for (const subdir of dirs) {
    const folder = NodePath.join(WIKI_ROOT, subdir);
    const entries = await NodeFSP.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.slice(0, 80)) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
      const fullPath = NodePath.join(folder, entry.name);
      const stat = await NodeFSP.stat(fullPath).catch(() => null);
      if (!stat) continue;
      const content = await NodeFSP.readFile(fullPath, "utf8").catch(() => "");
      if (!content) continue;
      const card = parseWikiCard(fullPath, content, stat.mtimeMs);
      const haystack = `${card.slug} ${card.title} ${content.slice(0, 600)}`.toLowerCase();
      let score = 0;
      for (const kw of lowerKws) {
        if (haystack.includes(kw)) score += card.slug.toLowerCase().includes(kw) ? 3 : 1;
      }
      if (score > 0 || (subdir === "domains" && scored.length < 4)) {
        scored.push({ score, card });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const candidateRules = [
    "finance-frontier-only.md",
    "mail-follow-up-owned.md",
    "delegate-to-bots.md",
    "pursue-this.md",
    "decision-lock-showpiece.md",
  ];
  const rules: FleetStandingRule[] = [];
  for (const name of candidateRules) {
    const rulePath = NodePath.join(RULES_ROOT, name);
    const content = await NodeFSP.readFile(rulePath, "utf8").catch(() => "");
    if (!content) continue;
    const summaryLine =
      content
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("---")) ??
      name;
    if (name === "finance-frontier-only.md" && !financeRequired && rules.length >= 2) {
      continue;
    }
    rules.push({
      name: name.replace(/\.md$/u, ""),
      path: rulePath,
      summary: summaryLine.slice(0, 120),
      locked: true,
    });
  }

  return {
    cards: scored.slice(0, 6).map((item) => item.card),
    rules: rules.slice(0, 4),
  };
}

export interface FleetPanelServiceShape {
  readonly getContext: (input: FleetPanelContextInput) => Effect.Effect<FleetPanelContextResult>;
  readonly runAction: (input: FleetPanelActionInput) => Effect.Effect<FleetPanelActionResult>;
}

export class FleetPanelService extends Context.Service<FleetPanelService, FleetPanelServiceShape>()(
  "t3/fleet/FleetPanelService",
) {
  static readonly layer = Layer.effect(
    FleetPanelService,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const projections = yield* ProjectionStoreV2.ProjectionStoreV2;

      const cache = new Map<
        string,
        { readonly expiresAt: number; readonly data: FleetPanelContextResult }
      >();
      const stateFilePath = NodePath.join(config.stateDir, "fleet-panel-state.json");
      const trayFilePath = NodePath.join(config.stateDir, "fleet-panel-tray.json");

      const readFleetPulse = async (
        keywords: ReadonlyArray<string>,
      ): Promise<FleetPulsePayload> => {
        const manifestRaw = await NodeFSP.readFile(FLEET_MANIFEST_PATH, "utf8").catch(() => "");
        const hosts = manifestRaw ? parseFleetManifestHosts(manifestRaw) : [...FALLBACK_HOSTS];
        const primaryKw = keywords[0] ?? "mrtns";

        const [recentMeetings, fleetFilesRes, soRes] = await Promise.all([
          listRecentFiles(MEETING_RECORDINGS_ROOT, 4),
          runExec(FLEET_FILES_BIN, ["search", primaryKw, "--limit", "5", "--json"]),
          runExec("ssh", [
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=2",
            "maxbook",
            "/Users/nico/dev/40-bin/so latest 2>/dev/null || ls -1t ~/screen-ring/*.jpg 2>/dev/null | head -n 1",
          ]),
        ]);

        let storageFiles: FleetAttachmentSummary[] = [];
        if (fleetFilesRes.ok && fleetFilesRes.stdout.trim().startsWith("[")) {
          try {
            const parsed = JSON.parse(fleetFilesRes.stdout) as ReadonlyArray<{
              readonly path?: string;
              readonly relpath?: string;
              readonly mtime?: string;
            }>;
            storageFiles = parsed.slice(0, 5).map((item) => ({
              name: item.relpath
                ? NodePath.basename(item.relpath)
                : NodePath.basename(item.path ?? "file"),
              path: item.path ?? item.relpath ?? "",
              ...(item.mtime ? { updatedAt: item.mtime.slice(0, 16) } : {}),
            }));
          } catch {
            storageFiles = [];
          }
        }

        const degradedSensors: FleetDegradedSensor[] = [];
        if (!soRes.ok && !soRes.stdout.trim()) {
          degradedSensors.push({
            name: "screen-observer",
            host: "maxbook",
            detail: "Screen Observer unreachable over SSH",
          });
        }

        return {
          status: degradedSensors.length > 0 ? "degraded" : "ok",
          hostName: "agents",
          hosts: hosts.slice(0, 8),
          degradedSensors,
          recentMeetings,
          storageFiles,
          screenObserver: {
            available: Boolean(soRes.ok && soRes.stdout.trim().length > 0),
            ...(soRes.stdout.trim() ? { updatedAt: new Date().toISOString().slice(11, 16) } : {}),
          },
        };
      };

      const readNowJson = async (): Promise<{
        readonly ok: boolean;
        readonly data: NowJsonShape | null;
        readonly note?: string;
      }> => {
        const res = await runExec("ssh", [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=2",
          "journal",
          "cat /srv/journal/planner/primary/now.json",
        ]);
        if (!res.ok) {
          return { ok: false, data: null, note: "journal planner offline" };
        }
        try {
          return { ok: true, data: JSON.parse(res.stdout) as NowJsonShape };
        } catch {
          return { ok: false, data: null, note: "invalid now.json" };
        }
      };

      const buildPlanPayload = (
        nowResult: {
          readonly ok: boolean;
          readonly data: NowJsonShape | null;
          readonly note?: string;
        },
        keywords: ReadonlyArray<string>,
        combinedText: string,
      ): FleetPlanPayload => {
        const lowerKws = keywords.map((k) => k.toLowerCase());
        const matchesKw = (title: string) => {
          const lower = title.toLowerCase();
          return lowerKws.some((k) => lower.includes(k));
        };

        const data = nowResult.data;
        const blockTasks: FleetPlanTask[] = [];
        for (const block of data?.blocks ?? []) {
          if (block.id && block.title) {
            blockTasks.push({
              id: block.id,
              title: block.title,
              status: block.tier ?? "block",
              source: "plan.db",
            });
          }
        }
        for (const item of data?.t1_not_in_window ?? []) {
          if (item.id && item.title) {
            blockTasks.push({
              id: item.id,
              title: item.title,
              status: "T1",
              source: "plan.db",
            });
          }
        }
        const sortedTasks = [...blockTasks].sort(
          (a, b) => Number(matchesKw(b.title)) - Number(matchesKw(a.title)),
        );

        const waitingItems: FleetPlanTask[] = (data?.waiting ?? [])
          .filter((item) => Boolean(item.id && item.title))
          .slice(0, 6)
          .map((item) => ({
            id: item.id ?? "wait",
            title: item.title ?? "",
            deadline: item.deadline ?? null,
            ...(item.owner ? { status: item.owner } : {}),
            source: "plan.db",
          }));

        const driftWarning = detectParkedVentureDrift(combinedText);

        return {
          status: nowResult.ok ? "ok" : "degraded",
          ...(nowResult.note ? { note: nowResult.note } : {}),
          primaryFocus: "MRTNS Real Estate · System Architecture · Browne",
          ambitions: ["Debt walls", "System automation", "Family rhythm"],
          matchedTasks: sortedTasks.slice(0, 5),
          waitingItems,
          ...(driftWarning ? { driftWarning } : {}),
          timeBoundary: computeEtTimeBoundary(new Date()),
        };
      };

      const readMailPayload = async (
        queryUsed: string,
        nowResult: { readonly data: NowJsonShape | null },
      ): Promise<FleetMailPayload> => {
        const safeQuery = queryUsed.trim().length > 0 ? queryUsed.trim() : "mrtns";
        const postroomRes = await runExec("ssh", [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=3",
          "maxbook",
          `~/dev/40-bin/postroom-search --json --limit 6 ${shellQuote(safeQuery)}`,
        ]);

        const messages: FleetMailMessage[] = [];
        let draftsCount = 0;

        if (postroomRes.ok && postroomRes.stdout.trim().startsWith("{")) {
          try {
            const parsed = JSON.parse(postroomRes.stdout) as PostroomSearchResultShape;
            for (const row of parsed.shown ?? []) {
              const fromEmail = row.from?.[0]?.email ?? "";
              const fromName = row.from?.[0]?.name ?? fromEmail;
              const subject = row.subject ?? "(no subject)";
              const haystack = `${fromEmail} ${subject}`.toLowerCase();
              const allowlistOwner = ALLOWLISTED_DOMAINS.some((domain) =>
                haystack.includes(domain),
              );
              const isDraft = Boolean(
                row.mailboxIds &&
                Object.keys(row.mailboxIds).some((k) => k.toLowerCase().includes("draft")),
              );
              if (isDraft) draftsCount += 1;
              messages.push({
                id: row.id ?? `mail-${messages.length}`,
                subject,
                from: fromName || fromEmail || "Unknown",
                date: (row.receivedAt ?? "").slice(0, 16).replace("T", " "),
                snippet: (row.preview ?? "").slice(0, 140),
                ...(row._account ? { account: row._account } : {}),
                isDraft,
                allowlistOwner,
              });
            }
          } catch {
            // Fall through to now.json mail items
          }
        }

        if (messages.length === 0) {
          for (const item of (nowResult.data?.mail ?? []).slice(0, 5)) {
            if (!item.id || !item.title) continue;
            const allowlistOwner = ALLOWLISTED_DOMAINS.some((domain) =>
              item.title?.toLowerCase().includes(domain),
            );
            messages.push({
              id: item.id,
              subject: item.title,
              from: "plan.db mail loop",
              date: item.deadline ?? "open",
              snippet: item.title,
              allowlistOwner,
            });
          }
        }

        return {
          status: postroomRes.ok ? "ok" : messages.length > 0 ? "degraded" : "offline",
          ...(postroomRes.ok ? {} : { note: "postroom offline on maxbook" }),
          queryUsed: safeQuery,
          messages: messages.slice(0, 6),
          draftsCount,
          followUpOwner: {
            name: "MRTNS Victor",
            address: "victor@mrtns.io",
            allowlisted: true,
            domains: [...ALLOWLISTED_DOMAINS],
          },
        };
      };

      const readOpenBotsPayload = async (
        keywords: ReadonlyArray<string>,
      ): Promise<FleetOpenBotsPayload> => {
        const persistedState = await readJsonFile<PersistedPanelState>(stateFilePath, {});
        const botProbe = await runExec(BOT_BIN, ["list", "--json"], 2_000);
        const reachable =
          botProbe.ok ||
          (
            await runExec("ssh", [
              "-o",
              "BatchMode=yes",
              "-o",
              "ConnectTimeout=2",
              "maxbook",
              "ssh -o BatchMode=yes -o ConnectTimeout=2 root@100.96.0.15 'docker inspect -f {{.State.Running}} openbot-openbot-1' 2>/dev/null",
            ])
          ).stdout.includes("true");

        const kwSet = new Set(keywords.map((k) => k.toLowerCase()));
        const ranked: Array<{ readonly score: number; readonly bot: FleetOpenBotDirector }> =
          DIRECTOR_ROSTER.map((seed) => {
            const score = seed.keywords.reduce((acc, kw) => acc + (kwSet.has(kw) ? 2 : 0), 0);
            return {
              score,
              bot: {
                id: seed.id,
                name: seed.name,
                role: seed.role,
                domain: seed.domain,
                lane: seed.lane,
                recommended: score > 0,
              },
            };
          });
        ranked.sort((a, b) => b.score - a.score);

        return {
          status: reachable ? "ok" : "degraded",
          ...(reachable ? {} : { note: "openbot proxy standby" }),
          frozen: Boolean(persistedState.frozen),
          reachable,
          bots: ranked.map((r) => r.bot),
        };
      };

      const readBrownePayload = async (
        projMeta: ReturnType<typeof collectProjectionText>,
        financeFrontierLocked: boolean,
      ): Promise<FleetBrownePayload> => {
        let autoShackleEnabled = true;
        let softWatermarkTokens = 48_000;
        let hardWatermarkTokens = 96_000;
        let shackleNumber = projMeta.shackleNumber;

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), METRICS_TIMEOUT_MS);
          const response = await fetch(BROWNE_METRICS_URL, { signal: controller.signal });
          clearTimeout(timer);
          if (response.ok) {
            const metrics = (await response.json()) as {
              readonly autoShacklesEnabled?: boolean;
              readonly watermarks?: { readonly soft?: number; readonly hard?: number };
              readonly summary?: { readonly shackleCount?: number };
            };
            if (typeof metrics.autoShacklesEnabled === "boolean") {
              autoShackleEnabled = metrics.autoShacklesEnabled;
            }
            if (typeof metrics.watermarks?.soft === "number") {
              softWatermarkTokens = metrics.watermarks.soft;
            }
            if (typeof metrics.watermarks?.hard === "number") {
              hardWatermarkTokens = metrics.watermarks.hard;
            }
            if (
              typeof metrics.summary?.shackleCount === "number" &&
              metrics.summary.shackleCount > 0
            ) {
              shackleNumber = metrics.summary.shackleCount;
            }
          }
        } catch {
          // Browne metrics sidecar is optional
        }

        const savingsPct = Math.min(82, Math.max(12, Math.round((shackleNumber - 1) * 18 + 24)));
        return {
          status: "ok",
          shackleNumber,
          itemCount: projMeta.itemCount,
          estimatedTokens: projMeta.estimatedTokens,
          softWatermarkTokens,
          hardWatermarkTokens,
          estimatedSavingsPct: savingsPct,
          autoShackleEnabled,
          financeFrontierLocked,
          providers: [
            { id: "claude", label: "Opus 5.5", state: "ok", detail: "Frontier CLI / harness" },
            { id: "codex", label: "GPT-6 Astra", state: "ok", detail: "Frontier review & books" },
            {
              id: "antigravity",
              label: "Antigravity Neon",
              state: "ok",
              detail: "gemini-pro-orchestrator-neon",
            },
            {
              id: "local",
              label: "Grok / Local",
              state: financeFrontierLocked ? "limited" : "ok",
              detail: financeFrontierLocked ? "Locked out of finance" : "General lane",
            },
          ],
          grounding: {
            toolReceipts: projMeta.toolReceipts,
            verifiedSources: projMeta.verifiedSources,
            verdict:
              projMeta.toolReceipts > 0 || projMeta.verifiedSources.length > 0
                ? "sound"
                : projMeta.itemCount === 0
                  ? "pending"
                  : "unverified",
          },
        };
      };

      const buildContextUncached = Effect.fn("FleetPanelService.getContext")(function* (
        input: FleetPanelContextInput,
      ) {
        const projection = yield* projections
          .getThreadProjection(ThreadId.make(input.threadId))
          .pipe(Effect.orElseSucceed(() => null));
        const projMeta = collectProjectionText(projection);

        const combinedText = [
          input.threadTitle ?? projMeta.threadTitle ?? "",
          input.projectName ?? "",
          input.query ?? "",
          projMeta.recentText,
        ]
          .filter((s) => s.length > 0)
          .join("\n");

        const keywords = extractThreadKeywords({
          threadTitle: input.threadTitle ?? projMeta.threadTitle,
          projectName: input.projectName,
          workspaceRoot: input.workspaceRoot,
          query: input.query,
          recentText: projMeta.recentText,
        });
        const financeRequired = detectFinanceFrontierRequired(combinedText);
        const queryUsed = input.query?.trim() || keywords.slice(0, 3).join(" ") || "mrtns";

        return yield* Effect.promise(async () => {
          const [fleet, nowResult, librarianData, openbots, trayState] = await Promise.all([
            readFleetPulse(keywords),
            readNowJson(),
            scanWikiCards(keywords, financeRequired),
            readOpenBotsPayload(keywords),
            readJsonFile<PersistedTrayState>(trayFilePath, {}),
          ]);

          const [plan, mail, browne] = await Promise.all([
            Promise.resolve(buildPlanPayload(nowResult, keywords, combinedText)),
            readMailPayload(queryUsed, nowResult),
            readBrownePayload(projMeta, financeRequired),
          ]);

          const librarian: FleetLibrarianPayload = {
            status: librarianData.cards.length > 0 ? "ok" : "degraded",
            matchedCards: librarianData.cards,
            activeRules: librarianData.rules,
            financeFrontierRequired: financeRequired,
          };

          const savedDecisions = trayState.decisions ?? {};
          const trayItems = extractTrayItemsFromText(combinedText, savedDecisions);
          const lockRecord = trayState.locks?.[input.threadId];
          const tray: FleetTrayPayload = {
            status: "ok",
            items: trayItems,
            settled: projMeta.threadSettled || Boolean(lockRecord),
            ...(lockRecord?.lockedAt ? { lockedAt: lockRecord.lockedAt } : {}),
          };

          return {
            generatedAt: new Date().toISOString(),
            keywords,
            fleet,
            plan,
            mail,
            librarian,
            openbots,
            browne,
            tray,
          } satisfies FleetPanelContextResult;
        });
      });

      const getContext: FleetPanelServiceShape["getContext"] = Effect.fn(
        "FleetPanelService.getContextCached",
      )(function* (input: FleetPanelContextInput) {
        const cacheKey = `${input.threadId}::${input.query ?? ""}`;
        const now = Date.now();
        if (!input.forceRefresh) {
          const cached = cache.get(cacheKey);
          if (cached && cached.expiresAt > now) {
            return cached.data;
          }
        }
        const data = yield* buildContextUncached(input);
        cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, data });
        return data;
      });

      const runAction: FleetPanelServiceShape["runAction"] = (input) =>
        Effect.promise(async (): Promise<FleetPanelActionResult> => {
          switch (input.kind) {
            case "commitLibrarian": {
              const res = await runExec(
                "ssh",
                [
                  "-o",
                  "BatchMode=yes",
                  "-o",
                  "ConnectTimeout=4",
                  "maxbook",
                  `python3 ~/system-architecture/services/wiki-librarian/remember.py --kind ${shellQuote(input.factKind)} --source browne-panel ${shellQuote(input.fact)}`,
                ],
                6_000,
              );
              return {
                ok: res.ok,
                message: res.ok
                  ? "Committed to Librarian queue (sole wiki writer)."
                  : `Librarian SSH failed: ${res.stderr.slice(0, 120)}`,
              };
            }

            case "fetchMailBody": {
              const res = await runExec("ssh", [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=3",
                "maxbook",
                `~/dev/40-bin/postroom-search --json --limit 3 ${shellQuote(input.query)}`,
              ]);
              if (!res.ok) {
                return {
                  ok: false,
                  message: "Postroom search failed over SSH.",
                };
              }
              try {
                const parsed = JSON.parse(res.stdout) as PostroomSearchResultShape;
                const picked =
                  parsed.shown?.find((m) => input.messageId && m.id === input.messageId) ??
                  parsed.shown?.[0];
                if (!picked) {
                  return { ok: false, message: "No matching Postroom email found." };
                }
                const from = picked.from?.[0]?.email ?? picked.from?.[0]?.name ?? "unknown";
                const injectText = [
                  `[Postroom mail context]`,
                  `Subject: ${picked.subject ?? "(no subject)"}`,
                  `From: ${from}`,
                  `Date: ${picked.receivedAt ?? ""}`,
                  `Preview: ${picked.preview ?? ""}`,
                ].join("\n");
                return {
                  ok: true,
                  message: "Mail context ready for prompt injection.",
                  injectText,
                };
              } catch {
                return { ok: false, message: "Invalid Postroom JSON output." };
              }
            }

            case "openGodwit": {
              const res = await runExec("ssh", [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=3",
                "maxbook",
                "open -a Godwit",
              ]);
              return {
                ok: res.ok,
                message: res.ok
                  ? "Opened Godwit on maxbook (drafts only; never auto-sends)."
                  : `Could not open Godwit: ${res.stderr.slice(0, 120)}`,
              };
            }

            case "logWaiting": {
              const parts = [
                "python3 /opt/life-planner/plan.py add",
                "--actor browne",
                `--title ${shellQuote(input.title)}`,
                "--kind waiting",
                "--source browne-panel",
              ];
              if (input.owner?.trim()) {
                parts.push(`--owner ${shellQuote(input.owner.trim())}`);
              }
              if (input.deadline?.trim()) {
                parts.push(`--deadline ${shellQuote(input.deadline.trim())}`);
              }
              const res = await runExec("ssh", [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=4",
                "journal",
                parts.join(" "),
              ]);
              cache.clear();
              return {
                ok: res.ok,
                message: res.ok
                  ? "Logged waiting item into journal/plan.db."
                  : `Failed to log waiting item: ${res.stderr.slice(0, 120)}`,
              };
            }

            case "handoffBot": {
              const state = await readJsonFile<PersistedPanelState>(stateFilePath, {});
              if (state.frozen) {
                return {
                  ok: false,
                  message: "Travel/Freeze is active: bot dispatch blocked.",
                };
              }
              const brief = scrubBriefSecrets(
                `Goal: ${input.goal}${input.constraints ? `\nConstraints: ${input.constraints}` : ""}`,
              );
              const direct = await runExec(
                BOT_BIN,
                ["ask", input.botName, brief, "--no-wait"],
                5_000,
              );
              if (direct.ok) {
                return {
                  ok: true,
                  message: `Dispatched secret-scrubbed brief to ${input.botName}.`,
                };
              }
              const proxy = await runExec(
                "ssh",
                [
                  "-o",
                  "BatchMode=yes",
                  "-o",
                  "ConnectTimeout=4",
                  "maxbook",
                  `ssh -o BatchMode=yes -o ConnectTimeout=3 root@100.96.0.15 ${shellQuote(`docker exec -i openbot-openbot-1 echo ${shellQuote(`[browne->${input.botName}] ${brief}`)}`)}`,
                ],
                6_000,
              );
              return {
                ok: proxy.ok,
                message: proxy.ok
                  ? `Reached OpenBot container via maxbook for ${input.botName}.`
                  : `Bot dispatch unavailable (${direct.stderr.slice(0, 90)}).`,
                copyText: brief,
              };
            }

            case "toggleBotFreeze": {
              const state = await readJsonFile<PersistedPanelState>(stateFilePath, {});
              await writeJsonFile(stateFilePath, { ...state, frozen: input.frozen });
              cache.clear();
              return {
                ok: true,
                message: input.frozen
                  ? "Travel/Freeze enabled: autonomous bot dispatches paused."
                  : "Travel/Freeze disabled: OpenBot dispatches resumed.",
              };
            }

            case "attachFleet": {
              if (input.target === "screen") {
                const res = await runExec("ssh", [
                  "-o",
                  "BatchMode=yes",
                  "-o",
                  "ConnectTimeout=3",
                  "maxbook",
                  "/Users/nico/dev/40-bin/so latest 2>/dev/null || ls -1t ~/screen-ring/*.jpg 2>/dev/null | head -n 1",
                ]);
                const remotePath = res.stdout.trim().split("\n").pop()?.trim() ?? "";
                return {
                  ok: res.ok && remotePath.length > 0,
                  message:
                    res.ok && remotePath
                      ? `Screen Observer frame located: ${remotePath}`
                      : "No Screen Observer frame returned.",
                  ...(remotePath
                    ? {
                        attachmentPath: remotePath,
                        injectText: `[Screen Observer (maxbook): ${remotePath}]`,
                      }
                    : {}),
                };
              }
              if (input.target === "meeting") {
                const picked =
                  input.path ?? (await listRecentFiles(MEETING_RECORDINGS_ROOT, 1))[0]?.path ?? "";
                return {
                  ok: picked.length > 0,
                  message: picked
                    ? `Attached recording reference ${NodePath.basename(picked)}.`
                    : "No meeting recording found.",
                  ...(picked
                    ? {
                        attachmentPath: picked,
                        injectText: `[Meeting recording: ${picked}]`,
                      }
                    : {}),
                };
              }
              const targetPath = input.path?.trim() ?? "";
              return {
                ok: targetPath.length > 0,
                message: targetPath
                  ? `Injected fleet storage path ${NodePath.basename(targetPath)}.`
                  : "No storage file path provided.",
                ...(targetPath
                  ? {
                      attachmentPath: targetPath,
                      injectText: `[Fleet file: ${targetPath}]`,
                    }
                  : {}),
              };
            }

            case "launchRealCli": {
              const cmdName = input.model === "opus" ? "opus" : "fable";
              const titleNote = input.threadTitle ? ` -- ${shellQuote(input.threadTitle)}` : "";
              const cdPrefix = input.cwd ? `cd ${shellQuote(input.cwd)} && ` : "";
              const cliCommand = `${cdPrefix}${cmdName}${titleNote}`;
              return {
                ok: true,
                message: `Prepared real ${cmdName} CLI command (no subagent cosplay).`,
                copyText: cliCommand,
                injectText: `Handoff to real frontier CLI (${cmdName}): \`${cliCommand}\``,
              };
            }

            case "decideTrayItem": {
              const tray = await readJsonFile<PersistedTrayState>(trayFilePath, {});
              const decisions = { ...tray.decisions, [input.itemId]: input.decision };
              await writeJsonFile(trayFilePath, { ...tray, decisions });
              cache.clear();
              return {
                ok: true,
                message: `Tray item ${input.itemId} marked ${input.decision}.`,
              };
            }

            case "lockDecisionAndSettle": {
              const tray = await readJsonFile<PersistedTrayState>(trayFilePath, {});
              const lockedAt = new Date().toISOString();
              const locks = {
                ...tray.locks,
                [input.threadId]: { lockedAt, summary: input.summary },
              };
              await writeJsonFile(trayFilePath, { ...tray, locks });
              const librarianRes = await runExec("ssh", [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=4",
                "maxbook",
                `python3 ~/system-architecture/services/wiki-librarian/remember.py --kind decision --source browne-panel ${shellQuote(input.summary)}`,
              ]);
              cache.clear();
              return {
                ok: true,
                message: librarianRes.ok
                  ? "Decision locked, committed to Librarian, ready to settle thread."
                  : "Decision locked locally (Librarian offline); ready to settle thread.",
              };
            }

            case "rollShackleHint": {
              return {
                ok: true,
                message: "Generated shackle rollover summary prompt.",
                injectText:
                  "Browne shackle rollover: summarize verified facts, open waiting items in plan.db, exact file paths, and next action in a clean handoff before continuing.",
              };
            }
          }
        });

      return FleetPanelService.of({
        getContext,
        runAction,
      });
    }),
  );
}
