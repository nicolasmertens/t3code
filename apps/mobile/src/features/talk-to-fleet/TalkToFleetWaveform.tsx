import { memo } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { cn } from "../../lib/cn";
import type { TalkToFleetClientPhase } from "./talkToFleetState";

const BAR_INDICES = Array.from({ length: 16 }, (_, index) => index);
const TIMING = {
  duration: 90,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.System,
} as const;

const Bar = memo(function WaveformBar(props: {
  readonly index: number;
  readonly levels: SharedValue<ReadonlyArray<number>>;
  readonly barClassName: string;
}) {
  const level = useDerivedValue(() => {
    const arr = props.levels.value;
    return arr[props.index] ?? 0;
  });

  const animatedStyle = useAnimatedStyle(() => ({
    height: withTiming(interpolate(level.value, [0, 1], [8, 60]), TIMING),
  }));

  return (
    <Animated.View className={cn("w-1.5 rounded-full", props.barClassName)} style={animatedStyle} />
  );
});

export function TalkToFleetWaveform(props: {
  readonly audioLevels: SharedValue<ReadonlyArray<number>>;
  readonly phase: TalkToFleetClientPhase;
}) {
  const barClassName =
    props.phase === "speaking"
      ? "bg-primary"
      : props.phase === "thinking"
        ? "bg-warning"
        : props.phase === "error" || props.phase === "ended"
          ? "bg-foreground-muted"
          : "bg-foreground";

  return (
    <View className="h-20 flex-row items-center justify-center gap-1.5 px-4">
      {BAR_INDICES.map((index) => (
        <Bar key={index} index={index} levels={props.audioLevels} barClassName={barClassName} />
      ))}
    </View>
  );
}
