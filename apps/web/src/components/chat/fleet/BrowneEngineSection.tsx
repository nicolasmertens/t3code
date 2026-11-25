import type { FleetBrownePayload } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CpuIcon, LockIcon, RotateCcwIcon, TerminalIcon } from "lucide-react";

import { ThreadDetailsControl } from "../ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../threadDetailsPanelStyles";
import { FleetModuleSection, FleetStatusPill } from "./FleetSectionChrome";

export function BrowneEngineSection(props: {
  readonly data: FleetBrownePayload;
  readonly busy: boolean;
  readonly onLaunchCli: (model: "opus" | "fable") => void;
  readonly onRollShackle: () => void;
}) {
  const gt = useGT();

  return (
    <FleetModuleSection
      headingId="thread-details-browne-engine-heading"
      title={gt("Browne engine")}
      status={props.data.status}
      note={props.data.note}
      actions={
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          disabled={props.busy}
          onClick={props.onRollShackle}
          aria-label={gt("Prepare shackle rollover handoff prompt")}
        >
          <RotateCcwIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span>{gt("Rollover")}</span>
        </ThreadDetailsControl>
      }
    >
      <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <CpuIcon className="size-3 shrink-0" aria-hidden />
          {gt("Shackle #{num} · {items} items · ~{tokens} tok", {
            num: props.data.shackleNumber,
            items: props.data.itemCount,
            tokens: props.data.estimatedTokens,
          })}
        </span>
        <span className="font-mono text-3xs">
          {gt("-{pct}% ctx", { pct: props.data.estimatedSavingsPct })}
        </span>
      </div>

      {props.data.financeFrontierLocked ? (
        <div className="flex items-center gap-1.5 rounded bg-warning-surface px-1.5 py-1 text-2xs font-medium text-warning-foreground">
          <LockIcon className="size-3 shrink-0" aria-hidden />
          <span>{gt("Finance frontier-only lock active")}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1">
        {props.data.providers.map((provider) => (
          <span
            key={provider.id}
            className="inline-flex items-center gap-1 rounded border border-border/70 px-1.5 py-0.5 text-3xs"
          >
            <span>{provider.label}</span>
            <FleetStatusPill status={provider.state} />
          </span>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          disabled={props.busy}
          onClick={() => props.onLaunchCli("opus")}
        >
          <TerminalIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span>{gt("Ask Opus CLI")}</span>
        </ThreadDetailsControl>
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          disabled={props.busy}
          onClick={() => props.onLaunchCli("fable")}
        >
          <TerminalIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span>{gt("Ask Fable CLI")}</span>
        </ThreadDetailsControl>
        <span className="ml-auto text-3xs text-muted-foreground">
          {gt("Receipts: {count}", { count: props.data.grounding.toolReceipts })}
        </span>
      </div>
    </FleetModuleSection>
  );
}
