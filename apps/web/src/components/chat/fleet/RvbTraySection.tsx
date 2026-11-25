import type { FleetTrayPayload } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CheckIcon, CopyIcon, LockIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { ThreadDetailsControl } from "../ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../threadDetailsPanelStyles";
import { FleetModuleSection, FleetStatusPill } from "./FleetSectionChrome";

export function RvbTraySection(props: {
  readonly data: FleetTrayPayload;
  readonly busy: boolean;
  readonly defaultSummary: string;
  readonly onDecideItem: (itemId: string, decision: "pending" | "approved" | "rejected") => void;
  readonly onCopyText: (text: string) => void;
  readonly onLockAndSettle: (summary: string) => Promise<void>;
}) {
  const gt = useGT();
  const [summary, setSummary] = useState(props.defaultSummary);

  return (
    <FleetModuleSection
      headingId="thread-details-rvb-tray-heading"
      title={gt("RvB action tray")}
      status={props.data.status}
      note={
        props.data.settled
          ? gt("Settled & locked")
          : props.data.items.length > 0
            ? gt("{count} pending", {
                count: props.data.items.filter((i) => i.decision === "pending").length,
              })
            : props.data.note
      }
      actions={
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          disabled={props.busy}
          onClick={() => void props.onLockAndSettle(summary.trim() || props.defaultSummary)}
          aria-label={gt("Record decision lock, commit to Librarian, and settle thread")}
        >
          <LockIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span>{gt("Lock & settle")}</span>
        </ThreadDetailsControl>
      }
    >
      {props.data.items.map((item) => (
        <div
          key={item.id}
          className="flex flex-col gap-1 rounded border border-border/70 bg-muted/20 p-1.5"
        >
          <div className="flex items-center justify-between gap-1.5">
            <span className="min-w-0 flex-1 truncate text-2xs font-medium">{item.title}</span>
            <FleetStatusPill
              status={
                item.decision === "approved"
                  ? "ok"
                  : item.decision === "rejected"
                    ? "offline"
                    : "degraded"
              }
              label={
                item.decision === "approved"
                  ? gt("Approved")
                  : item.decision === "rejected"
                    ? gt("Rejected")
                    : gt("Pending")
              }
            />
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={props.busy}
              onClick={() => props.onDecideItem(item.id, "approved")}
              className="inline-flex items-center gap-0.5 rounded bg-success/15 px-1.5 py-0.5 text-3xs font-medium text-success-foreground"
            >
              <CheckIcon className="size-3" aria-hidden />
              <span>{gt("Approve")}</span>
            </button>
            <button
              type="button"
              disabled={props.busy}
              onClick={() => props.onDecideItem(item.id, "rejected")}
              className="inline-flex items-center gap-0.5 rounded bg-destructive/15 px-1.5 py-0.5 text-3xs font-medium text-destructive"
            >
              <XIcon className="size-3" aria-hidden />
              <span>{gt("Reject")}</span>
            </button>
            {item.copyText ? (
              <button
                type="button"
                onClick={() => props.onCopyText(item.copyText ?? item.detail)}
                className="ml-auto inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-3xs text-muted-foreground hover:bg-muted"
              >
                <CopyIcon className="size-3" aria-hidden />
                <span>{gt("Copy")}</span>
              </button>
            ) : null}
          </div>
        </div>
      ))}

      <input
        type="text"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder={gt("Decision summary for Lock & settle...")}
        className="h-7 rounded border border-input bg-background px-2 text-xs"
      />
    </FleetModuleSection>
  );
}
