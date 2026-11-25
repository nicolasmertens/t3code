import type { FleetMailPayload } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { MailIcon, RefreshCwIcon, SendIcon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";

import { ThreadDetailsControl } from "../ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../threadDetailsPanelStyles";
import { FleetModuleSection } from "./FleetSectionChrome";

export function MailBridgeSection(props: {
  readonly data: FleetMailPayload;
  readonly busy: boolean;
  readonly onSearch: (query: string) => void;
  readonly onFetchAndInject: (query: string, messageId: string) => void;
  readonly onOpenGodwit: () => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState(props.data.queryUsed);

  return (
    <FleetModuleSection
      headingId="thread-details-mail-bridge-heading"
      title={gt("Postroom & Godwit")}
      status={props.data.status}
      note={props.data.note}
      actions={
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          disabled={props.busy}
          onClick={props.onOpenGodwit}
          aria-label={gt("Open Godwit drafts on maxbook (never auto-sends)")}
        >
          <SendIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span>{gt("Godwit draft")}</span>
        </ThreadDetailsControl>
      }
    >
      <div className="flex items-center gap-1 rounded bg-muted/40 px-1.5 py-1 text-2xs text-muted-foreground">
        <ShieldCheckIcon className="size-3 shrink-0 text-success" aria-hidden />
        <span className="truncate">
          {props.data.followUpOwner.name} ({props.data.followUpOwner.address}) ·{" "}
          {gt("allowlist active")}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              props.onSearch(query);
            }
          }}
          placeholder={gt("Search Postroom emails...")}
          className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 text-xs"
        />
        <ThreadDetailsControl
          size="icon-xs"
          variant="ghost"
          part="icon"
          disabled={props.busy}
          onClick={() => props.onSearch(query)}
          aria-label={gt("Search Postroom")}
        >
          <RefreshCwIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        </ThreadDetailsControl>
      </div>

      {props.data.messages.map((msg) => (
        <ThreadDetailsControl
          key={msg.id}
          size="sm"
          variant="ghost"
          part="row"
          multiline
          disabled={props.busy}
          onClick={() => props.onFetchAndInject(msg.subject, msg.id)}
        >
          <MailIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{msg.subject}</span>
              {msg.allowlistOwner ? (
                <span className="shrink-0 rounded bg-success/12 px-1 py-0.5 text-3xs font-medium text-success-foreground">
                  {gt("Victor")}
                </span>
              ) : null}
            </span>
            <span className="truncate text-2xs text-muted-foreground">
              {msg.from} · {msg.date}
            </span>
          </span>
        </ThreadDetailsControl>
      ))}
    </FleetModuleSection>
  );
}
