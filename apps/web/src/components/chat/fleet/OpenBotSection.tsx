import type { FleetOpenBotsPayload } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { BotIcon, SendIcon, SnowflakeIcon } from "lucide-react";
import { useState } from "react";

import { ThreadDetailsControl } from "../ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../threadDetailsPanelStyles";
import { FleetModuleSection, FleetStatusPill } from "./FleetSectionChrome";

export function OpenBotSection(props: {
  readonly data: FleetOpenBotsPayload;
  readonly busy: boolean;
  readonly onToggleFreeze: (frozen: boolean) => void;
  readonly onHandoffBot: (botId: string, botName: string, goal: string) => Promise<void>;
}) {
  const gt = useGT();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [goal, setGoal] = useState("");

  const activeBot =
    props.data.bots.find((b) => b.id === selectedBotId) ?? props.data.bots[0] ?? null;

  const dispatch = async () => {
    if (!activeBot || goal.trim().length === 0) return;
    await props.onHandoffBot(activeBot.id, activeBot.name, goal.trim());
    setGoal("");
  };

  return (
    <FleetModuleSection
      headingId="thread-details-openbots-heading"
      title={gt("OpenBot roster")}
      status={props.data.status}
      note={props.data.note}
      actions={
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          disabled={props.busy}
          onClick={() => props.onToggleFreeze(!props.data.frozen)}
          aria-label={gt("Pause or resume autonomous OpenBot dispatches")}
        >
          <SnowflakeIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span>{props.data.frozen ? gt("Unfreeze") : gt("Freeze")}</span>
        </ThreadDetailsControl>
      }
    >
      <div className="flex flex-wrap gap-1">
        {props.data.bots.slice(0, 6).map((bot) => (
          <button
            key={bot.id}
            type="button"
            onClick={() => setSelectedBotId(bot.id)}
            className={
              activeBot?.id === bot.id
                ? "inline-flex items-center gap-1 rounded border border-primary/50 bg-primary/10 px-1.5 py-0.5 text-2xs font-medium"
                : "inline-flex items-center gap-1 rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 text-2xs text-foreground/80 hover:bg-muted"
            }
          >
            <BotIcon className="size-3 shrink-0" aria-hidden />
            <span>{bot.name}</span>
            {bot.lane === "finance-gate" ? (
              <FleetStatusPill status="limited" label={gt("Gate")} />
            ) : bot.recommended ? (
              <FleetStatusPill status="ok" label={gt("Fit")} />
            ) : null}
          </button>
        ))}
      </div>

      {activeBot ? (
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={props.data.frozen || props.busy}
            placeholder={
              props.data.frozen
                ? gt("Frozen, bot dispatches paused")
                : gt("Secret-scrubbed brief for {bot}...", { bot: activeBot.name })
            }
            className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 text-xs disabled:opacity-60"
          />
          <button
            type="button"
            disabled={props.data.frozen || props.busy || goal.trim().length === 0}
            onClick={() => void dispatch()}
            className="inline-flex h-7 items-center gap-1 rounded bg-primary px-2 text-2xs font-medium text-primary-foreground disabled:opacity-50"
          >
            <SendIcon className="size-3" aria-hidden />
            <span>{gt("Ask")}</span>
          </button>
        </div>
      ) : null}
    </FleetModuleSection>
  );
}
