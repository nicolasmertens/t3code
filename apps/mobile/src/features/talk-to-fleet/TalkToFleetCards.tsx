import type { EnvironmentId, TalkToFleetCard } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

export function TalkToFleetCards(props: {
  readonly cards: ReadonlyArray<TalkToFleetCard>;
  readonly environmentId: EnvironmentId | null;
  readonly onRespondApproval: (
    threadId: string,
    requestId: string,
    decision: "accept" | "decline",
  ) => void;
}) {
  const gt = useGT();
  const navigation = useNavigation();

  if (props.cards.length === 0) return null;

  return (
    <View className="gap-2.5">
      {props.cards.map((card) => {
        if (card.kind === "tool") {
          return (
            <View
              key={card.id}
              className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-2.5"
            >
              {card.status === "running" ? (
                <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
              ) : (
                <SymbolView
                  name={
                    card.status === "error" ? "exclamationmark.triangle" : "checkmark.circle.fill"
                  }
                  size={18}
                  tintColorClassName={
                    card.status === "error" ? "accent-danger-foreground" : "accent-foreground"
                  }
                  type="monochrome"
                />
              )}
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                  {card.title}
                </Text>
                {card.detail ? (
                  <Text className="text-xs text-danger-foreground" numberOfLines={2}>
                    {card.detail}
                  </Text>
                ) : card.sourceAge ? (
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {gt("Checked {age}", { age: card.sourceAge })}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        }

        if (card.kind === "thread") {
          const canOpen = props.environmentId !== null;
          return (
            <Pressable
              key={card.id}
              disabled={!canOpen}
              onPress={() => {
                if (!props.environmentId) return;
                navigation.dispatch(
                  StackActions.push("Thread", {
                    environmentId: props.environmentId,
                    threadId: card.threadId,
                  }),
                );
              }}
              className={cn(
                "rounded-2xl border border-border bg-card px-3.5 py-3 active:opacity-80",
                !canOpen && "opacity-75",
              )}
            >
              <View className="flex-row items-center justify-between gap-2">
                <View className="min-w-0 flex-1 flex-row items-center gap-2">
                  <SymbolView
                    name="bubble.left"
                    size={16}
                    tintColorClassName="accent-foreground"
                    type="monochrome"
                  />
                  <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
                    {card.title}
                  </Text>
                </View>
                <Text className="text-xs font-medium uppercase text-foreground-muted">
                  {card.status}
                </Text>
              </View>
              {card.summary ? (
                <Text className="mt-1 text-xs text-foreground-muted" numberOfLines={2}>
                  {card.summary}
                </Text>
              ) : null}
              {canOpen ? (
                <Text className="mt-1.5 text-xs font-medium text-primary-text">
                  {gt("Open thread")}
                </Text>
              ) : null}
            </Pressable>
          );
        }

        const isPending = card.status === "pending";
        return (
          <View key={card.id} className="rounded-2xl border border-border bg-card px-3.5 py-3">
            <View className="flex-row items-center gap-2">
              <SymbolView
                name="bolt.circle"
                size={18}
                tintColorClassName="accent-foreground"
                type="monochrome"
              />
              <Text
                className="min-w-0 flex-1 text-sm font-semibold text-foreground"
                numberOfLines={1}
              >
                {card.threadTitle}
              </Text>
            </View>
            <Text className="mt-1 text-xs text-foreground-muted" numberOfLines={2}>
              {card.summary}
            </Text>
            {isPending ? (
              <View className="mt-2.5 flex-row gap-2">
                <Pressable
                  onPress={() => props.onRespondApproval(card.threadId, card.requestId, "accept")}
                  className="flex-1 items-center rounded-xl bg-primary py-2 active:opacity-80"
                >
                  <Text className="text-xs font-semibold text-primary-foreground">
                    {gt("Approve")}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => props.onRespondApproval(card.threadId, card.requestId, "decline")}
                  className="flex-1 items-center rounded-xl border border-border bg-secondary py-2 active:opacity-80"
                >
                  <Text className="text-xs font-semibold text-foreground">{gt("Decline")}</Text>
                </Pressable>
              </View>
            ) : (
              <Text className="mt-1.5 text-xs font-medium text-foreground-muted">
                {card.status === "approved" ? gt("Approved") : gt("Declined")}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}
