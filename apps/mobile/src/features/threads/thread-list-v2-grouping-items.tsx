import * as Dialog from "../../components/ui/Dialog";
import { RowPressable } from "../../components/ui/RowPressable";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  partitionSnoozeableFolderThreads,
  type SidebarStatusBucketKey,
} from "@t3tools/client-runtime/state/sidebar-grouping";
import { AuthOrchestrationOperateScope, ProjectId, type EnvironmentId } from "@t3tools/contracts";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import { msg, useGT, useMessages } from "gt-react-native";
import { memo, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { Menu } from "../../components/ui/Menu";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useNowAfter } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { threadCanArchive } from "../home/threadArchive";
import { QueuedMessageIcon } from "./queued-message-icon";
import { moveThreadToProject, useMoveThreadProjectTargets } from "./moveThreadToProject";
import { canTurnThreadIntoProject, turnThreadIntoProject } from "./turnThreadIntoProject";
import { selectedThreadRowColors } from "./thread-list-v2-row-appearance";
import {
  resolveThreadListV2RowStatus,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozePresets,
  threadHasUnseenCompletion,
  type ThreadListV2ProjectFolderListItem,
  type ThreadListV2ShelfProjectFolderListItem,
  type ThreadListV2StatusGroupListItem,
  type ThreadListV2ThreadListItem,
  type ThreadListV2TriageEmptyListItem,
} from "./threadListV2";
import { useCanShareWithGuest } from "./useCanShareWithGuest";

interface PinnedBadge {
  readonly label: string;
  readonly className: string;
}

function resolvePinnedRowBadge(
  thread: EnvironmentThreadShell,
  wokeAt: string | null,
  resolve: ReturnType<typeof useMessages>,
): PinnedBadge | null {
  const status = resolveThreadListV2RowStatus(thread);
  if (status === "failed") {
    return {
      label: resolve(msg("Failed", { $context: "thread status" })),
      className: "text-danger-foreground",
    };
  }
  if (wokeAt !== null) {
    return {
      label: resolve(msg("Woke", { $context: "thread came back from snooze" })),
      className: "text-warning-foreground",
    };
  }
  if (status === "limited") {
    return {
      label: resolve(msg("Limited", { $context: "thread status, usage limit reached" })),
      className: "text-warning-foreground",
    };
  }
  if (status === "approval" || status === "input" || status === "request") {
    return {
      label: resolve(msg("Needs you", { $context: "compact pinned thread status" })),
      className: "text-warning-foreground",
    };
  }
  if (status === "working" || status === "waiting") {
    return {
      label: resolve(msg("Working", { $context: "thread status" })),
      className: "text-adaptive-sky-600-400",
    };
  }
  if (status === "ready" && threadHasUnseenCompletion(thread)) {
    return {
      label: resolve(msg("Done", { $context: "thread status, turn finished" })),
      className: "text-adaptive-emerald-700-300",
    };
  }
  return null;
}

