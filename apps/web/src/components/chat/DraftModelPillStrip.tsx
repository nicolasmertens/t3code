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
      className="flex min-w-0 flex-wrap items-center justify-center gap-x-1.5 gap-y-1 px-1"
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
                    "inline-flex h-7 max-w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs whitespace-nowrap outline-none transition-[background-color,border-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 active:scale-[0.98]",
                    pill.isSelected
                      ? "border-border/90 bg-card font-medium text-foreground shadow-2xs"
                      : "border-transparent bg-transparent font-normal text-muted-foreground hover:bg-muted/75 hover:text-foreground",
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
                indicatorBackground={pill.isSelected ? "var(--card)" : "var(--background)"}
                badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-2.5 min-w-2.5 px-0.5 text-5xs shadow-none"
              />
              <span className="max-w-40 truncate">{pill.label}</span>
              {pill.disambiguationLabel ? (
                <span className="shrink-0 text-muted-foreground/65">
                  · {pill.disambiguationLabel}
                </span>
              ) : null}
            </TooltipTrigger>
            <TooltipPopup side="bottom">{tooltipLabel}</TooltipPopup>
          </Tooltip>
        );
      })}
      {props.pickerTrigger}
    </div>
  );
});
