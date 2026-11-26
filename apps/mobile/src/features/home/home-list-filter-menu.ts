import type { EnvironmentId, SidebarQueueGroupMode } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { msg } from "gt-react-native";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { m, type MessageResolver } from "../../i18n/messages";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function homeListFilterEnvironments(environments: ReadonlyArray<WorkspaceEnvironment>) {
  return Arr.sort(
    environments
      .filter((environment) => environment.isEnabled)
      .map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.environmentLabel,
        connectionState: environment.connectionState,
      })),
    Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
  );
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

export interface HomeListGroupingMenuOptions {
  readonly groupMode: SidebarQueueGroupMode;
  readonly urgencyOrder: boolean;
  readonly autoCollapseDone: boolean;
  readonly multilineRows: boolean;
  readonly workingShelfEnabled: boolean;
  readonly hasDoneOnlyGroups?: boolean;
  readonly onGroupModeChange: (mode: SidebarQueueGroupMode) => void;
  readonly onUrgencyOrderChange: (enabled: boolean) => void;
  readonly onAutoCollapseDoneChange: (enabled: boolean) => void;
  readonly onMultilineRowsChange: (enabled: boolean) => void;
  readonly onWorkingShelfEnabledChange: (enabled: boolean) => void;
  readonly onExpandAllGroups?: () => void;
  readonly onCollapseDoneGroups?: () => void;
  readonly onCollapseAllGroups?: () => void;
}

export function buildQueueGroupingAppBarMenuItems(
  options: HomeListGroupingMenuOptions,
  resolve: MessageResolver = m,
): AppBarMenuItem[] {
  const modeItems: AppBarMenuItem[] = [
    {
      id: "group-mode:project",
      title: resolve(msg("By project")),
      icon: "square.grid.2x2",
      selected: options.groupMode === "project",
      onPress: () => options.onGroupModeChange("project"),
    },
    {
      id: "group-mode:status",
      title: resolve(msg("By status")),
      icon: "bolt.circle",
      selected: options.groupMode === "status",
      onPress: () => options.onGroupModeChange("status"),
    },
    {
      id: "group-mode:flat",
      title: resolve(msg("Flat")),
      icon: "line.3.horizontal",
      selected: options.groupMode === "flat",
      onPress: () => options.onGroupModeChange("flat"),
    },
  ];

  const batchItems: AppBarMenuItem[] =
    options.groupMode !== "flat"
      ? [
          ...(options.onExpandAllGroups
            ? [
                {
                  id: "group-action:expand-all",
                  title: resolve(msg("Expand all groups")),
                  icon: "chevron.down",
                  onPress: options.onExpandAllGroups,
                } satisfies AppBarMenuItem,
              ]
            : []),
          ...(options.hasDoneOnlyGroups && options.onCollapseDoneGroups
            ? [
                {
                  id: "group-action:collapse-done",
                  title: resolve(msg("Collapse Done groups")),
                  icon: "checkmark.circle",
                  onPress: options.onCollapseDoneGroups,
                } satisfies AppBarMenuItem,
              ]
            : []),
          ...(options.onCollapseAllGroups
            ? [
                {
                  id: "group-action:collapse-all",
                  title: resolve(msg("Collapse all groups")),
                  icon: "chevron.right",
                  onPress: options.onCollapseAllGroups,
                } satisfies AppBarMenuItem,
              ]
            : []),
        ]
      : [];

  const optionItems: AppBarMenuItem[] = [
    ...(options.groupMode === "project"
      ? [
          {
            id: "group-option:urgency-order",
            title: resolve(msg("Urgency order")),
            selected: options.urgencyOrder,
            onPress: () => options.onUrgencyOrderChange(!options.urgencyOrder),
          } satisfies AppBarMenuItem,
        ]
      : []),
    ...(options.groupMode !== "flat"
      ? [
          {
            id: "group-option:auto-collapse-done",
            title: resolve(msg("Auto-collapse Done")),
            selected: options.autoCollapseDone,
            onPress: () => options.onAutoCollapseDoneChange(!options.autoCollapseDone),
          } satisfies AppBarMenuItem,
        ]
      : []),
    {
      id: "group-option:multiline-rows",
      title: resolve(msg("Two-line rows")),
      selected: options.multilineRows,
      onPress: () => options.onMultilineRowsChange(!options.multilineRows),
    },
    {
      id: "group-option:working-shelf",
      title: resolve(msg("Working section")),
      selected: options.workingShelfEnabled,
      onPress: () => options.onWorkingShelfEnabledChange(!options.workingShelfEnabled),
    },
  ];

  const items: AppBarMenuItem[] = [...modeItems];
  if (batchItems.length > 0) {
    items.push({ id: "group-actions", inline: true, items: batchItems });
  }
  items.push({ id: "group-options", inline: true, items: optionItems });
  return items;
}

export function buildHomeListFilterMenuItems(
  props: {
    readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
    readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
    readonly selectedEnvironmentId: EnvironmentId | null;
    readonly selectedProjectKey: string | null;
    readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
    readonly onProjectChange: (projectKey: string | null) => void;
    readonly grouping?: HomeListGroupingMenuOptions;
  },
  resolve: MessageResolver = m,
): AppBarMenuItem[] {
  const items: AppBarMenuItem[] = [
    {
      id: "environment",
      title: resolve(msg("Environment", { $context: "filter menu heading" })),
      items: [
        {
          id: "environment:all",
          title: resolve(msg("All environments")),
          subtitle: resolve(msg("Show threads from every environment")),
          selected: props.selectedEnvironmentId === null,
          onPress: () => props.onEnvironmentChange(null),
        },
        ...props.environments.map((environment) => ({
          id: `environment:${environment.environmentId}`,
          title: environment.label,
          selected: props.selectedEnvironmentId === environment.environmentId,
          onPress: () => props.onEnvironmentChange(environment.environmentId),
        })),
      ],
    },
  ];

  if (props.projects.length > 0) {
    items.push({
      id: "project",
      title: resolve(msg("Project", { $context: "filter menu heading" })),
      items: [
        {
          id: "project:all",
          title: resolve(msg("All projects")),
          subtitle: resolve(msg("Show threads from every project")),
          selected: props.selectedProjectKey === null,
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          id: `project:${project.key}`,
          title: project.label,
          selected: props.selectedProjectKey === project.key,
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  if (props.grouping) {
    items.push({
      id: "grouping",
      title: resolve(msg("Group threads")),
      icon: "square.grid.2x2",
      items: buildQueueGroupingAppBarMenuItems(props.grouping, resolve),
    });
  }

  return items;
}