const PinnedStripRow = memo(function PinnedStripRow(props: {
  readonly entry: ThreadListV2ThreadListItem;
  readonly project: EnvironmentProject | null;
  readonly selected: boolean;
  readonly pane: "screen" | "sidebar";
  readonly showTopDivider: boolean;
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozePresets: ReadonlyArray<SnoozePresetSetting> | undefined;
  readonly pinningSupported: boolean;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => void;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { entry } = props;
  const { thread, wokeAt } = entry.item;
  const gt = useGT();
  const m = useMessages();
  const sidebarPane = props.pane === "sidebar";
  const foregroundClassName = sidebarPane ? "text-drawer-foreground" : "text-foreground";
  const tertiaryForegroundClassName = sidebarPane
    ? "text-drawer-foreground-muted"
    : "text-foreground-tertiary";
  const mutedIconTintClassName = sidebarPane
    ? "accent-drawer-foreground-muted"
    : "accent-foreground-muted";
  const interactionClassName = sidebarPane ? "bg-thread-hover" : "bg-row-hover";
  const interactionOpacity = props.selected ? 0 : 1;
  const navigation = useNavigation();
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const canShareWithGuest = useCanShareWithGuest(thread.environmentId);
  const markThreadUnread = useAtomCommand(threadEnvironment.markUnread, { reportFailure: false });
  const moveProjectTargets = useMoveThreadProjectTargets(thread);
  const canTurnIntoProject = canTurnThreadIntoProject(thread);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);

  const snoozeGateExpiryMs = props.snoozeSupported
    ? resolveThreadListV2SnoozeGateExpiryMs(thread, { now: thread.latestUserMessageAt ?? "" })
    : null;
  const snoozeGateNowMs = useNowAfter(snoozeGateExpiryMs === null ? null : snoozeGateExpiryMs + 1);
  const snoozeGateNow = new Date(snoozeGateNowMs).toISOString();
  const snoozable = props.snoozeSupported && canSnooze(thread, { now: snoozeGateNow });
  const snoozePresets = resolveThreadListV2SnoozePresets(
    {
      secondary: snoozable ? "snooze" : null,
      now: entry.snoozePresetMinute || snoozeGateNow,
      presets: props.snoozePresets,
    },
    m,
  );
  const snoozePresetActions = useMemo<MenuAction[]>(
    () => [
      ...snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
      { id: "snooze:custom", title: gt("Custom…", { $context: "custom snooze time" }) },
    ],
    [gt, snoozePresets],
  );

  const menuActions = useMemo<MenuAction[]>(() => {
    const actions: MenuAction[] = [
      ...(props.pinningSupported
        ? [
            {
              id: "unpin",
              title: gt("Unpin", { $context: "verb, thread action" }),
              image: "pin.slash",
            } satisfies MenuAction,
          ]
        : []),
      ...(props.settlementSupported
        ? [
            {
              id: "settle",
              title: gt("Settle", { $context: "verb, thread action" }),
              image: "checkmark",
            } satisfies MenuAction,
          ]
        : []),
      ...(snoozable
        ? [
            {
              id: "snooze",
              title: gt("Snooze", { $context: "verb, thread action" }),
              image: "clock",
              subactions: snoozePresetActions,
            } satisfies MenuAction,
          ]
        : []),
      ...(canTurnIntoProject
        ? [
            {
              id: "turn-into-project",
              title: gt("Turn into project"),
              image: "folder.badge.plus",
              attributes: { disabled: !threadCanArchive(thread.runtime) },
            } satisfies MenuAction,
          ]
        : []),
      ...(moveProjectTargets.length > 0
        ? [
            {
              id: "move-to-project",
              title: gt("Move to project"),
              image: "folder",
              attributes: { disabled: !threadCanArchive(thread.runtime) },
              subactions: moveProjectTargets.map((project) => ({
                id: `move-to-project:${project.id}`,
                title: project.name,
                attributes: { disabled: !threadCanArchive(thread.runtime) },
              })),
            } satisfies MenuAction,
          ]
        : []),
      {
        id: "rename",
        title: gt("Rename", { $context: "verb, thread action" }),
        image: "square.and.pencil",
      },
      { id: "copy-thread", title: gt("Copy thread"), image: "text.bubble" },
      { id: "copy-thread-id", title: gt("Copy thread ID"), image: "doc.on.doc" },
      ...(canShareWithGuest
        ? [
            {
              id: "share-guest",
              title: gt("Share with guest"),
              image: "person.badge.plus",
            } satisfies MenuAction,
          ]
        : []),
      ...(thread.latestRun?.completedAt != null && threadCanArchive(thread.runtime)
        ? [{ id: "mark-unread", title: gt("Mark unread"), image: "envelope.badge" }]
        : []),
      {
        id: "delete",
        title: gt("Delete", { $context: "verb, thread action" }),
        image: "trash",
        attributes: { destructive: true },
      },
    ];
    return actions;
  }, [
    canShareWithGuest,
    canTurnIntoProject,
    gt,
    moveProjectTargets,
    props.pinningSupported,
    props.settlementSupported,
    snoozable,
    snoozePresetActions,
    thread.latestRun,
    thread.runtime,
  ]);

  const handleMenuAction = ({
    nativeEvent,
  }: {
    readonly nativeEvent: { readonly event: string };
  }) => {
    if (nativeEvent.event === "unpin") props.onUnpinThread(thread);
    if (nativeEvent.event === "settle") void props.onSettleThread(thread);
    if (nativeEvent.event === "rename") props.onRenameThread(thread);
    if (nativeEvent.event === "delete") props.onDeleteThread(thread);
    if (nativeEvent.event === "turn-into-project") void turnThreadIntoProject(thread);
    if (nativeEvent.event.startsWith("move-to-project:")) {
      void moveThreadToProject(
        thread,
        ProjectId.make(nativeEvent.event.slice("move-to-project:".length)),
      );
    }
    if (nativeEvent.event === "mark-unread") {
      void markThreadUnread({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      });
    }
    if (nativeEvent.event === "copy-thread") {
      const target = threadChipCopyTarget(
        { environmentId: thread.environmentId, threadId: thread.id },
        thread.title,
        undefined,
        m,
      );
      void copyThreadReference(target).then((didCopy) => {
        if (!didCopy) Dialog.alert(target.failureTitle, gt("Try copying this thread again."));
      });
    }
    if (nativeEvent.event === "copy-thread-id") {
      copyTextWithHaptic(thread.id, { target: "thread-id" });
    }
    if (nativeEvent.event === "share-guest") {
      navigation.navigate("ThreadGuestShare", {
        environmentId: thread.environmentId,
        threadId: thread.id,
      });
    }
    if (nativeEvent.event === "snooze:custom") {
      setCustomSnoozeOpen(true);
      return;
    }
    const snoozeSelection = resolveThreadListV2SnoozeMenuSelection({
      event: nativeEvent.event,
      displayedPresets: snoozePresets,
      now: new Date(),
      presets: props.snoozePresets,
    });
    if (snoozeSelection._tag === "selected") {
      props.onSnoozeThread(thread, snoozeSelection.preset.snoozedUntil);
    } else if (snoozeSelection._tag === "expired") {
      Dialog.alert(
        gt("Could not snooze thread"),
        gt("That snooze time has passed. Choose another time."),
      );
    }
  };

  const badge = resolvePinnedRowBadge(thread, wokeAt, m);
  const trailingText = badge?.label ?? entry.timeLabel;
  const trailingClassName = badge
    ? badge.className
    : props.selected
      ? selectedThreadRowColors.mutedForegroundClassName
      : tertiaryForegroundClassName;

  const rowBody = (
    <View>
      {props.showTopDivider ? (
        <View className={cn("h-px", sidebarPane ? "bg-drawer-border" : "bg-border-subtle")} />
      ) : null}
      <RowPressable
        accessibilityRole="button"
        accessibilityState={{ selected: props.selected }}
        accessibilityLabel={`${thread.title}, ${trailingText}`}
        interactionClassName={interactionClassName}
        interactionOpacity={interactionOpacity}
        onPress={() => props.onSelectThread(thread)}
        className={cn(
          "flex-row items-center gap-2 px-3 py-2",
          props.selected && "bg-thread-selected",
        )}
      >
        {props.project ? (
          <ProjectFavicon
            environmentId={thread.environmentId}
            faviconPath={props.project.faviconPath}
            projectIcon={props.project.projectIcon}
            size={15}
            projectTitle={props.project.title}
            workspaceRoot={props.project.workspaceRoot}
          />
        ) : (
          <SymbolView
            name="pin"
            size={13}
            tintColorClassName={
              props.selected
                ? selectedThreadRowColors.mutedIconTintClassName
                : mutedIconTintClassName
            }
            type="monochrome"
          />
        )}
        <Text
          numberOfLines={1}
          className={cn(
            "min-w-0 flex-1 text-sm font-t3-medium",
            props.selected ? selectedThreadRowColors.foregroundClassName : foregroundClassName,
          )}
        >
          {thread.title}
        </Text>
        <View className="flex-row items-center gap-1.5">
          {entry.hasQueuedMessages ? <QueuedMessageIcon selected={props.selected} /> : null}
          <Text
            numberOfLines={1}
            className={cn(
              "text-xs tabular-nums",
              badge && "font-t3-bold",
              props.selected && badge
                ? selectedThreadRowColors.foregroundClassName
                : trailingClassName,
            )}
          >
            {trailingText}
          </Text>
        </View>
      </RowPressable>
    </View>
  );

  return (
    <View>
      {customSnoozeOpen ? (
        <CustomSnoozeSheet
          onClose={() => setCustomSnoozeOpen(false)}
          onSnooze={(snoozedUntil) => props.onSnoozeThread(thread, snoozedUntil)}
        />
      ) : null}
      {canOperateThread ? (
        <Menu
          shouldOpenOnLongPress
          title={thread.title}
          actions={menuActions}
          onPressAction={handleMenuAction}
        >
          {rowBody}
        </Menu>
      ) : (
        rowBody
      )}
    </View>
  );
});

