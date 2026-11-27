import type { ContextMenuSource, EnvironmentId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { AlarmClockOffIcon, ChevronDownIcon } from "lucide-react";
import { T, useGT, Var } from "gt-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SnoozePreset } from "../Sidebar.snooze";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SnoozePopover } from "./SnoozePopover";
import { sidebarShelfFolderRowId, type SidebarShelfKey } from "./sidebarGrouping.logic";

/**
 * Compact collapsible project folder header used inside the Working, Snoozed,
 * and Settled shelves when the sidebar is grouped by project.
 */
export const SidebarShelfProjectHeader = memo(function SidebarShelfProjectHeader(props: {
  shelf: SidebarShelfKey;
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  totalCount: number;
  timestampFormat?: TimestampFormat | undefined;
  canWake?: boolean | undefined;
  onWake?: ((group: SidebarProjectSnapshot) => void) | undefined;
  canSnooze?: boolean | undefined;
  snoozeEnvironmentId?: EnvironmentId | undefined;
  onSnooze?:
    | ((group: SidebarProjectSnapshot, preset: Pick<SnoozePreset, "snoozedUntil">) => void)
    | undefined;
  onToggle: (shelf: SidebarShelfKey, group: SidebarProjectSnapshot) => void;
  onContextMenu: (
    group: SidebarProjectSnapshot,
    position: { x: number; y: number },
    source: ContextMenuSource,
    shelf?: SidebarShelfKey,
  ) => void;
}) {
  const gt = useGT();
  const { shelf, group, collapsed, totalCount } = props;
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const rowId = sidebarShelfFolderRowId(shelf, group.projectKey);
  const showWake = Boolean(shelf === "snoozed" && props.canWake && props.onWake);
  const showSnooze = Boolean(
    shelf === "working" && props.canSnooze && props.snoozeEnvironmentId && props.onSnooze,
  );
  const hasAction = showWake || showSnooze;
  const excludeProjectKeys = new Set(
    group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
  );

  return (
    <li
      data-testid={`sidebar-${shelf}-project-folder`}
      className="group/shelf-folder relative mt-1 list-none first:mt-0"
    >
      <button
        type="button"
        data-sidebar-row={rowId}
        data-sidebar-parent={`shelf:${shelf}`}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(shelf, group)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(
            group,
            { x: event.clientX, y: event.clientY },
            contextMenuSourceOf(event),
            shelf,
          );
        }}
        className={cn(
          "flex h-7 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          hasAction &&
            "group-hover/shelf-folder:pe-8 group-has-[[data-sidebar-action-for]:focus]/shelf-folder:pe-8",
          snoozeOpen && "pe-8",
        )}
      >
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
        <ProjectFavicon project={group} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate text-xs font-medium text-sidebar-foreground/80">
          {group.displayName}
        </span>
        <span className="shrink-0 text-2xs tabular-nums text-sidebar-muted-foreground">
          {totalCount}
        </span>
      </button>
      {showWake ? (
        <span className="absolute inset-y-0 right-1.5 flex items-center opacity-0 focus-within:opacity-100 group-hover/shelf-folder:opacity-100 pointer-coarse:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  data-sidebar-action-for={rowId}
                  data-testid="sidebar-shelf-folder-wake"
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={gt("Wake {project}", { project: group.displayName })}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onWake?.(group);
                  }}
                />
              }
            >
              <AlarmClockOffIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>
              <T>
                Wake <Var>{group.displayName}</Var>
              </T>
            </TooltipPopup>
          </Tooltip>
        </span>
      ) : showSnooze ? (
        <span
          className={cn(
            "absolute inset-y-0 right-1.5 flex items-center opacity-0 focus-within:opacity-100 group-hover/shelf-folder:opacity-100 pointer-coarse:opacity-100",
            snoozeOpen && "opacity-100",
          )}
        >
          <SnoozePopover
            open={snoozeOpen}
            onOpenChange={setSnoozeOpen}
            onSnooze={(preset) => props.onSnooze?.(group, preset)}
            timestampFormat={props.timestampFormat ?? "locale"}
            environmentId={props.snoozeEnvironmentId!}
            defaultTab="interval"
            excludeProjectKeys={excludeProjectKeys}
            triggerVariant="folder-header"
            actionForRowId={rowId}
            testId="sidebar-shelf-folder-snooze"
            ariaLabel={gt("Snooze {project}", { project: group.displayName })}
            tooltipLabel={gt("Snooze {project}", { project: group.displayName })}
          />
        </span>
      ) : null}
    </li>
  );
});
