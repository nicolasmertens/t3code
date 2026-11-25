import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as FleetPanelService from "./FleetPanelService.ts";

describe("FleetPanelService helpers", () => {
  it("extracts deduplicated non-stopword keywords prioritized by input order", () => {
    const keywords = FleetPanelService.extractThreadKeywords({
      threadTitle: "Fluvius invoice GS21 reconciliation with the team",
      projectName: "mrtns-books",
      workspaceRoot: "/home/nico/dev/mrtns",
      query: "Postroom VAT",
    });

    assert.deepStrictEqual(keywords.slice(0, 6), [
      "postroom",
      "vat",
      "fluvius",
      "invoice",
      "gs21",
      "reconciliation",
    ]);
  });

  it("detects finance frontier-only scope across Dutch and English terms", () => {
    assert.strictEqual(
      FleetPanelService.detectFinanceFrontierRequired("Odoo btw aangifte Q3"),
      true,
    );
    assert.strictEqual(
      FleetPanelService.detectFinanceFrontierRequired("Check Peppol invoice"),
      true,
    );
    assert.strictEqual(
      FleetPanelService.detectFinanceFrontierRequired("Fix ThreadDetailsPanel padding"),
      false,
    );
  });

  it("flags drift into parked ventures while leaving active focuses clear", () => {
    const drift = FleetPanelService.detectParkedVentureDrift("Let's add a Siteroutes widget");
    assert.strictEqual(Boolean(drift?.includes("Siteroutes")), true);
    assert.strictEqual(
      FleetPanelService.detectParkedVentureDrift("MRTNS GS21 Browne thread panel"),
      undefined,
    );
  });

  it("computes ET time-boundary guards for training days (16:20) and pickup days (17:20)", () => {
    // 2026-11-25 is Wednesday (training day), 20:55 UTC == 15:55 EST (within 45m of 16:20 ET)
    const wedNearStop = FleetPanelService.computeEtTimeBoundary(new Date("2026-11-25T20:55:00Z"));
    assert.strictEqual(wedNearStop.isTrainingDay, true);
    assert.strictEqual(wedNearStop.isStopSoon, true);
    assert.strictEqual(wedNearStop.label.includes("16:20"), true);

    // 2026-11-26 is Thursday (pickup day), 15:00 UTC == 10:00 EST (not stop soon)
    const thuMorning = FleetPanelService.computeEtTimeBoundary(new Date("2026-11-26T15:00:00Z"));
    assert.strictEqual(thuMorning.isTrainingDay, false);
    assert.strictEqual(thuMorning.isStopSoon, false);
    assert.strictEqual(thuMorning.label.includes("17:20"), true);
  });

  it("parses wiki frontmatter and classifies freshness", () => {
    const nowMs = Date.parse("2026-11-25T12:00:00Z");
    const freshCard = FleetPanelService.parseWikiCard(
      "/home/nico/wiki/domains/mrtns.md",
      "---\nslug: mrtns\nlast_updated: 2026-11-10\n---\n# MRTNS Engine\n## Next\n- Verify Fluvius\n",
      nowMs,
      nowMs,
    );
    assert.strictEqual(freshCard.slug, "mrtns");
    assert.strictEqual(freshCard.title, "MRTNS Engine");
    assert.strictEqual(freshCard.freshness, "verified");
    assert.strictEqual(freshCard.nextAction, "Verify Fluvius");

    const staleCard = FleetPanelService.parseWikiCard(
      "/home/nico/wiki/domains/old.md",
      "---\nslug: old\nlast_updated: 2026-05-01\n---\n# Old Card\n",
      Date.parse("2026-05-01T12:00:00Z"),
      nowMs,
    );
    assert.strictEqual(staleCard.freshness, "stale");
  });

  it("scrubs secrets before handing briefs to OpenBots", () => {
    const dirty =
      "Check repo with sk-secret1234567890 and Bearer abcdefghijklmnop password=mysecretpw";
    const clean = FleetPanelService.scrubBriefSecrets(dirty);
    assert.strictEqual(clean.includes("sk-secret1234567890"), false);
    assert.strictEqual(clean.includes("abcdefghijklmnop"), false);
    assert.strictEqual(clean.includes("mysecretpw"), false);
  });

  it("extracts SignuDoc HAND atoms and approval cards with persisted decisions", () => {
    const text = [
      "HAND-9918 ready",
      "Approval: Pay Fluvius invoice €420",
      "Outbound: Graag bevestiging van ontvangst.",
    ].join("\n");
    const items = FleetPanelService.extractTrayItemsFromText(text, {
      "hand-hand-9918": "approved",
    });
    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0]?.kind, "hand_atom");
    assert.strictEqual(items[0]?.decision, "approved");
    assert.strictEqual(items[1]?.kind, "approval");
    assert.strictEqual(items[2]?.kind, "outbound");
  });

  it("parses hosts from fleet manifest YAML", () => {
    const yaml = [
      "meta:",
      "  schema_version: 1",
      "hosts:",
      "  agents:",
      '    role: "agent_exec"',
      '    notes: "Primary Linux execution"',
      "  maxbook:",
      '    role: "workstation_edge"',
    ].join("\n");
    const hosts = FleetPanelService.parseFleetManifestHosts(yaml);
    assert.deepStrictEqual(hosts, [
      { alias: "agents", role: "agent_exec", ok: true, detail: "Primary Linux execution" },
      { alias: "maxbook", role: "workstation_edge", ok: true },
    ]);
  });
});

it.effect("persists freeze state and tray decisions via FleetPanelService", () =>
  Effect.gen(function* () {
    const tmpDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "browne-fleet-panel-test-")),
    );
    const mockProjectionLayer = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
      getThreadProjection: () =>
        Effect.succeed({
          thread: { title: "Fluvius invoice check", settledAt: null, settledOverride: null },
          messages: [{ text: "HAND-777 ready\nApproval: Approve Fluvius payment" }],
          turnItems: [{ type: "tool_call" }],
          contextHandoffs: [{}],
        }),
    } as never);
    const serviceLayer = FleetPanelService.FleetPanelService.layer.pipe(
      Layer.provide(mockProjectionLayer),
      Layer.provide(ServerConfig.layerTest(tmpDir, tmpDir)),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const service = yield* FleetPanelService.FleetPanelService;
      const freezeRes = yield* service.runAction({ kind: "toggleBotFreeze", frozen: true });
      assert.strictEqual(freezeRes.ok, true);

      const blockedHandoff = yield* service.runAction({
        kind: "handoffBot",
        threadId: "t-1",
        botId: "sysadmin",
        botName: "SysAdmin",
        goal: "Check disk",
      });
      assert.strictEqual(blockedHandoff.ok, false);

      const trayRes = yield* service.runAction({
        kind: "decideTrayItem",
        threadId: "t-1",
        itemId: "approval-1",
        decision: "approved",
      });
      assert.strictEqual(trayRes.ok, true);

      const cliRes = yield* service.runAction({
        kind: "launchRealCli",
        model: "opus",
        threadTitle: "Odoo Audit",
        cwd: "/tmp/work",
      });
      assert.strictEqual(cliRes.ok, true);
      assert.strictEqual(cliRes.copyText?.includes("opus"), true);
    }).pipe(Effect.provide(serviceLayer));

    yield* Effect.promise(() => NodeFSP.rm(tmpDir, { recursive: true, force: true }));
  }),
);