export const ThreadListV2PinnedStrip = memo(function ThreadListV2PinnedStrip(props: {
  readonly entries: ReadonlyArray<ThreadListV2ThreadListItem>;
  readonly count: number;
  readonly pane?: "screen" | "sidebar";
  readonly selectedThreadKey: string | null;
  readonly projectByKey: ReadonlyMap<string, EnvironmentProject>;
  readonly settlementEnvironmentIds: ReadonlySet<string>;
  readonly snoozeEnvironmentIds: ReadonlySet<string>;
  readonly snoozePresetsByEnvironmentId: ReadonlyMap<string, ReadonlyArray<SnoozePresetSetting>>;
  readonly pinningEnvironmentIds: ReadonlySet<string>;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => void;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
}) {
  const gt = useGT();
  const sidebarPane = props.pane === "sidebar";
  return (
    <View
      className={cn(
        "overflow-hidden border",
        sidebarPane
          ? "mx-1 my-1 rounded-xl border-drawer-border bg-drawer"
          : "mx-4 my-1.5 rounded-2xl border-border-subtle bg-grouped-card",
      )}
    >
      <View
        className={cn(
          "flex-row items-center justify-between px-3 py-1.5",
          sidebarPane ? "border-b border-drawer-border" : "border-b border-border-subtle",
        )}
      >
        <View className="flex-row items-center gap-1.5">
          <SymbolView
            name="pin"
            size={11}
            tintColorClassName={
              sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-tertiary"
            }
            type="monochrome"
          />
          <Text
            className={cn(
              "text-xs font-t3-semibold uppercase tracking-wide",
              sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-tertiary",
            )}
          >
            {gt("Pinned")}
          </Text>
        </View>
        <Text
          className={cn(
            "text-xs tabular-nums",
            sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-tertiary",
          )}
        >
          {props.count}
        </Text>
      </View>
      {props.entries.map((entry, index) => {
        const thread = entry.item.thread;
        const threadKey = `${thread.environmentId}:${thread.id}`;
        const projectKey = `${thread.environmentId}:${thread.projectId}`;
        return (
          <PinnedStripRow
            key={entry.key}
            entry={entry}
            project={props.projectByKey.get(projectKey) ?? null}
            selected={props.selectedThreadKey === threadKey}
            pane={sidebarPane ? "sidebar" : "screen"}
            showTopDivider={index > 0}
            settlementSupported={props.settlementEnvironmentIds.has(thread.environmentId)}
            snoozeSupported={props.snoozeEnvironmentIds.has(thread.environmentId)}
            snoozePresets={props.snoozePresetsByEnvironmentId.get(thread.environmentId)}
            pinningSupported={props.pinningEnvironmentIds.has(thread.environmentId)}
            onSelectThread={props.onSelectThread}
            onUnpinThread={props.onUnpinThread}
            onSettleThread={props.onSettleThread}
            onSnoozeThread={props.onSnoozeThread}
            onRenameThread={props.onRenameThread}
            onDeleteThread={props.onDeleteThread}
          />
        );
      })}
    </View>
  );
});

