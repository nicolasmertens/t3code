import { LegendList } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, ProjectId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useGT, useMessages } from "gt-react-native";
import { memo, useCallback, useMemo } from "react";
import { Modal, Pressable, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { relativeTime } from "../../lib/time";
import { useEnvironmentScope } from "../../state/session";
import { threadCanArchive } from "../home/threadArchive";
import { moveThreadToProject, useMoveThreadProjectTargets } from "./moveThreadToProject";
import { canTurnThreadIntoProject, turnThreadIntoProject } from "./turnThreadIntoProject";

const OrganizeNoProjectRow = memo(function OrganizeNoProjectRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly showTopDivider: boolean;
}) {
  const { thread } = props;
  const gt = useGT();
  const m = useMessages();
  const canOperate = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const moveTargets = useMoveThreadProjectTargets(thread);
  const canTurnIntoProject = canTurnThreadIntoProject(thread);
  const threadBusy = !threadCanArchive(thread.runtime);

  const actions = useMemo<MenuAction[]>(() => {
    const items: MenuAction[] = [];
    if (canTurnIntoProject) {
      items.push({
        id: "turn-into-project",
        title: gt("Turn into project"),
        image: "folder.badge.plus",
        attributes: { disabled: threadBusy },
      });
    }
    if (moveTargets.length > 0) {
      items.push(
        ...moveTargets.map((project) => ({
          id: `move-to-project:${project.id}`,
          title: project.name,
          image: "folder",
          attributes: { disabled: threadBusy },
        })),
      );
    }
    return items;
  }, [canTurnIntoProject, gt, moveTargets, threadBusy]);

  const handleAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "turn-into-project") {
        void turnThreadIntoProject(thread);
        return;
      }
      if (nativeEvent.event.startsWith("move-to-project:")) {
        void moveThreadToProject(
          thread,
          ProjectId.make(nativeEvent.event.slice("move-to-project:".length)),
        );
      }
    },
    [thread],
  );

  const timeLabel = relativeTime(thread.latestUserMessageAt ?? thread.createdAt, undefined, m);
  const subtitle = thread.branch ? `${thread.branch} · ${timeLabel}` : timeLabel;
  const disabled = !canOperate || actions.length === 0;

  return (
    <View>
      {props.showTopDivider ? <View className="ml-5 h-px bg-border-subtle" /> : null}
      <View className="flex-row items-center gap-3 px-5 py-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={2} className="text-base font-t3-medium text-foreground">
            {thread.title}
          </Text>
          <Text numberOfLines={1} ellipsizeMode="middle" className="text-xs text-foreground-muted">
            {subtitle}
          </Text>
        </View>
        {disabled ? (
          <View className="rounded-full bg-subtle px-3 py-1.5 opacity-45">
            <Text className="text-xs font-t3-medium text-foreground-muted">
              {gt("Move", { $context: "verb, move thread to project" })}
            </Text>
          </View>
        ) : (
          <Menu title={gt("Move thread to project")} actions={actions} onPressAction={handleAction}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Move {title} to a project", { title: thread.title })}
              hitSlop={4}
              className="flex-row items-center gap-1 rounded-full bg-subtle px-3 py-1.5 active:opacity-70"
            >
              <Text className="text-xs font-t3-medium text-primary-text">
                {gt("Move", { $context: "verb, move thread to project" })}
              </Text>
              <SymbolView
                name="chevron.down"
                size={11}
                tintColorClassName="accent-primary-text"
                type="monochrome"
              />
            </Pressable>
          </Menu>
        )}
      </View>
    </View>
  );
});

export function OrganizeNoProjectSheet(props: {
  readonly visible: boolean;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  if (!props.visible) return null;

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider style={{ flex: 1 }}>
          <View className="flex-1 bg-screen">
            <SafeAreaView style={{ flex: 1 }}>
              <SheetHeader
                presentation="inline"
                title={gt("Organize No project")}
                subtitle={gt(
                  "{count, plural, one {{count} ungrouped thread} other {{count} ungrouped threads}}",
                  {
                    count: props.threads.length,
                  },
                )}
                onClose={props.onClose}
                accessibilityLabel={gt("Close organize No project")}
              />
              {props.threads.length === 0 ? (
                <View className="flex-1 items-center justify-center gap-4 px-8">
                  <SymbolView
                    name="checkmark.circle"
                    size={36}
                    tintColorClassName="accent-adaptive-emerald-700-300"
                    type="monochrome"
                  />
                  <View className="items-center gap-1">
                    <Text className="text-base font-t3-semibold text-foreground">
                      {gt("All caught up")}
                    </Text>
                    <Text className="text-center text-sm text-foreground-muted">
                      {gt("No active threads remain in No project.")}
                    </Text>
                  </View>
                  <Button
                    tone="primary"
                    size="compact"
                    label={gt("Done", { $context: "dismiss organize sheet" })}
                    onPress={props.onClose}
                  />
                </View>
              ) : (
                // oxlint-disable-next-line t3code/require-registered-list-scroll -- Rendered inside a standalone pageSheet modal without a native screen header.
                <LegendList
                  data={[...props.threads]}
                  keyExtractor={(thread) => `${thread.environmentId}:${thread.id}`}
                  estimatedItemSize={68}
                  renderItem={({ item, index }) => (
                    <OrganizeNoProjectRow thread={item} showTopDivider={index > 0} />
                  )}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                />
              )}
            </SafeAreaView>
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  );
}
