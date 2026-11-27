import { Platform, Pressable, View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { cn } from "../../lib/cn";
import type { BrowneIntegrationDefinition } from "./integrationRegistry";
import { useLaunchIntegration } from "./useLaunchIntegration";

export function IntegrationActionList(props: {
  readonly integrations: ReadonlyArray<BrowneIntegrationDefinition>;
  readonly environmentId?: EnvironmentId | null;
  readonly disabled?: boolean;
}) {
  const { launch, isBusy } = useLaunchIntegration();
  if (props.integrations.length === 0) {
    return null;
  }

  return (
    <View
      collapsable={false}
      className={
        Platform.OS === "android"
          ? "overflow-hidden rounded-[28px] bg-grouped-card"
          : "overflow-hidden rounded-[24px] bg-grouped-card"
      }
    >
      {props.integrations.map((integration, index) => {
        const title = integration.title();
        const subtitle = integration.subtitle();
        const busy = isBusy(integration.id);
        const disabled = Boolean(props.disabled) || busy;
        const onPress = () =>
          launch(integration, {
            environmentId: props.environmentId ?? undefined,
          });

        if (Platform.OS === "android") {
          return (
            <NavigationRow
              key={integration.id}
              className="bg-grouped-card"
              title={title}
              subtitle={subtitle}
              disabled={disabled}
              onPress={onPress}
              leading={
                busy ? (
                  <AppActivityIndicator colorClassName="accent-icon-muted" size="small" />
                ) : (
                  <SymbolView
                    name={integration.icon}
                    size={22}
                    tintColorClassName="accent-icon-muted"
                    type="monochrome"
                  />
                )
              }
            />
          );
        }

        return (
          <View key={integration.id} className={cn(index > 0 && "border-t border-border-subtle")}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={title}
              disabled={disabled}
              onPress={onPress}
              className={cn(
                "flex-row items-center gap-3 bg-grouped-card px-4 py-3.5",
                disabled && "opacity-45",
              )}
            >
              <View className="h-7 w-7 items-center justify-center">
                {busy ? (
                  <AppActivityIndicator colorClassName="accent-icon-muted" size="small" />
                ) : (
                  <SymbolView
                    name={integration.icon}
                    size={18}
                    tintColorClassName="accent-icon-muted"
                    type="monochrome"
                  />
                )}
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-base font-t3-bold leading-snug">{title}</Text>
                <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={1}>
                  {subtitle}
                </Text>
              </View>
              <SymbolView
                name="chevron.right"
                size={14}
                tintColorClassName="accent-chevron"
                type="monochrome"
              />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}