function ProjectFolderSnoozeAction(props: {
  readonly projectTitle: string;
  readonly snoozeableThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now: string;
  readonly snoozePresets: ReadonlyArray<SnoozePresetSetting> | undefined;
  readonly iconTintClassName: string;
  readonly onSnoozeThreads: (
    threads: readonly EnvironmentThreadShell[],
    snoozedUntil: string,
  ) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);

  const displayedPresets = resolveThreadListV2SnoozePresets(
    {
      secondary: "snooze",
      now: props.now,
      presets: props.snoozePresets,
    },
    m,
  );

  const snoozeMenuActions = useMemo<MenuAction[]>(
    () => [
      ...displayedPresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
      { id: "snooze:custom", title: gt("Custom…", { $context: "custom snooze time" }) },
    ],
    [displayedPresets, gt],
  );

  const handlePressAction = ({
    nativeEvent,
  }: {
    readonly nativeEvent: { readonly event: string };
  }) => {
    if (nativeEvent.event === "snooze:custom") {
      setCustomSnoozeOpen(true);
      return;
    }
    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: nativeEvent.event,
      displayedPresets,
      now: new Date(),
      presets: props.snoozePresets,
    });
    if (selection._tag === "selected") {
      props.onSnoozeThreads(props.snoozeableThreads, selection.preset.snoozedUntil);
    } else if (selection._tag === "expired") {
      Dialog.alert(
        gt("Could not snooze thread"),
        gt("That snooze time has passed. Choose another time."),
      );
    }
  };

  return (
    <>
      {customSnoozeOpen ? (
        <CustomSnoozeSheet
          onClose={() => setCustomSnoozeOpen(false)}
          onSnooze={(snoozedUntil) => props.onSnoozeThreads(props.snoozeableThreads, snoozedUntil)}
        />
      ) : null}
      <Menu
        title={gt("Snooze {project}", { project: props.projectTitle })}
        actions={snoozeMenuActions}
        onPressAction={handlePressAction}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Snooze {project}", { project: props.projectTitle })}
          hitSlop={6}
          className="size-7 items-center justify-center rounded-full active:opacity-60"
        >
          <SymbolView
            name="clock"
            size={14}
            tintColorClassName={props.iconTintClassName}
            type="monochrome"
          />
        </Pressable>
      </Menu>
    </>
  );
}

