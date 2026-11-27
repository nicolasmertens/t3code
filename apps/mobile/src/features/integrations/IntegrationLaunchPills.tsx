import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Platform, ScrollView } from "react-native";

import { Chip } from "../../components/ui/Chip";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { visibleIntegrationsForSurface } from "./integrationRegistry";
import { useLaunchIntegration } from "./useLaunchIntegration";

export function IntegrationLaunchPills(props: {
  readonly environmentId: EnvironmentId | null;
  readonly gutter: number;
}) {
  const gt = useGT();
  const { themeAppearance } = useAppearancePreferences();
  const { launch, isBusy } = useLaunchIntegration();
  const integrations = visibleIntegrationsForSurface("homeStrip", Platform.OS);

  if (integrations.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginHorizontal: -props.gutter, overflow: "visible" }}
      contentContainerStyle={{
        paddingHorizontal: 20,
        paddingTop: 0,
        paddingBottom: 10,
        gap: 8,
      }}
    >
      {integrations.map((integration) => {
        const title = integration.title();
        const busy = isBusy(integration.id);
        return (
          <Chip
            key={integration.id}
            label={busy ? gt("Loading…") : integration.shortTitle()}
            accessibilityLabel={title}
            icon={integration.icon}
            glass={Platform.OS === "ios"}
            colorScheme={themeAppearance}
            disabled={busy}
            onPress={() =>
              launch(integration, {
                environmentId: props.environmentId ?? undefined,
              })
            }
          />
        );
      })}
    </ScrollView>
  );
}
