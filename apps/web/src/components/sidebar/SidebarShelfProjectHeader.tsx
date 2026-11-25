import type { ContextMenuSource } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
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
  onToggle: (shelf: SidebarShelfKey, group: SidebarProjectSnapshot) => void;
  onContextMenu: (
    group: SidebarProjectSnapshot,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const { shelf, group, collapsed, totalCount } = props;
  const rowId = sidebarShelfFolderRowId(shelf, group.projectKey);

  return (
    <li data-testid={`sidebar-${shelf}-project-folder`} className="mt-1 list-none first:mt-0">
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
          );
        }}
        className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
    </li>
  );
});