export const ThreadListV2ProjectFolderHeader = memo(
  function ThreadListV2ProjectFolderHeader(props: {
    readonly item: ThreadListV2ProjectFolderListItem;
    readonly pane?: "screen" | "sidebar";
    readonly now: string;
    readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
    readonly snoozePresetsByEnvironmentId?: ReadonlyMap<
      EnvironmentId,
      readonly SnoozePresetSetting[]
    >;
    readonly onToggle: (projectKey: string, doneOnly: boolean, collapsed: boolean) => void;
    readonly onOrganize?: () => void;
    readonly onNewThreadInProject?: (project: EnvironmentProject) => void;
    readonly onSnoozeThreads?: (
      threads: readonly EnvironmentThreadShell[],
      snoozedUntil: string,
    ) => void;
  }) {
    const { item, now } = props;
    const gt = useGT();
    const sidebarPane = props.pane === "sidebar";
    const mutedIcon = sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-muted";
    const mutedText = sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-muted";
    const tertiaryText = sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-tertiary";
    useEnvironmentScope(item.representative.environmentId, AuthOrchestrationOperateScope);
    const { snoozeable } = partitionSnoozeableFolderThreads(item.threads, {
      now,
      supportsSnooze: (environmentId) => props.snoozeEnvironmentIds?.has(environmentId) ?? false,
      canOperate: (environmentId) =>
        readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
    });
    const snoozeEnvId = snoozeable[0]?.environmentId ?? item.representative.environmentId;

    return (
      <View
        className={cn("mt-2 flex-row items-center gap-1.5 py-1", sidebarPane ? "px-2" : "px-4")}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: !item.collapsed }}
          accessibilityLabel={gt("{title} project folder, {count} threads", {
            title: item.title,
            count: item.totalCount,
          })}
          className="min-w-0 flex-1 flex-row items-center gap-2 py-1 active:opacity-60"
          onPress={() => props.onToggle(item.projectKey, item.doneOnly, item.collapsed)}
        >
          <SymbolView
            name={item.collapsed ? "chevron.right" : "chevron.down"}
            size={11}
            tintColorClassName={mutedIcon}
            type="monochrome"
          />
          {item.isScratch ? (
            <SymbolView name="folder" size={15} tintColorClassName={mutedIcon} type="monochrome" />
          ) : (
            <ProjectFavicon
              environmentId={item.representative.environmentId}
              faviconPath={item.representative.faviconPath}
              projectIcon={item.representative.projectIcon}
              size={16}
              projectTitle={item.title}
              workspaceRoot={item.representative.workspaceRoot}
            />
          )}
          <Text
            numberOfLines={1}
            className={cn(
              "min-w-0 shrink text-xs font-t3-semibold uppercase tracking-wide",
              mutedText,
            )}
          >
            {item.title}
          </Text>
          <Text className={cn("text-xs tabular-nums", tertiaryText)}>{item.totalCount}</Text>
          {item.collapsed ? (
            <View className="flex-row items-center gap-1.5">
              {item.rollup.failed > 0 ? (
                <Text className="rounded-full bg-danger/15 px-1.5 py-0.5 text-2xs font-t3-bold tabular-nums text-danger-foreground">
                  {`${item.rollup.failed} !`}
                </Text>
              ) : null}
              {item.rollup.attention > 0 ? (
                <Text className="rounded-full bg-warning/20 px-1.5 py-0.5 text-2xs font-t3-bold tabular-nums text-warning-foreground">
                  {`${item.rollup.attention} !`}
                </Text>
              ) : null}
              {item.rollup.working > 0 ? (
                <Text className="rounded-full bg-subtle px-1.5 py-0.5 text-2xs font-t3-bold tabular-nums text-adaptive-sky-600-400">
                  {item.rollup.working}
                </Text>
              ) : null}
              {item.rollup.done > 0 ? (
                <Text className="rounded-full bg-subtle px-1.5 py-0.5 text-2xs font-t3-bold tabular-nums text-adaptive-emerald-700-300">
                  {`${item.rollup.done} ✓`}
                </Text>
              ) : null}
            </View>
          ) : null}
        </Pressable>
        {item.isScratch &&
        !item.collapsed &&
        item.canOrganize &&
        item.totalCount > 0 &&
        props.onOrganize ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Organize No project threads")}
            hitSlop={4}
            className="rounded-full bg-subtle px-2.5 py-1 active:opacity-70"
            onPress={props.onOrganize}
          >
            <Text className="text-xs font-t3-medium text-primary-text">
              {gt("Organize", { $context: "verb, organize ungrouped threads" })}
            </Text>
          </Pressable>
        ) : null}
        {snoozeable.length > 0 && props.onSnoozeThreads ? (
          <ProjectFolderSnoozeAction
            projectTitle={item.title}
            snoozeableThreads={snoozeable}
            now={now}
            snoozePresets={props.snoozePresetsByEnvironmentId?.get(snoozeEnvId)}
            iconTintClassName={mutedIcon}
            onSnoozeThreads={props.onSnoozeThreads}
          />
        ) : null}
        {props.onNewThreadInProject ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("New thread in {project}", { project: item.title })}
            hitSlop={6}
            className="size-7 items-center justify-center rounded-full active:opacity-60"
            onPress={() => props.onNewThreadInProject?.(item.representative)}
          >
            <SymbolView name="plus" size={14} tintColorClassName={mutedIcon} type="monochrome" />
          </Pressable>
        ) : null}
      </View>
    );
  },
);

