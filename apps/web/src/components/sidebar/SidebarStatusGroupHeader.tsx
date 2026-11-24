import {
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotDashedIcon,
} from "lucide-react";
import { msg, useMessages } from "gt-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import type { SidebarStatusBucketKey } from "./sidebarGrouping.logic";

const STATUS_BUCKET_META: Record<
  SidebarStatusBucketKey,
  {
    readonly label: string;
    readonly badgeClassName: string;
    readonly pillClassName: string;
  }
> = {
  attention: {
    label: msg("Needs Attention", { $context: "sidebar status group header" }),
    badgeClassName: "bg-warning/15 text-warning-foreground",
    pillClassName: "bg-warning/15 text-warning-foreground",
  },
  active: {
    label: msg("Active", { $context: "sidebar status group header" }),
    badgeClassName: "bg-sidebar-row-hover text-sidebar-muted-foreground",
    pillClassName: "bg-sidebar-row-hover text-sidebar-muted-foreground",
  },
  done: {
    label: msg("Done", { $context: "sidebar status group header" }),
    badgeClassName: "bg-success/15 text-success-foreground",
    pillClassName: "bg-success/15 text-success-foreground",
  },
};

export function sidebarStatusGroupRowId(bucketKey: SidebarStatusBucketKey) {
  return `status:${bucketKey}`;
}

export const SidebarStatusGroupHeader = memo(function SidebarStatusGroupHeader(props: {
  bucketKey: SidebarStatusBucketKey;
  collapsed: boolean;
  totalCount: number;
  hiddenCount: number;
  onToggle: (bucketKey: SidebarStatusBucketKey) => void;
}) {
  const m = useMessages();
  const { bucketKey, collapsed, totalCount, hiddenCount } = props;
  const meta = STATUS_BUCKET_META[bucketKey];
  const rowId = sidebarStatusGroupRowId(bucketKey);
  const Icon =
    bucketKey === "attention"
      ? CircleAlertIcon
      : bucketKey === "done"
        ? CircleCheckIcon
        : CircleDotDashedIcon;

  return (
    <li
      data-testid={`sidebar-status-group-${bucketKey}`}
      className="relative mt-2 list-none first:mt-0"
    >
      <button
        type="button"
        data-sidebar-row={rowId}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(bucketKey)}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
        <span
          aria-hidden
          className={cn(
            "inline-flex size-4 shrink-0 items-center justify-center rounded-sm",
            meta.badgeClassName,
          )}
        >
          <Icon className="size-3" />
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-sidebar-foreground/90">
          {m(meta.label)}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
          {totalCount}
        </span>
        <span className="flex-1" />
        {collapsed && hiddenCount > 0 ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-3xs font-semibold tabular-nums",
              meta.pillClassName,
            )}
          >
            {bucketKey === "attention"
              ? `${hiddenCount} !`
              : bucketKey === "done"
                ? `${hiddenCount} ✓`
                : hiddenCount}
          </span>
        ) : null}
      </button>
    </li>
  );
});
