import { EnvironmentId } from "@t3tools/contracts";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useEffect, useRef } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { TalkToFleetCards } from "./TalkToFleetCards";
import { useTalkToFleet } from "./TalkToFleetProvider";
import { TalkToFleetWaveform } from "./TalkToFleetWaveform";
import { isTalkToFleetActivePhase, type TalkToFleetClientPhase } from "./talkToFleetState";

function usePhaseLabel(phase: TalkToFleetClientPhase): string {
  const gt = useGT();
  switch (phase) {
    case "idle":
      return gt("Ready");
    case "connecting":
      return gt("Connecting...");
    case "listening":
      return gt("Listening");
    case "thinking":
      return gt("Thinking...");
    case "speaking":
      return gt("Speaking");
    case "reconnecting":
      return gt("Reconnecting...");
    case "paused":
      return gt("Paused");
    case "ended":
      return gt("Ended");
    case "error":
      return gt("Disconnected");
  }
}

export function TalkToFleetRouteScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const route = useRoute();
  const params = (route.params ?? {}) as {
    readonly environmentId?: string;
    readonly threadId?: string;
  };
  const {
    state,
    audioLevels,
    isNativeSupported,
    start,
    hangup,
    newSession,
    toggleMute,
    toggleSpeaker,
    toggleCaptions,
    respondApproval,
    interruptAssistant,
  } = useTalkToFleet();

  const targetEnvironmentId = params.environmentId
    ? EnvironmentId.make(params.environmentId)
    : undefined;
  const startKey = `${params.environmentId ?? ""}:${params.threadId ?? ""}`;
  const autoStartedKeyRef = useRef<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Starts the external native audio/WebSocket call session once when Talk to Fleet opens.
  useEffect(() => {
    if (!isNativeSupported || autoStartedKeyRef.current === startKey) {
      return;
    }
    const shouldStart =
      state.phase === "idle" ||
      state.phase === "ended" ||
      (typeof params.threadId === "string" && state.scopedThreadId !== params.threadId);
    if (!shouldStart) {
      return;
    }
    autoStartedKeyRef.current = startKey;
    void start({
      environmentId: targetEnvironmentId,
      threadId: params.threadId,
    });
  }, [
    isNativeSupported,
    params.threadId,
    start,
    startKey,
    state.phase,
    state.scopedThreadId,
    targetEnvironmentId,
  ]);

  const phaseLabel = usePhaseLabel(state.phase);
  const isActive = isTalkToFleetActivePhase(state.phase);

  return (
    <View
      className="flex-1 bg-screen"
      style={{ paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 16) }}
    >
      <View className="flex-row items-center justify-between px-4 py-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Minimize Talk to Fleet")}
          onPress={() => navigation.goBack()}
          className="flex-row items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 active:opacity-75"
        >
          <SymbolView
            name="chevron.down"
            size={16}
            tintColorClassName="accent-foreground"
            type="monochrome"
          />
          <Text className="text-xs font-medium text-foreground">{gt("Minimize")}</Text>
        </Pressable>

        <View className="items-center">
          <Text className="text-base font-semibold text-foreground">{gt("Talk to Fleet")}</Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {state.scopedThreadTitle ? `${state.scopedThreadTitle} · ${state.route}` : state.route}
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Start new session")}
          onPress={newSession}
          className="flex-row items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 active:opacity-75"
        >
          <SymbolView
            name="arrow.clockwise"
            size={15}
            tintColorClassName="accent-foreground"
            type="monochrome"
          />
          <Text className="text-xs font-medium text-foreground">{gt("New")}</Text>
        </Pressable>
      </View>

      <View className="items-center px-4 pt-4">
        <View className="flex-row items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5">
          <View
            className={cn(
              "size-2 rounded-full",
              state.phase === "speaking"
                ? "bg-primary"
                : isActive
                  ? "bg-foreground"
                  : "bg-danger-foreground",
            )}
          />
          <Text className="text-xs font-semibold text-foreground">{phaseLabel}</Text>
          {state.contextBuiltAt ? (
            <Text className="text-xs text-foreground-muted">{gt("Briefing live")}</Text>
          ) : null}
        </View>

        {state.statusDetail ? (
          <Text className="mt-2 text-center text-xs text-foreground-muted">
            {state.statusDetail}
          </Text>
        ) : null}

        {state.degradedSources.length > 0 ? (
          <View className="mt-2 flex-row items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5">
            <SymbolView
              name="exclamationmark.triangle"
              size={14}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
            <Text className="text-xs text-foreground-muted">
              {gt("Offline sources: {sources}", { sources: state.degradedSources.join(", ") })}
            </Text>
          </View>
        ) : null}
      </View>

      <Pressable
        accessibilityRole={state.phase === "speaking" ? "button" : undefined}
        accessibilityLabel={state.phase === "speaking" ? gt("Interrupt assistant") : undefined}
        disabled={state.phase !== "speaking"}
        onPress={interruptAssistant}
        className="mt-4 items-center"
      >
        <TalkToFleetWaveform audioLevels={audioLevels} phase={state.phase} />
        {state.phase === "speaking" ? (
          <Text className="mt-1 text-[11px] font-medium text-foreground-muted">
            {gt("Tap to interrupt")}
          </Text>
        ) : null}
      </Pressable>

      <ScrollView
        className="flex-1 px-4"
        contentContainerStyle={{ gap: 12, paddingTop: 8, paddingBottom: 20 }}
      >
        {state.error ? (
          <View className="rounded-2xl border border-border bg-card px-4 py-3">
            <View className="flex-row items-center gap-2">
              <SymbolView
                name="exclamationmark.circle"
                size={16}
                tintColorClassName="accent-danger-foreground"
                type="monochrome"
              />
              <Text className="flex-1 text-sm text-danger-foreground">{state.error}</Text>
            </View>
            {isNativeSupported ? (
              <Pressable
                onPress={() =>
                  void start({
                    environmentId: params.environmentId
                      ? EnvironmentId.make(params.environmentId)
                      : undefined,
                    threadId: params.threadId,
                  })
                }
                className="mt-3 items-center rounded-xl bg-primary py-2 active:opacity-80"
              >
                <Text className="text-xs font-semibold text-primary-foreground">
                  {gt("Reconnect")}
                </Text>
              </Pressable>
            ) : Platform.OS !== "ios" ? (
              <Text className="mt-1.5 text-xs text-foreground-muted">
                {gt("Talk to Fleet is currently supported on iOS.")}
              </Text>
            ) : null}
          </View>
        ) : null}

        <TalkToFleetCards
          cards={state.cards}
          environmentId={state.environmentId}
          onRespondApproval={respondApproval}
        />

        {state.showCaptions && state.transcript.length > 0 ? (
          <View className="gap-2 pt-1">
            {state.transcript.map((item) => (
              <View
                key={item.id}
                className={cn(
                  "rounded-2xl px-3.5 py-2.5",
                  item.speaker === "you"
                    ? "self-end bg-secondary"
                    : "self-start border border-border bg-card",
                )}
              >
                <Text className="mb-0.5 text-[11px] font-semibold uppercase text-foreground-muted">
                  {item.speaker === "you" ? gt("You") : gt("Fleet")}
                </Text>
                <Text className="text-sm leading-5 text-foreground">{item.text}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View className="flex-row items-center justify-evenly border-t border-border px-4 pt-3">
        {state.phase === "ended" && isNativeSupported ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={state.showCaptions ? gt("Hide captions") : gt("Show captions")}
              onPress={toggleCaptions}
              className={cn(
                "items-center justify-center gap-1 rounded-2xl border border-border px-4 py-2.5 active:opacity-75",
                state.showCaptions ? "bg-secondary" : "bg-card",
              )}
            >
              <SymbolView
                name="text.bubble"
                size={20}
                tintColorClassName="accent-foreground"
                type="monochrome"
              />
              <Text className="text-xs font-medium text-foreground">{gt("Captions")}</Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Call again")}
              onPress={() =>
                void start({
                  environmentId: targetEnvironmentId ?? state.environmentId ?? undefined,
                  threadId: params.threadId ?? state.scopedThreadId ?? undefined,
                })
              }
              className="items-center justify-center gap-1 rounded-2xl bg-primary px-5 py-2.5 active:opacity-80"
            >
              <SymbolView
                name="mic"
                size={20}
                tintColorClassName="accent-primary-foreground"
                type="monochrome"
              />
              <Text className="text-xs font-semibold text-primary-foreground">
                {gt("Call again")}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Close")}
              onPress={() => navigation.goBack()}
              className="items-center justify-center gap-1 rounded-2xl border border-border bg-card px-5 py-2.5 active:opacity-80"
            >
              <SymbolView
                name="xmark"
                size={20}
                tintColorClassName="accent-foreground"
                type="monochrome"
              />
              <Text className="text-xs font-semibold text-foreground">{gt("Close")}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={state.muted ? gt("Unmute microphone") : gt("Mute microphone")}
              onPress={toggleMute}
              disabled={!isActive}
              className={cn(
                "items-center justify-center gap-1 rounded-2xl px-4 py-2.5 active:opacity-75",
                state.muted ? "bg-danger" : "bg-card border border-border",
                !isActive && "opacity-40",
              )}
            >
              <SymbolView
                name="mic"
                size={20}
                tintColorClassName={state.muted ? "accent-danger-foreground" : "accent-foreground"}
                type="monochrome"
              />
              <Text
                className={cn(
                  "text-xs font-medium",
                  state.muted ? "text-danger-foreground" : "text-foreground",
                )}
              >
                {state.muted ? gt("Muted") : gt("Mute")}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={state.speaker ? gt("Use earpiece") : gt("Use speakerphone")}
              onPress={toggleSpeaker}
              disabled={!isActive}
              className={cn(
                "items-center justify-center gap-1 rounded-2xl border border-border px-4 py-2.5 active:opacity-75",
                state.speaker ? "bg-primary" : "bg-card",
                !isActive && "opacity-40",
              )}
            >
              <SymbolView
                name="headphones"
                size={20}
                tintColorClassName={
                  state.speaker ? "accent-primary-foreground" : "accent-foreground"
                }
                type="monochrome"
              />
              <Text
                className={cn(
                  "text-xs font-medium",
                  state.speaker ? "text-primary-foreground" : "text-foreground",
                )}
              >
                {gt("Speaker")}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={state.showCaptions ? gt("Hide captions") : gt("Show captions")}
              onPress={toggleCaptions}
              className={cn(
                "items-center justify-center gap-1 rounded-2xl border border-border px-4 py-2.5 active:opacity-75",
                state.showCaptions ? "bg-secondary" : "bg-card",
              )}
            >
              <SymbolView
                name="text.bubble"
                size={20}
                tintColorClassName="accent-foreground"
                type="monochrome"
              />
              <Text className="text-xs font-medium text-foreground">{gt("Captions")}</Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isActive ? gt("End Talk to Fleet") : gt("Close")}
              onPress={() => {
                if (isActive) {
                  hangup();
                }
                navigation.goBack();
              }}
              className="items-center justify-center gap-1 rounded-2xl bg-danger px-5 py-2.5 active:opacity-80"
            >
              <SymbolView
                name="xmark"
                size={20}
                tintColorClassName="accent-danger-foreground"
                type="monochrome"
              />
              <Text className="text-xs font-semibold text-danger-foreground">
                {isActive ? gt("End") : gt("Close")}
              </Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}