const STATUS_BUCKET_META: Record<
  SidebarStatusBucketKey,
  {
    readonly label: string;
    readonly icon: AppSymbolName;
    readonly iconTintClassName: string;
  }
> = {
  attention: {
    label: msg("Needs Attention", { $context: "thread queue status group heading" }),
    icon: "exclamationmark.circle",
    iconTintClassName: "accent-warning-foreground",
  },
  active: {
    label: msg("Active", { $context: "thread queue status group heading" }),
    icon: "bolt.circle",
    iconTintClassName: "accent-adaptive-sky-600-400",
  },
  done: {
    label: msg("Done", { $context: "thread queue status group heading" }),
    icon: "checkmark.circle",
    iconTintClassName: "accent-adaptive-emerald-700-300",
  },
};

export const ThreadListV2StatusGroupHeader = memo(function ThreadListV2StatusGroupHeader(props: {
  readonly item: ThreadListV2StatusGroupListItem;
  readonly pane?: "screen" | "sidebar";
  readonly onToggle: (
    bucketKey: SidebarStatusBucketKey,
    doneOnly: boolean,
    collapsed: boolean,
  ) => void;
}) {
  const { item } = props;
  const m = useMessages();
  const sidebarPane = props.pane === "sidebar";
  const meta = STATUS_BUCKET_META[item.bucketKey];
  const label = m(meta.label);
  const mutedIcon = sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-muted";
  const mutedText = sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-muted";
  const tertiaryText = sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-tertiary";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: !item.collapsed }}
      accessibilityLabel={`${label}, ${item.totalCount}`}
      className={cn(
        "mt-2 flex-row items-center gap-2 py-1.5 active:opacity-60",
        sidebarPane ? "px-2" : "px-4",
      )}
      onPress={() => props.onToggle(item.bucketKey, item.doneOnly, item.collapsed)}
    >
      <SymbolView
        name={item.collapsed ? "chevron.right" : "chevron.down"}
        size={11}
        tintColorClassName={mutedIcon}
        type="monochrome"
      />
      <SymbolView
        name={meta.icon}
        size={14}
        tintColorClassName={meta.iconTintClassName}
        type="monochrome"
      />
      <Text
        numberOfLines={1}
        className={cn("min-w-0 shrink text-xs font-t3-semibold uppercase tracking-wide", mutedText)}
      >
        {label}
      </Text>
      <Text className={cn("text-xs tabular-nums", tertiaryText)}>{item.totalCount}</Text>
    </Pressable>
  );
});

