import type { FleetPanelModuleStatus } from "@t3tools/contracts";
import { useGT } from "gt-react";
import type { ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { ThreadDetailsSection } from "../ThreadDetailsSection";

export function FleetStatusPill(props: {
  readonly status: FleetPanelModuleStatus | "limited" | "unknown";
  readonly label?: string;
}) {
  const gt = useGT();
  const text =
    props.label ??
    (props.status === "ok"
      ? gt("Live")
      : props.status === "degraded"
        ? gt("Degraded")
        : props.status === "limited"
          ? gt("Restricted")
          : props.status === "offline"
            ? gt("Offline")
            : gt("Unknown"));
  const toneClass =
    props.status === "ok"
      ? "bg-success/12 text-success-foreground"
      : props.status === "degraded" || props.status === "limited"
        ? "bg-warning-surface text-warning-foreground"
        : "bg-muted text-muted-foreground";

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-3xs font-medium leading-3",
        toneClass,
      )}
    >
      {text}
    </span>
  );
}

export function FleetModuleSection(props: {
  readonly headingId: string;
  readonly title: string;
  readonly status: FleetPanelModuleStatus;
  readonly note?: string | undefined;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <ThreadDetailsSection headingId={props.headingId} title={props.title} separated>
      <div className="flex flex-col gap-1.5 px-2 pb-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <FleetStatusPill status={props.status} />
            {props.note ? (
              <span className="truncate text-2xs text-muted-foreground">{props.note}</span>
            ) : null}
          </div>
          {props.actions ? (
            <div className="flex shrink-0 items-center gap-1">{props.actions}</div>
          ) : null}
        </div>
        {props.children}
      </div>
    </ThreadDetailsSection>
  );
}
