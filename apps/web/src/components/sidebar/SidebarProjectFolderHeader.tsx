import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ContextMenuSource, EnvironmentId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { useDroppable } from "@dnd-kit/core";
import { ChevronDownIcon, SquarePenIcon } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import type { SnoozePreset } from "../Sidebar.snooze";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SnoozePopover } from "./SnoozePopover";
import { computeSidebarGroupRollup, sidebarFolderDropId } from "./sidebarGrouping.logic";

const FOLDER_DOT_LABEL = {
  attention: msg(", needs you", { $context: "project folder status, read after its name" }),
  failed: msg(", failed", { $context: "project folder status, read after its name" }),
  unread: msg(", done", { $context: "project folder status, read after its name" }),
  working: msg(", working", { $context: "project folder status, read after its name" }),
} as const;

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarFolderRowId(projectKey: string) {
  return `folder:${projectKey}`;
}

/**
 * A collapsible project group header in the sidebar. Shows total count,
 * compact status rollup pills while collapsed (so urgent items never hide),
 * an optional Organize trigger for "No project", and accepts thread drops to
 * move threads straight into this project.
 */
export const SidebarProjectFolderHeader = memo(function SidebarProjectFolderHeader(props: {
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  totalCount: number;
  hiddenThreads: readonly EnvironmentThreadShell[];
  snoozeNow: string;
  timestampFormat: TimestampFormat;
  snoozeEnvironmentId?: EnvironmentId | undefined;
  canSnooze?: boolean | undefined;
  canAcceptThreadDrop?: boolean | undefined;
  onOrganize?: (() => void) | undefined;
  onToggle: (group: SidebarProjectSnapshot) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onSnooze?:
    | ((group: SidebarProjectSnapshot, preset: Pick<SnoozePreset, "snoozedUntil">) => void)
    | undefined;
  onContextMenu: (
    group: SidebarProjectSnapshot,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { group, collapsed, totalCount, hiddenThreads, snoozeNow } = props;
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const rowId = sidebarFolderRowId(group.projectKey);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const { setNodeRef: setDropNodeRef, isOver } = useDroppable({
    id: sidebarFolderDropId(group.projectKey),
    disabled: !props.canAcceptThreadDrop,
  });
  const dot = collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  const rollup =
    collapsed && hiddenThreads.length > 0
      ? computeSidebarGroupRollup(hiddenThreads, snoozeNow, localLastVisitedAtById)
      : null;
  const urgentRollupCount = rollup ? rollup.attention + rollup.failed : 0;
  const hasRollupPills =
    rollup !== null && (urgentRollupCount > 0 || rollup.working > 0 || rollup.done > 0);
  const showOrganize = Boolean(group.isScratch && !collapsed && totalCount > 0 && props.onOrganize);
  const showSnooze = Boolean(props.canSnooze && props.snoozeEnvironmentId && props.onSnooze);
  const excludeProjectKeys = new Set(
    group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
  );
  const snoozeTrigger = showSnooze ? (
    <SnoozePopover
      open={snoozeOpen}
      onOpenChange={setSnoozeOpen}
      onSnooze={(preset) => props.onSnooze?.(group, preset)}
      timestampFormat={props.timestampFormat}
      environmentId={props.snoozeEnvironmentId!}
      defaultTab="interval"
      excludeProjectKeys={excludeProjectKeys}
      triggerVariant="folder-header"
      actionForRowId={rowId}
      testId="sidebar-project-folder-snooze"
      ariaLabel={gt("Snooze {project}", { project: group.displayName })}
      tooltipLabel={gt("Snooze {project}", { project: group.displayName })}
    />
  ) : null;

  return (
    <li
      ref={setDropNodeRef}
      data-testid="sidebar-project-folder"
      data-project-drop-over={isOver ? "true" : undefined}
      className="group/project-folder relative mt-2 list-none first:mt-0"
    >
      <button
        type="button"
        data-sidebar-row={rowId}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(group)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(
            group,
            { x: event.clientX, y: event.clientY },
            contextMenuSourceOf(event),
          );
        }}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          !showOrganize &&
            !isOver &&
            (showSnooze
              ? "group-hover/project-folder:pe-14 group-has-[[data-sidebar-action-for]:focus]/project-folder:pe-14"
              : "group-hover/project-folder:pe-8 group-has-[[data-sidebar-action-for]:focus]/project-folder:pe-8"),
          !showOrganize && !isOver && snoozeOpen && "pe-14",
          isOver && "bg-sidebar-row-hover ring-2 ring-inset ring-ring",
        )}
      >
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
        <ProjectFavicon project={group} className="size-4 shrink-0" />
        <span className="min-w-0 truncate text-sm font-medium text-sidebar-foreground/90">
          {group.displayName}
        </span>
        {totalCount > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
            {totalCount}
          </span>
        ) : null}
        <span className="flex-1" />
        {isOver ? (
          <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-3xs font-medium text-primary">
            <T>Move here</T>
          </span>
        ) : (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 group-hover/project-folder:invisible group-has-[[data-sidebar-action-for]:focus]/project-folder:invisible pointer-coarse:invisible",
              snoozeOpen && "invisible",
            )}
          >
            {hasRollupPills ? (
              <>
                {rollup.failed > 0 ? (
                  <span
                    data-testid="sidebar-folder-rollup-failed"
                    className="inline-flex items-center gap-0.5 rounded-full bg-destructive/15 px-1.5 py-px text-3xs font-semibold tabular-nums text-destructive-foreground"
                  >
                    {rollup.failed} !
                  </span>
                ) : null}
                {rollup.attention > 0 ? (
                  <span
                    data-testid="sidebar-folder-rollup-attention"
                    className="inline-flex items-center gap-0.5 rounded-full bg-warning/15 px-1.5 py-px text-3xs font-semibold tabular-nums text-warning-foreground"
                  >
                    {rollup.attention} !
                  </span>
                ) : null}
                {rollup.working > 0 ? (
                  <span
                    data-testid="sidebar-folder-rollup-working"
                    className="inline-flex items-center gap-0.5 rounded-full bg-info/15 px-1.5 py-px text-3xs font-semibold tabular-nums text-info-foreground"
                  >
                    {rollup.working}
                  </span>
                ) : null}
                {rollup.done > 0 ? (
                  <span
                    data-testid="sidebar-folder-rollup-done"
                    className="inline-flex items-center gap-0.5 rounded-full bg-success/15 px-1.5 py-px text-3xs font-semibold tabular-nums text-success-foreground"
                  >
                    {rollup.done} ✓
                  </span>
                ) : null}
              </>
            ) : null}
            {dot ? <span className="sr-only">{m(FOLDER_DOT_LABEL[dot])}</span> : null}
          </span>
        )}
      </button>
      {showOrganize && !isOver ? (
        <span className="absolute inset-y-0 right-1.5 flex items-center gap-1">
          <Button
            data-testid="sidebar-organize-no-project"
            data-sidebar-action-for={rowId}
            size="xs"
            variant="outline"
            onClick={(event) => {
              event.stopPropagation();
              props.onOrganize?.();
            }}
          >
            <T>Organize</T>
          </Button>
          <span
            className={cn(
              "flex items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100",
              snoozeOpen && "opacity-100",
            )}
          >
            {snoozeTrigger}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    data-sidebar-action-for={rowId}
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={gt("New thread in {project}", { project: group.displayName })}
                    onClick={() => props.onNewThread(group)}
                  />
                }
              >
                <SquarePenIcon aria-hidden />
              </TooltipTrigger>
              <TooltipPopup>
                <T>
                  New thread in <Var>{group.displayName}</Var>
                </T>
              </TooltipPopup>
            </Tooltip>
          </span>
        </span>
      ) : !isOver ? (
        <span
          className={cn(
            "absolute inset-y-0 right-1.5 flex items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100",
            snoozeOpen && "opacity-100",
          )}
        >
          {snoozeTrigger}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  data-sidebar-action-for={rowId}
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={gt("New thread in {project}", { project: group.displayName })}
                  onClick={() => props.onNewThread(group)}
                />
              }
            >
              <SquarePenIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>
              <T>
                New thread in <Var>{group.displayName}</Var>
              </T>
            </TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
    </li>
  );
});
