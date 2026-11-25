import type { FleetPulsePayload } from "@t3tools/contracts";
import { useGT } from "gt-react";
import {
  AlertTriangleIcon,
  CameraIcon,
  FileAudioIcon,
  FolderIcon,
  PaperclipIcon,
} from "lucide-react";

import { ThreadDetailsControl } from "../ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../threadDetailsPanelStyles";
import { FleetModuleSection } from "./FleetSectionChrome";

export function FleetPulseSection(props: {
  readonly data: FleetPulsePayload;
  readonly busy: boolean;
  readonly onInjectText: (text: string) => void;
  readonly onAttachScreen: () => void;
  readonly onAttachPath: (target: "meeting" | "storage", filePath: string) => void;
}) {
  const gt = useGT();

  return (
    <FleetModuleSection
      headingId="thread-details-fleet-pulse-heading"
      title={gt("Fleet pulse")}
      status={props.data.status}
      note={props.data.note}
      actions={
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          disabled={props.busy}
          onClick={props.onAttachScreen}
          aria-label={gt("Pull latest Screen Observer still from maxbook")}
        >
          <CameraIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span>{gt("Screen")}</span>
        </ThreadDetailsControl>
      }
    >
      <div className="flex flex-wrap gap-1">
        {props.data.hosts.map((host) => (
          <button
            key={host.alias}
            type="button"
            disabled={props.busy}
            onClick={() => props.onInjectText(`[Host: ${host.alias} (${host.role})]`)}
            className="inline-flex items-center gap-1 rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 text-2xs text-foreground/85 hover:bg-muted"
          >
            <span
              className={
                host.ok ? "size-1.5 rounded-full bg-success" : "size-1.5 rounded-full bg-warning"
              }
            />
            <span>{host.alias}</span>
          </button>
        ))}
      </div>

      {props.data.degradedSensors.map((sensor) => (
        <div
          key={`${sensor.host}:${sensor.name}`}
          className="flex items-start gap-1.5 rounded bg-warning-surface px-1.5 py-1 text-2xs text-warning-foreground"
        >
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {sensor.host} · {sensor.name}: {sensor.detail}
          </span>
        </div>
      ))}

      {props.data.recentMeetings.slice(0, 2).map((meeting) => (
        <ThreadDetailsControl
          key={meeting.path}
          size="xs"
          variant="ghost"
          part="row"
          disabled={props.busy}
          onClick={() => props.onAttachPath("meeting", meeting.path)}
        >
          <FileAudioIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-2xs">{meeting.name}</span>
          <PaperclipIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        </ThreadDetailsControl>
      ))}

      {props.data.storageFiles.slice(0, 3).map((file) => (
        <ThreadDetailsControl
          key={file.path}
          size="xs"
          variant="ghost"
          part="row"
          disabled={props.busy}
          onClick={() => props.onAttachPath("storage", file.path)}
        >
          <FolderIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-2xs">{file.name}</span>
          <PaperclipIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        </ThreadDetailsControl>
      ))}
    </FleetModuleSection>
  );
}
