import type { ProviderInstanceId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DraftModelPillItem } from "./draftModelPills.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export const DraftModelPillStrip = memo(function DraftModelPillStrip(props: {
  pills: ReadonlyArray<DraftModelPillItem>;
  disabled?: boolean;
  multipleModelsEnabled: boolean;
  onSelectModel: (instanceId: ProviderInstanceId, model: string) => void;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  pickerTrigger: ReactNode;
}) {
  const gt = useGT();

  return (
    <div
      role="group"
      aria-label={gt("Favorite models")}
      data-draft-model-pill-strip="true"
      className="flex min-w-0 flex-wrap items-center justify-end gap-1.5"
    >
      {props.pills.map((pill) => {
        const tooltipLabel = `${pill.fullLabel} · ${pill.providerDisplayName}`;
        return (
          <Tooltip key={pill.key}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  disabled={props.disabled}
                  aria-pressed={pill.isSelected}
                  aria-label={tooltipLabel}
                  data-draft-model-pill="true"
                  data-selected={pill.isSelected ? "true" : undefined}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    if (props.disabled) return;
                    if (
                      props.multipleModelsEnabled &&
                      (event.metaKey || event.ctrlKey) &&
                      props.onToggleModel
                    ) {
                      props.onToggleModel(pill.instanceId, pill.model);
                      return;
                    }
                    props.onSelectModel(pill.instanceId, pill.model);
                  }}
                  className={cn(
                    "inline-flex h-7 max-w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap outline-none transition-[background-color,border-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 active:scale-[0.98]",
                    pill.isSelected
                      ? "border-foreground bg-foreground text-background shadow-xs"
                      : "border-border/80 bg-card/90 text-muted-foreground shadow-2xs hover:border-foreground/20 hover:bg-accent/70 hover:text-foreground",
                  )}
                />
              }
            >
              <ProviderInstanceIcon
                driverKind={pill.driverKind}
                displayName={pill.providerDisplayName}
                accentColor={pill.providerAccentColor}
                acpRegistryAgentId={pill.acpRegistryAgentId}
                acpRegistryIconUrl={pill.acpRegistryIconUrl}
                showBadge={pill.showInstanceBadge}
                size="compact"
                className="size-3.5"
                iconClassName="size-3.5"
                indicatorBackground={pill.isSelected ? "var(--foreground)" : "var(--card)"}
                badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-2.5 min-w-2.5 px-0.5 text-5xs shadow-none"
              />
              <span className="max-w-36 truncate">{pill.label}</span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">{tooltipLabel}</TooltipPopup>
          </Tooltip>
        );
      })}
      {props.pickerTrigger}
    </div>
  );
});
