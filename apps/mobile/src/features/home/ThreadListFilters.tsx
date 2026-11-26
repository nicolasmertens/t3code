import type { SidebarTriageFilter } from "@t3tools/client-runtime/state/sidebar-grouping";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { Pressable, ScrollView, View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Chip } from "../../components/ui/Chip";
import {
  findAppBarMenuItem,
  menuActionsFromAppBarItems,
} from "../../components/ui/menuActionItems";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import {
  queueGroupingModeIcon,
  queueGroupingModeLabel,
} from "../threads/thread-list-v2-grouping-items";
import {
  buildQueueGroupingAppBarMenuItems,
  type HomeListFilterMenuEnvironment,
  type HomeListFilterMenuProject,
  type HomeListGroupingMenuOptions,
} from "./home-list-filter-menu";

export function ThreadListFilters(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly grouping?: HomeListGroupingMenuOptions;
  /** List padding the scroller bleeds through so pills start where row content does. */
  readonly gutter: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const selectedEnvironment = props.environments.find(
    (environment) => environment.environmentId === props.selectedEnvironmentId,
  );
  const selectedProject = props.projects.find(
    (project) => project.key === props.selectedProjectKey,
  );
  const groupingMenuItems = props.grouping
    ? buildQueueGroupingAppBarMenuItems(props.grouping, m)
    : null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginHorizontal: -props.gutter, overflow: "visible" }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 2, paddingBottom: 10, gap: 8 }}
    >
      <ListFilterMenu
        label={selectedEnvironment?.label ?? gt("All environments")}
        accessibilityLabel={gt("Filter threads by environment")}
        active={selectedEnvironment !== undefined}
        actions={[
          {
            id: "all",
            title: gt("All environments"),
            state: props.selectedEnvironmentId === null ? "on" : "off",
          },
          ...props.environments.map((environment) => ({
            id: JSON.stringify(environment.environmentId),
            title: environment.label,
            state:
              environment.environmentId === props.selectedEnvironmentId
                ? ("on" as const)
                : ("off" as const),
          })),
        ]}
        onSelect={(id) => {
          if (id === "all") props.onEnvironmentChange(null);
          else {
            const environment = props.environments.find(
              (candidate) => JSON.stringify(candidate.environmentId) === id,
            );
            if (environment) props.onEnvironmentChange(environment.environmentId);
          }
        }}
      />
      <ListFilterMenu
        label={selectedProject?.label ?? gt("All projects")}
        accessibilityLabel={gt("Filter threads by project")}
        active={selectedProject !== undefined}
        actions={[
          {
            id: "all",
            title: gt("All projects"),
            state: props.selectedProjectKey === null ? "on" : "off",
          },
          ...props.projects.map((project) => ({
            id: JSON.stringify(project.key),
            title: project.label,
            state: project.key === props.selectedProjectKey ? ("on" as const) : ("off" as const),
          })),
        ]}
        onSelect={(id) => {
          if (id === "all") props.onProjectChange(null);
          else {
            const project = props.projects.find(
              (candidate) => JSON.stringify(candidate.key) === id,
            );
            if (project) props.onProjectChange(project.key);
          }
        }}
      />
      {props.grouping && groupingMenuItems ? (
        <ListFilterMenu
          label={queueGroupingModeLabel(props.grouping.groupMode, m)}
          accessibilityLabel={gt("Group threads and display options")}
          leadingIcon={queueGroupingModeIcon(props.grouping.groupMode)}
          active={props.grouping.groupMode !== "project"}
          actions={menuActionsFromAppBarItems(groupingMenuItems)}
          onSelect={(id) => {
            findAppBarMenuItem(groupingMenuItems, id)?.onPress();
          }}
        />
      ) : null}
      {props.selectedEnvironmentId !== null || props.selectedProjectKey !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Reset thread filters")}
          className="h-8 w-8 items-center justify-center"
          onPress={() => {
            props.onEnvironmentChange(null);
            props.onProjectChange(null);
          }}
        >
          <SymbolView name="xmark.circle.fill" size={18} tintColorClassName="accent-icon-muted" />
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

export function ThreadListTriageBar(props: {
  readonly visible: boolean;
  readonly counts: {
    readonly all: number;
    readonly attention: number;
    readonly done: number;
    readonly noProject: number;
  };
  readonly selected: SidebarTriageFilter;
  readonly onSelect: (filter: SidebarTriageFilter) => void;
  readonly gutter?: number;
  readonly compact?: boolean;
}) {
  const gt = useGT();
  const showAttention = props.counts.attention > 0 || props.selected === "attention";
  const showDone = props.counts.done > 0 || props.selected === "done";
  const showNoProject = props.counts.noProject > 0 || props.selected === "no-project";
  const visibleBucketCount = (showAttention ? 1 : 0) + (showDone ? 1 : 0) + (showNoProject ? 1 : 0);

  if (!props.visible || (visibleBucketCount < 2 && props.selected === "all")) {
    return null;
  }

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={props.gutter ? { marginHorizontal: -props.gutter } : undefined}
        contentContainerStyle={{
          paddingHorizontal: props.compact ? 8 : 20,
          paddingTop: 2,
          paddingBottom: 6,
          gap: 6,
        }}
      >
        <Chip
          size="small"
          selected={props.selected === "all"}
          label={gt("All ({count})", { count: props.counts.all })}
          onPress={() => props.onSelect("all")}
        />
        {showAttention ? (
          <Chip
            size="small"
            selected={props.selected === "attention"}
            label={gt("Attention ({count})", { count: props.counts.attention })}
            onPress={() => props.onSelect("attention")}
          />
        ) : null}
        {showDone ? (
          <Chip
            size="small"
            selected={props.selected === "done"}
            label={gt("Done ({count})", { count: props.counts.done })}
            onPress={() => props.onSelect("done")}
          />
        ) : null}
        {showNoProject ? (
          <Chip
            size="small"
            selected={props.selected === "no-project"}
            label={gt("No project ({count})", { count: props.counts.noProject })}
            onPress={() => props.onSelect("no-project")}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}
