import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { ContextMenuSource, ScopedThreadRef } from "@t3tools/contracts";
import { PinIcon, PinOffIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { memo, type MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTime } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { classifySidebarThreadTriage } from "./sidebarGrouping.logic";

function CompactRelativeTime(props: { timestamp: string | null }) {
  const nowMinute = useNowMinute();
  const m = useMessages();
  if (props.timestamp === null) return null;
  const parts = formatRelativeTime(props.timestamp, Date.parse(`${nowMinute}:00.000Z`), m);
  if (parts === null) return null;
  return (
    <span>
      {parts.suffix === null ? m(msg("now", { $context: "relative time" })) : parts.value}
    </span>
  );
}

export const SidebarPinnedStrip = memo(function SidebarPinnedStrip(props: {
  threads: readonly EnvironmentThreadShell[];
  routeRowThreadKey: string | null;
  snoozeNow: string;
  onThreadClick: (event: ReactMouseEvent<HTMLElement>, threadRef: ScopedThreadRef) => void;
  onContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
  onUnpin: (threadRef: ScopedThreadRef) => void;
  canUnpin: (thread: EnvironmentThreadShell) => boolean;
}) {
  const gt = useGT();
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  if (props.threads.length === 0) return null;

  return (
    <li
      data-testid="sidebar-pinned-strip"
      className="mb-1.5 list-none rounded-lg border border-sidebar-border/70 bg-sidebar-row-hover/40 px-1.5 py-1"
    >
      <div className="mb-0.5 flex items-center gap-1 px-1 text-3xs font-semibold tracking-wider text-sidebar-muted-foreground uppercase">
        <PinIcon aria-hidden className="size-2.5" />
        <span>
          <T context="sidebar section">Pinned</T>
        </span>
      </div>
      <ul role="presentation" className="flex flex-col gap-0.5">
        {props.threads.map((thread) => {
          const ref = scopeThreadRef(thread.environmentId, thread.id);
          const threadKey = scopedThreadKey(ref);
          const isActive = props.routeRowThreadKey === threadKey;
          const triage = classifySidebarThreadTriage(
            thread,
            props.snoozeNow,
            localLastVisitedAtById[threadKey],
          );
          const statusBadge = triage.isFailed
            ? { label: gt("Failed"), className: "text-destructive-foreground" }
            : triage.isWoke
              ? {
                  label: gt("Woke", { $context: "thread status: woke from snooze" }),
                  className: "text-warning-foreground",
                }
              : triage.status === "limited"
                ? { label: gt("Limited"), className: "text-warning-foreground" }
                : triage.isAttention
                  ? { label: gt("Needs you"), className: "text-warning-foreground" }
                  : triage.isWorking
                    ? { label: gt("Working"), className: "text-info-foreground" }
                    : triage.isDone
                      ? { label: gt("Done"), className: "text-success-foreground" }
                      : null;

          return (
            <li
              key={threadKey}
              data-thread-item={threadKey}
              className="group/pinned-item list-none"
            >
              <div
                role="button"
                tabIndex={0}
                data-sidebar-row={threadKey}
                data-testid="sidebar-pinned-strip-row"
                aria-current={isActive ? "page" : undefined}
                onClick={(event) => props.onThreadClick(event, ref)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    props.onThreadClick(event as unknown as ReactMouseEvent<HTMLElement>, ref);
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  props.onContextMenu(
                    ref,
                    { x: event.clientX, y: event.clientY },
                    contextMenuSourceOf(event),
                  );
                }}
                className={cn(
                  "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs outline-none transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  isActive && "bg-sidebar-row-active text-sidebar-foreground font-medium",
                )}
              >
                <span
                  className="min-w-0 flex-1 truncate text-sidebar-foreground"
                  dir={textDirection(thread.title)}
                >
                  {thread.title}
                </span>
                <span className="relative flex shrink-0 items-center justify-end">
                  <span
                    className={cn(
                      "text-2xs font-medium tabular-nums text-sidebar-muted-foreground transition-opacity",
                      props.canUnpin(thread) && "group-hover/pinned-item:opacity-0",
                      statusBadge?.className,
                    )}
                  >
                    {statusBadge ? (
                      statusBadge.label
                    ) : (
                      <CompactRelativeTime timestamp={resolveThreadActivityTimestamp(thread)} />
                    )}
                  </span>
                  {props.canUnpin(thread) ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label={gt("Unpin thread")}
                            onClick={(event) => {
                              event.stopPropagation();
                              props.onUnpin(ref);
                            }}
                            className="pointer-events-none absolute right-0 inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-sidebar-muted-foreground opacity-0 transition-opacity hover:text-sidebar-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/pinned-item:pointer-events-auto group-hover/pinned-item:opacity-100"
                          />
                        }
                      >
                        <PinOffIcon aria-hidden className="size-3" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">
                        <T>Unpin thread</T>
                      </TooltipPopup>
                    </Tooltip>
                  ) : null}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </li>
  );
});
