import { Pressable } from "react-native";
import type { AppSymbolName } from "../../../components/ui/AppSymbol";
import { Chip } from "../../../components/ui/Chip";
import { Menu } from "../../../components/ui/Menu";
import type { MenuProps } from "../../../components/ui/Menu.types";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";

export function ListFilterMenu(props: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly active?: boolean;
  readonly icon?: boolean;
  readonly leadingIcon?: AppSymbolName;
  readonly actions: MenuProps["actions"];
  readonly onSelect: (id: string) => void;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const resolvedIcon = props.leadingIcon ?? (props.icon ? "line.3.horizontal.decrease" : undefined);
  return (
    <Menu
      title={props.accessibilityLabel}
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityState={{ selected: Boolean(props.active) }}
        hitSlop={6}
      >
        <Chip
          label={props.label}
          selected={props.active}
          icon={resolvedIcon}
          trailingIcon={props.icon ? undefined : "chevron.down"}
          glass
          colorScheme={themeAppearance}
        />
      </Pressable>
    </Menu>
  );
}
