import type { FleetPlanPayload } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { AlertTriangleIcon, CalendarClockIcon, PlusIcon, TargetIcon } from "lucide-react";
import { useState } from "react";

import { ThreadDetailsControl } from "../ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../threadDetailsPanelStyles";
import { FleetModuleSection } from "./FleetSectionChrome";

export function PlanAnchorSection(props: {
  readonly data: FleetPlanPayload;
  readonly busy: boolean;
  readonly onInjectText: (text: string) => void;
  readonly onLogWaiting: (input: {
    readonly title: string;
    readonly owner?: string;
  }) => Promise<void>;
}) {
  const gt = useGT();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState("");

  const submitWaiting = async () => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    await props.onLogWaiting({
      title: cleanTitle,
      ...(owner.trim() ? { owner: owner.trim() } : {}),
    });
    setTitle("");
    setOwner("");
    setAdding(false);
  };

  return (
    <FleetModuleSection
      headingId="thread-details-plan-anchor-heading"
      title={gt("Plan anchor")}
      status={props.data.status}
      note={props.data.note}
      actions={
        <>
          <ThreadDetailsControl
            size="xs"
            variant="ghost"
            part="meta"
            disabled={props.busy}
            onClick={() =>
              props.onInjectText(
                "Fleet, pursue this: check plan.db, owner/route/account, and bring it to verified closure with minimal hops.",
              )
            }
            aria-label={gt("Insert Fleet pursue-this instruction into composer")}
          >
            <TargetIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <span>{gt("Pursue")}</span>
          </ThreadDetailsControl>
          <ThreadDetailsControl
            size="xs"
            variant="ghost"
            part="meta"
            disabled={props.busy}
            onClick={() => setAdding((open) => !open)}
          >
            <PlusIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <span>{gt("Waiting")}</span>
          </ThreadDetailsControl>
        </>
      }
    >
      <div
        className={
          props.data.timeBoundary.isStopSoon
            ? "flex items-center gap-1.5 rounded bg-warning-surface px-1.5 py-1 text-2xs font-medium text-warning-foreground"
            : "flex items-center gap-1.5 rounded bg-muted/40 px-1.5 py-1 text-2xs text-muted-foreground"
        }
      >
        <CalendarClockIcon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">
          {props.data.timeBoundary.etTime} · {props.data.timeBoundary.label}
        </span>
      </div>

      {props.data.driftWarning ? (
        <div className="flex items-start gap-1.5 rounded bg-warning-surface px-1.5 py-1 text-2xs text-warning-foreground">
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{props.data.driftWarning}</span>
        </div>
      ) : null}

      {adding ? (
        <div className="flex flex-col gap-1 rounded border border-border/70 p-1.5">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={gt("Waiting-on item title")}
            className="h-7 rounded border border-input bg-background px-2 text-xs"
          />
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder={gt("Owner (optional)")}
              className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 text-xs"
            />
            <button
              type="button"
              disabled={props.busy || title.trim().length === 0}
              onClick={() => void submitWaiting()}
              className="h-7 rounded bg-primary px-2 text-2xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {gt("Save")}
            </button>
          </div>
        </div>
      ) : null}

      {props.data.matchedTasks.slice(0, 3).map((task) => (
        <ThreadDetailsControl
          key={task.id}
          size="xs"
          variant="ghost"
          part="row"
          onClick={() => props.onInjectText(`[plan.db ${task.id}] ${task.title}`)}
        >
          <span className="shrink-0 font-mono text-3xs text-muted-foreground">{task.id}</span>
          <span className="min-w-0 flex-1 truncate text-2xs">{task.title}</span>
        </ThreadDetailsControl>
      ))}

      {props.data.waitingItems.length > 0 ? (
        <div className="text-3xs text-muted-foreground">
          {gt("Waiting-on items: {count}", { count: props.data.waitingItems.length })}
        </div>
      ) : null}
    </FleetModuleSection>
  );
}
