import type { FleetLibrarianPayload } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { BookOpenIcon, LockIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { ThreadDetailsControl } from "../ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../threadDetailsPanelStyles";
import { FleetModuleSection, FleetStatusPill } from "./FleetSectionChrome";

export function LibrarianSection(props: {
  readonly data: FleetLibrarianPayload;
  readonly busy: boolean;
  readonly onInjectText: (text: string) => void;
  readonly onCommitFact: (fact: string, factKind: "decision" | "event") => Promise<void>;
}) {
  const gt = useGT();
  const [composing, setComposing] = useState(false);
  const [fact, setFact] = useState("");
  const [factKind, setFactKind] = useState<"decision" | "event">("decision");

  const handleCommit = async () => {
    const clean = fact.trim();
    if (!clean) return;
    await props.onCommitFact(clean, factKind);
    setFact("");
    setComposing(false);
  };

  return (
    <FleetModuleSection
      headingId="thread-details-librarian-heading"
      title={gt("Librarian & wiki")}
      status={props.data.status}
      note={props.data.note}
      actions={
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          disabled={props.busy}
          onClick={() => setComposing((open) => !open)}
          aria-label={gt("Queue decision or event for Librarian remember.py")}
        >
          <PlusIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span>{gt("Commit")}</span>
        </ThreadDetailsControl>
      }
    >
      {props.data.financeFrontierRequired ? (
        <div className="flex items-center gap-1.5 rounded bg-warning-surface px-1.5 py-1 text-2xs font-medium text-warning-foreground">
          <LockIcon className="size-3 shrink-0" aria-hidden />
          <span>{gt("Rule lock: finance & accounting require Opus 5.5, Astra, or Neon")}</span>
        </div>
      ) : null}

      {composing ? (
        <div className="flex flex-col gap-1 rounded border border-border/70 p-1.5">
          <div className="flex items-center gap-1">
            <select
              value={factKind}
              onChange={(e) => setFactKind(e.target.value === "event" ? "event" : "decision")}
              className="h-7 rounded border border-input bg-background px-1.5 text-xs"
            >
              <option value="decision">{gt("Decision")}</option>
              <option value="event">{gt("Event")}</option>
            </select>
            <input
              type="text"
              value={fact}
              onChange={(e) => setFact(e.target.value)}
              placeholder={gt("Verified fact for Librarian...")}
              className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 text-xs"
            />
            <button
              type="button"
              disabled={props.busy || fact.trim().length === 0}
              onClick={() => void handleCommit()}
              className="h-7 rounded bg-primary px-2 text-2xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {gt("Send")}
            </button>
          </div>
        </div>
      ) : null}

      {props.data.matchedCards.slice(0, 4).map((card) => (
        <ThreadDetailsControl
          key={card.path}
          size="xs"
          variant="ghost"
          part="row"
          onClick={() =>
            props.onInjectText(
              `[Wiki card: ${card.slug} (${card.freshness}) - ${card.path}]${card.nextAction ? `\nNext: ${card.nextAction}` : ""}`,
            )
          }
        >
          <BookOpenIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-2xs">{card.title}</span>
          <FleetStatusPill
            status={
              card.freshness === "verified"
                ? "ok"
                : card.freshness === "stale"
                  ? "degraded"
                  : "unknown"
            }
            label={
              card.freshness === "verified"
                ? gt("Verified")
                : card.freshness === "stale"
                  ? gt("Stale")
                  : gt("Unknown")
            }
          />
        </ThreadDetailsControl>
      ))}

      {props.data.activeRules.slice(0, 2).map((rule) => (
        <div key={rule.path} className="truncate text-3xs text-muted-foreground">
          {rule.name}
        </div>
      ))}
    </FleetModuleSection>
  );
}
