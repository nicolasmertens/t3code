import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react-native";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { talkToFleetCurrentRouteAtom, useTalkToFleet } from "./TalkToFleetProvider";
import { isTalkToFleetActivePhase } from "./talkToFleetState";

export function GlobalTalkToFleetPill() {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const { state, hangup, toggleMute } = useTalkToFleet();
  const currentRoute = useAtomValue(talkToFleetCurrentRouteAtom);

  const visible = isTalkToFleetActivePhase(state.phase) && currentRoute !== "TalkToFleet";
  if (!visible) return null;

  const statusText =
    state.phase === "speaking"
      ? gt("Fleet speaking")
      : state.phase === "thinking"
        ? gt("Fleet thinking")
        : state.phase === "reconnecting"
          ? gt("Reconnecting")
          : gt("Fleet listening");

  const pill = (
    <View pointerEvents="box-none" className="absolute inset-0">
      <View
        className="absolute right-4 flex-row items-center gap-2 rounded-full border border-border bg-card px-3 py-2 shadow-md shadow-black/15"
        style={{ top: Math.max(insets.top, 12) + 4 }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Return to Talk to Fleet")}
          onPress={() => {
            whenRootNavigationReady(() => {
              rootNavigationRef.navigate("TalkToFleet");
            });
          }}
          className="flex-row items-center gap-2 active:opacity-75"
        >
          <View
            className={cn(
              "size-2.5 rounded-full",
              state.phase === "speaking" ? "bg-primary" : "bg-foreground",
            )}
          />
          <Text className="text-xs font-semibold text-foreground">{statusText}</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={state.muted ? gt("Unmute microphone") : gt("Mute microphone")}
          onPress={toggleMute}
          className={cn(
            "rounded-full p-1.5 active:opacity-75",
            state.muted ? "bg-danger" : "bg-secondary",
          )}
        >
          <SymbolView
            name="mic"
            size={14}
            tintColorClassName={state.muted ? "accent-danger-foreground" : "accent-foreground"}
            type="monochrome"
          />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("End Talk to Fleet")}
          onPress={hangup}
          className="rounded-full bg-danger p-1.5 active:opacity-75"
        >
          <SymbolView
            name="xmark"
            size={14}
            tintColorClassName="accent-danger-foreground"
            type="monochrome"
          />
        </Pressable>
      </View>
    </View>
  );

  return Platform.OS === "ios" ? <FullWindowOverlay>{pill}</FullWindowOverlay> : pill;
}
