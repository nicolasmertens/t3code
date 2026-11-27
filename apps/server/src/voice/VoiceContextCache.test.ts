// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  buildVoiceBriefing,
  capBriefingBytes,
  fetchActiveFleetDigest,
  fetchMailDigest,
  fetchPlanDigest,
  fetchWikiDigest,
} from "./VoiceContextCache.ts";

describe("VoiceContextCache", () => {
  it("caps briefing payloads strictly under byte limit", () => {
    const huge = "x".repeat(40_000);
    const capped = capBriefingBytes(huge, 26_000);
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(26_000);
    expect(capped).toContain("[Briefing truncated");
  });

  it("surfaces offline sources explicitly and puts scoped main session before Fleet sections", () => {
    const briefing = buildVoiceBriefing({
      external: {
        builtAt: "2026-11-26T15:00:00.000Z",
        planSummary: "Focus: Ship Browne voice",
        planStatus: { status: "ok", fetchedAt: "Thu, Nov 26, 2026, 10:00" },
        mailSummary: "Postroom mail unavailable (maxbook offline or asleep).",
        mailStatus: { status: "offline", fetchedAt: "Thu, Nov 26, 2026, 10:00" },
        fleetDigest: "Active Fleet context unavailable.",
        fleetStatus: { status: "offline", fetchedAt: "Thu, Nov 26, 2026, 10:00" },
        wikiSummary: "### topics/voice.md\nUse Phonic STS.",
        wikiStatus: { status: "ok", fetchedAt: "Thu, Nov 26, 2026, 10:00" },
      },
      live: {
        projects: ["Browne"],
        attentionThreads: [],
        activeThreads: [],
        scopedThread: {
          id: "thread-main",
          title: "Voice SOTA Main Session",
          projectTitle: "Browne",
          status: "running",
          branch: "feat/browne",
          pendingRequests: [],
          recentActivity: ["cmd (exit 0): vp test run"],
          recentMessages: [{ role: "user", text: "Fix echo and add Mac sidechat" }],
        },
      },
    });

    expect(briefing.degradedSources).toEqual(["maxbook"]);
    expect(briefing.text).toContain("Degraded offline sources: maxbook");
    expect(briefing.text).toContain("Focus: Ship Browne voice");
    expect(briefing.text.indexOf("## ACTIVE MAIN SESSION")).toBeLessThan(
      briefing.text.indexOf("## Live Browne State"),
    );
    expect(briefing.text).toContain("Voice SOTA Main Session");
  });

  it("distinguishes partial maxbook degradation between postroom and fleet-context", () => {
    const briefing = buildVoiceBriefing({
      external: {
        builtAt: "2026-11-26T15:00:00.000Z",
        planSummary: "Focus: Ship Browne voice",
        planStatus: { status: "ok", fetchedAt: "Thu, Nov 26, 2026, 10:00" },
        mailSummary: "- [2026-11-26] Victor: Invoice",
        mailStatus: { status: "ok", fetchedAt: "Thu, Nov 26, 2026, 10:00" },
        fleetDigest: "Active Fleet context unavailable.",
        fleetStatus: { status: "offline", fetchedAt: "Thu, Nov 26, 2026, 10:00" },
        wikiSummary: "### topics/voice.md\nUse Phonic STS.",
        wikiStatus: { status: "ok", fetchedAt: "Thu, Nov 26, 2026, 10:00" },
      },
      live: {
        projects: ["Browne"],
        attentionThreads: [],
        activeThreads: [],
      },
    });

    expect(briefing.degradedSources).toEqual(["fleet-context"]);
  });

  it("parses plan now.json and reports journal offline when SSH fails", async () => {
    const okPlan = await fetchPlanDigest(async () => ({
      ok: true,
      stdout: JSON.stringify({
        primary_focus: "Talk to Fleet",
        tasks: [{ title: "Wire Quick Action", deadline: "2026-11-26", status: "open" }],
        waiting: [{ title: "Confirm testflight" }],
      }),
      stderr: "",
    }));
    expect(okPlan.status.status).toBe("ok");
    expect(okPlan.summary).toContain("Focus: Talk to Fleet");
    expect(okPlan.summary).toContain("Wire Quick Action");

    const offlinePlan = await fetchPlanDigest(async () => ({
      ok: false,
      stdout: "",
      stderr: "ssh: connect to host journal timed out",
    }));
    expect(offlinePlan.status.status).toBe("offline");
  });

  it("queries Postroom with --since instead of empty positional query and parses mail output", async () => {
    let capturedCommand = "";
    const okMail = await fetchMailDigest(
      async (_cmd, args) => {
        capturedCommand = args[args.length - 1] ?? "";
        return {
          ok: true,
          stdout: JSON.stringify({
            shown: [
              {
                subject: "Invoice Q4",
                receivedAt: "2026-11-26T14:20:00Z",
                preview: "Please review attached invoice",
                from: [{ name: "Victor", email: "victor@mrtns.io" }],
              },
            ],
          }),
          stderr: "",
        };
      },
      DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-27T15:00:00Z")),
    );
    expect(capturedCommand).toContain("--since 2026-11-20");
    expect(capturedCommand).not.toContain("''");
    expect(okMail.status.status).toBe("ok");
    expect(okMail.summary).toContain("Victor: Invoice Q4");

    const offlineMail = await fetchMailDigest(async () => ({
      ok: false,
      stdout: "",
      stderr: "Operation timed out",
    }));
    expect(offlineMail.status.status).toBe("offline");
  });

  it("parses active Fleet context digest from maxbook snapshot", async () => {
    const okFleet = await fetchActiveFleetDigest(async () => ({
      ok: true,
      stdout: JSON.stringify({
        builtAt: "2026-11-27T14:36:53-05:00",
        lines: ["- [whatsapp 2026-11-27 14:18] John Collin: Meeting update"],
      }),
      stderr: "",
    }));
    expect(okFleet.status.status).toBe("ok");
    expect(okFleet.summary).toContain("John Collin");
  });

  it("reads recent markdown highlights from local wiki dir", async () => {
    const tmpDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "browne-wiki-test-"));
    try {
      await NodeFSP.mkdir(NodePath.join(tmpDir, "domains"), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(tmpDir, "domains", "voice.md"),
        "# Voice 2.0\n\nPhonic handles Dutch and English.\n",
      );
      const wiki = await fetchWikiDigest(tmpDir);
      expect(wiki.status.status).toBe("ok");
      expect(wiki.summary).toContain("domains/voice.md");
      expect(wiki.summary).toContain("Phonic handles Dutch and English.");
    } finally {
      await NodeFSP.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