export const ThreadListV2ShelfProjectHeader = memo(function ThreadListV2ShelfProjectHeader(props: {
  readonly item: ThreadListV2ShelfProjectFolderListItem;
  readonly pane?: "screen" | "sidebar";
  readonly now: string;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozePresetsByEnvironmentId?: ReadonlyMap<
    EnvironmentId,
    readonly SnoozePresetSetting[]
  >;
  readonly onToggle: (
    shelf: ThreadListV2ShelfProjectFolderListItem["shelf"],
    projectKey: string,
  ) => void;
  readonly onSnoozeThreads?: (
    threads: readonly EnvironmentThreadShell[],
    snoozedUntil: string,
  ) => void;
  readonly onWakeThreads?: (threads: readonly EnvironmentThreadShell[]) => void;
}) {
  const { item, now } = props;
  const gt = useGT();
  const sidebarPane = props.pane === "sidebar";
  const mutedIcon = sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-tertiary";
  const mutedText = sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-muted";
  const tertiaryText = sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-tertiary";
  useEnvironmentScope(item.representative.environmentId, AuthOrchestrationOperateScope);
  const { snoozeable } =
    item.shelf === "working"
      ? partitionSnoozeableFolderThreads(item.threads, {
          now,
          supportsSnooze: (environmentId) =>
            props.snoozeEnvironmentIds?.has(environmentId) ?? false,
          canOperate: (environmentId) =>
            readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
        })
      : { snoozeable: [] as EnvironmentThreadShell[] };
  const snoozeEnvId = snoozeable[0]?.environmentId ?? item.representative.environmentId;
  const wakeable =
    item.shelf === "snoozed"
      ? item.threads.filter(
          (thread) =>
            (props.snoozeEnvironmentIds?.has(thread.environmentId) ?? false) &&
            readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
        )
      : [];
  const showSnooze =
    item.shelf === "working" && snoozeable.length > 0 && Boolean(props.onSnoozeThreads);
  const showWake = item.shelf === "snoozed" && wakeable.length > 0 && Boolean(props.onWakeThreads);

  return (
    <View className={cn("flex-row items-center gap-1.5", sidebarPane ? "pl-4 pr-2" : "pl-7 pr-4")}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !item.collapsed }}
        accessibilityLabel={`${item.title}, ${item.totalCount}`}
        className="min-w-0 flex-1 flex-row items-center gap-2 py-1.5 active:opacity-60"
        onPress={() => props.onToggle(item.shelf, item.projectKey)}
      >
        <SymbolView
          name={item.collapsed ? "chevron.right" : "chevron.down"}
          size={10}
          tintColorClassName={mutedIcon}
          type="monochrome"
        />
        {item.isScratch ? (
          <SymbolView name="folder" size={13} tintColorClassName={mutedIcon} type="monochrome" />
        ) : (
          <ProjectFavicon
            environmentId={item.representative.environmentId}
            faviconPath={item.representative.faviconPath}
            projectIcon={item.representative.projectIcon}
            size={14}
            projectTitle={item.title}
            workspaceRoot={item.representative.workspaceRoot}
          />
        )}
        <Text numberOfLines={1} className={cn("min-w-0 shrink text-xs font-t3-medium", mutedText)}>
          {item.title}
        </Text>
        <Text className={cn("text-xs tabular-nums", tertiaryText)}>{item.totalCount}</Text>
      </Pressable>
      {showWake ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Wake {project}", { project: item.title })}
          hitSlop={6}
          className="size-7 items-center justify-center rounded-full active:opacity-60"
          onPress={() => props.onWakeThreads?.(wakeable)}
        >
          <SymbolView name="alarm" size={14} tintColorClassName={mutedIcon} type="monochrome" />
        </Pressable>
      ) : null}
      {showSnooze && props.onSnoozeThreads ? (
        <ProjectFolderSnoozeAction
          projectTitle={item.title}
          snoozeableThreads={snoozeable}
          now={now}
          snoozePresets={props.snoozePresetsByEnvironmentId?.get(snoozeEnvId)}
          iconTintClassName={mutedIcon}
          onSnoozeThreads={props.onSnoozeThreads}
        />
      ) : null}
    </View>
  );
});

