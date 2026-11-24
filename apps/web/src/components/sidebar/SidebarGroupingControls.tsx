import { msg, T, useGT, useMessages } from "gt-react";
import {
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FolderKanbanIcon,
  LayersIcon,
  ListIcon,
  Minimize2Icon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import type { SidebarQueueGroupMode } from "../../uiStateStore";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import type { SidebarTriageFilter } from "./sidebarGrouping.logic";

const GROUP_MODE_LABELS: Record<SidebarQueueGroupMode, string> = {
  project: msg("By project", { $context: "sidebar queue grouping mode" }),
  status: msg("By status", { $context: "sidebar queue grouping mode" }),
  flat: msg("Flat", { $context: "sidebar queue grouping mode" }),
};

export function SidebarGroupModeMenu(props: {
  mode: SidebarQueueGroupMode;
  urgencyOrder: boolean;
  autoCollapseDone: boolean;
  multilineRows: boolean;
  onModeChange: (mode: SidebarQueueGroupMode) => void;
  onUrgencyOrderChange: (enabled: boolean) => void;
  onAutoCollapseDoneChange: (enabled: boolean) => void;
  onMultilineRowsChange: (enabled: boolean) => void;
  onExpandAll: () => void;
  onCollapseDone: () => void;
  onCollapseAll: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const isGrouped = props.mode !== "flat";
  const ModeIcon =
    props.mode === "project" ? FolderKanbanIcon : props.mode === "status" ? LayersIcon : ListIcon;

  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            data-testid="sidebar-group-mode-trigger"
            data-active={isGrouped ? "true" : undefined}
            label={gt("Group queue: {mode}", { mode: m(GROUP_MODE_LABELS[props.mode]) })}
            tooltip={
              <span className="flex flex-col gap-0.5">
                <span>{gt("Group queue: {mode}", { mode: m(GROUP_MODE_LABELS[props.mode]) })}</span>
                <span className="text-muted-foreground">
                  {gt("Press {shortcut} to toggle", { shortcut: "g p" })}
                </span>
              </span>
            }
          />
        }
      >
        <ModeIcon className={cn("size-4", isGrouped && "text-sidebar-foreground")} />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <MenuGroupLabel>
            <T>Group queue</T>
          </MenuGroupLabel>
          <MenuRadioGroup
            value={props.mode}
            onValueChange={(value) => {
              if (value === "project" || value === "status" || value === "flat") {
                props.onModeChange(value);
              }
            }}
          >
            <MenuRadioItem value="project">
              <span className="flex items-center gap-2 pe-2">
                <FolderKanbanIcon className="size-3.5 text-muted-foreground" aria-hidden />
                <span>{m(GROUP_MODE_LABELS.project)}</span>
                <MenuShortcut>g p</MenuShortcut>
              </span>
              <MenuRadioItemIndicator />
            </MenuRadioItem>
            <MenuRadioItem value="status">
              <span className="flex items-center gap-2 pe-2">
                <LayersIcon className="size-3.5 text-muted-foreground" aria-hidden />
                <span>{m(GROUP_MODE_LABELS.status)}</span>
              </span>
              <MenuRadioItemIndicator />
            </MenuRadioItem>
            <MenuRadioItem value="flat">
              <span className="flex items-center gap-2 pe-2">
                <ListIcon className="size-3.5 text-muted-foreground" aria-hidden />
                <span>{m(GROUP_MODE_LABELS.flat)}</span>
              </span>
              <MenuRadioItemIndicator />
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        {isGrouped ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuItem onClick={props.onExpandAll}>
                <ChevronsUpDownIcon aria-hidden />
                <span>
                  <T>Expand all groups</T>
                </span>
              </MenuItem>
              <MenuItem onClick={props.onCollapseDone}>
                <Minimize2Icon aria-hidden />
                <span>
                  <T>Collapse Done groups</T>
                </span>
              </MenuItem>
              <MenuItem onClick={props.onCollapseAll}>
                <ChevronsDownUpIcon aria-hidden />
                <span>
                  <T>Collapse all groups</T>
                </span>
              </MenuItem>
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              {props.mode === "project" ? (
                <MenuCheckboxItem
                  variant="switch"
                  checked={props.urgencyOrder}
                  onCheckedChange={(checked) => props.onUrgencyOrderChange(Boolean(checked))}
                >
                  <T>Urgency order</T>
                </MenuCheckboxItem>
              ) : null}
              <MenuCheckboxItem
                variant="switch"
                checked={props.autoCollapseDone}
                onCheckedChange={(checked) => props.onAutoCollapseDoneChange(Boolean(checked))}
              >
                <T>Auto-collapse Done</T>
              </MenuCheckboxItem>
              {props.mode === "project" ? (
                <MenuCheckboxItem
                  variant="switch"
                  checked={props.multilineRows}
                  onCheckedChange={(checked) => props.onMultilineRowsChange(Boolean(checked))}
                >
                  <T>Two-line rows</T>
                </MenuCheckboxItem>
              ) : null}
            </MenuGroup>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function SidebarTriageFilterBar(props: {
  filter: SidebarTriageFilter;
  counts: {
    readonly all: number;
    readonly attention: number;
    readonly done: number;
    readonly noProject: number;
  };
  onFilterChange: (filter: SidebarTriageFilter) => void;
}) {
  const gt = useGT();
  const chips: Array<{
    readonly id: SidebarTriageFilter;
    readonly label: string;
    readonly count: number;
    readonly tone?: "warning" | "success";
  }> = [
    {
      id: "all",
      label: gt("All", { $context: "sidebar triage filter chip" }),
      count: props.counts.all,
    },
    ...(props.counts.attention > 0 || props.filter === "attention"
      ? [
          {
            id: "attention" as const,
            label: gt("Attention", { $context: "sidebar triage filter chip" }),
            count: props.counts.attention,
            tone: "warning" as const,
          },
        ]
      : []),
    ...(props.counts.done > 0 || props.filter === "done"
      ? [
          {
            id: "done" as const,
            label: gt("Done", { $context: "sidebar triage filter chip" }),
            count: props.counts.done,
            tone: "success" as const,
          },
        ]
      : []),
    ...(props.counts.noProject > 0 || props.filter === "no-project"
      ? [
          {
            id: "no-project" as const,
            label: gt("No project", { $context: "sidebar triage filter chip" }),
            count: props.counts.noProject,
          },
        ]
      : []),
  ];

  // If only "All" would show (no attention, done, or no-project items), keep the header quiet.
  if (chips.length <= 1) return null;

  return (
    <div
      data-testid="sidebar-triage-filters"
      role="group"
      aria-label={gt("Filter queue")}
      className="mt-1.5 flex flex-wrap items-center gap-1"
    >
      {chips.map((chip) => {
        const active = props.filter === chip.id;
        return (
          <button
            key={chip.id}
            type="button"
            data-testid={`sidebar-triage-chip-${chip.id}`}
            aria-pressed={active}
            onClick={() => props.onFilterChange(active && chip.id !== "all" ? "all" : chip.id)}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              active
                ? "border-sidebar-foreground bg-sidebar-foreground text-sidebar"
                : "border-sidebar-border/80 bg-transparent text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            )}
          >
            {!active && chip.tone === "warning" ? (
              <span className="size-1.5 rounded-full bg-warning" aria-hidden />
            ) : !active && chip.tone === "success" ? (
              <span className="size-1.5 rounded-full bg-success" aria-hidden />
            ) : null}
            <span>{chip.label}</span>
            <span className={cn("text-3xs tabular-nums", active ? "opacity-80" : "opacity-70")}>
              {chip.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