export const ThreadListV2TriageEmptyRow = memo(function ThreadListV2TriageEmptyRow(props: {
  readonly item: ThreadListV2TriageEmptyListItem;
  readonly pane?: "screen" | "sidebar";
  readonly onResetFilter: () => void;
}) {
  const gt = useGT();
  const sidebarPane = props.pane === "sidebar";
  const subtitle =
    props.item.filter === "attention"
      ? gt("No threads need attention right now.")
      : props.item.filter === "done"
        ? gt("No unseen completed threads right now.")
        : gt("No ungrouped threads right now.");
  return (
    <View
      className={cn(
        "items-center gap-2.5 border px-4 py-5",
        sidebarPane
          ? "mx-1 my-2 rounded-xl border-drawer-border bg-drawer"
          : "mx-4 my-2 rounded-2xl border-border-subtle bg-grouped-card",
      )}
    >
      <Text
        className={cn(
          "text-center text-sm",
          sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-muted",
        )}
      >
        {subtitle}
      </Text>
      <Chip label={gt("Show all")} size="small" onPress={props.onResetFilter} />
    </View>
  );
});

export function queueGroupingModeLabel(
  mode: "project" | "status" | "flat",
  resolve: ReturnType<typeof useMessages>,
) {
  if (mode === "project") return resolve(msg("By project"));
  if (mode === "status") return resolve(msg("By status"));
  return resolve(msg("Flat"));
}

export function queueGroupingModeIcon(mode: "project" | "status" | "flat"): AppSymbolName {
  if (mode === "project") return "square.grid.2x2";
  if (mode === "status") return "bolt.circle";
  return "line.3.horizontal";
}
