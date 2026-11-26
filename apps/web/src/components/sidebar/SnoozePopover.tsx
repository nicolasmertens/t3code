// @effect-diagnostics globalDate:off -- Snooze popover computes local calendar slots and fresh snooze timestamps.
import {
  resolveCustomSnooze,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  EyeIcon,
  Link2Icon,
  MessageSquareIcon,
  MinusIcon,
  MonitorIcon,
  PlusIcon,
  Settings2Icon,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useFormattingLocale } from "../../i18n/I18nProvider";
import { readThreadShells } from "../../state/entities";
import { formatShortTimestamp, formatTimeOfDay, weekStartsOn } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildCalendarMonthCells,
  collectBusySnoozeDayCounts,
  defaultCalendarDateKey,
  formatWakeSummary,
  INTERVAL_ANCHOR_HOURS,
  resolveFallbackSnoozeUntil,
  resolveHourGridOptions,
  resolveIntervalOptions,
  SNOOZE_PICKER_TABS,
  type IntervalAnchorHour,
  type SnoozePickerTab,
  type TriggerFallback,
} from "./snoozePicker.logic";

type TriggerSubId = "thread" | "pr" | "session" | "webhook" | "ai";

interface ThreadCandidate {
  readonly id: string;
  readonly title: string;
  readonly isActive: boolean;
}

export interface SnoozePopoverProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSnooze: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  readonly timestampFormat: TimestampFormat;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly hasLinkedPullRequest: boolean;
  readonly linkedPullRequestLabel: string | null;
  readonly onOpenSnoozeSettings?: () => void;
}

const HOVER_INTENT_MS = 120;
const CALENDAR_QUICK_TIMES = ["09:00", "13:00", "18:00"] as const;
const TAB_SHORTCUT_HINT = "1-4";

function formatShortHourPill(
  hour: number,
  timestampFormat: TimestampFormat,
  locale: string | undefined,
): string {
  const sample = new Date(Date.UTC(2000, 0, 1, hour, 0, 0));
  if (timestampFormat === "12-hour") {
    return new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      hour12: true,
      timeZone: "UTC",
    }).format(sample);
  }
  if (timestampFormat === "24-hour") {
    return formatTimeOfDay(`${String(hour).padStart(2, "0")}:00`, timestampFormat);
  }
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    timeZone: "UTC",
  }).format(sample);
}

function readThreadCandidates(
  environmentId: EnvironmentId,
  excludeThreadId: ThreadId,
): ReadonlyArray<ThreadCandidate> {
  const candidates = readThreadShells().filter(
    (shell) =>
      shell.environmentId === environmentId &&
      shell.id !== excludeThreadId &&
      shell.archivedAt == null &&
      shell.deletedAt == null &&
      shell.settledOverride !== "settled",
  );
  const sorted = [...candidates].sort((left, right) => {
    const leftActive = threadRuntimeIsActive(left.runtime) ? 1 : 0;
    const rightActive = threadRuntimeIsActive(right.runtime) ? 1 : 0;
    if (leftActive !== rightActive) return rightActive - leftActive;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
  return sorted.slice(0, 3).map((shell) => ({
    id: shell.id,
    title: shell.title,
    isActive: threadRuntimeIsActive(shell.runtime),
  }));
}

function parseDateKey(dateKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function SnoozePopover(props: SnoozePopoverProps) {
  const { open, onOpenChange, ...contentProps } = props;
  const gt = useGT();
  const [openSequence, setOpenSequence] = useState(0);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setOpenSequence((count) => count + 1);
        onOpenChange(nextOpen);
      }}
    >
      <Tooltip open={open ? false : undefined}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={gt("Snooze thread")}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                />
              }
            />
          }
        >
          <ClockIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>
          <T>Snooze thread</T>
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="end" padding="none">
        <SnoozePopoverContent
          key={openSequence}
          {...contentProps}
          onClose={() => onOpenChange(false)}
        />
      </PopoverPopup>
    </Popover>
  );
}

interface SnoozePopoverContentProps extends Omit<SnoozePopoverProps, "open" | "onOpenChange"> {
  readonly onClose: () => void;
}

function SnoozePopoverContent(props: SnoozePopoverContentProps) {
  const {
    onClose,
    onSnooze,
    timestampFormat,
    environmentId,
    threadId,
    hasLinkedPullRequest,
    linkedPullRequestLabel,
    onOpenSnoozeSettings,
  } = props;
  const gt = useGT();
  const messages = useMessages();
  const locale = useFormattingLocale();
  const navigate = useNavigate();

  const [openedAt, setOpenedAt] = useState<Date>(() => new Date());
  const [activeTab, setActiveTab] = useState<SnoozePickerTab>("hours");
  const [primingTab, setPrimingTab] = useState<SnoozePickerTab | null>(null);
  const [hoverSummary, setHoverSummary] = useState<string | null>(null);

  const [customVal, setCustomVal] = useState(5);
  const [customUnit, setCustomUnit] = useState<"hours" | "minutes">("hours");

  const [anchorHour, setAnchorHour] = useState<IntervalAnchorHour>(9);

  const [calYear, setCalYear] = useState(() => {
    const defaultDate = parseDateKey(defaultCalendarDateKey(openedAt)) ?? openedAt;
    return defaultDate.getFullYear();
  });
  const [calMonth, setCalMonth] = useState(() => {
    const defaultDate = parseDateKey(defaultCalendarDateKey(openedAt)) ?? openedAt;
    return defaultDate.getMonth();
  });
  const [selectedDateKey, setSelectedDateKey] = useState(() => defaultCalendarDateKey(openedAt));
  const [calTime, setCalTime] = useState("09:00");
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [busyDays] = useState<ReadonlyMap<string, number>>(() =>
    collectBusySnoozeDayCounts(readThreadShells(), openedAt.getTime()),
  );

  const [triggerSub, setTriggerSub] = useState<TriggerSubId | null>(null);
  const [threadCandidates] = useState<ReadonlyArray<ThreadCandidate>>(() =>
    readThreadCandidates(environmentId, threadId),
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    () => threadCandidates[0]?.id ?? null,
  );
  const [selectedPrEvent, setSelectedPrEvent] = useState("checks-pass");
  const [selectedWebhookSource, setSelectedWebhookSource] = useState("email");
  const [aiConditionText, setAiConditionText] = useState("");
  const [triggerFallback, setTriggerFallback] = useState<TriggerFallback>("3d");

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabRefs = useRef<Partial<Record<SnoozePickerTab, HTMLButtonElement | null>>>({});

  const clearHoverTimer = () => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setPrimingTab(null);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears pending tab hover-intent timer on unmount
  useEffect(
    () => () => {
      if (hoverTimerRef.current !== null) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    },
    [],
  );

  const formatTime = (date: Date) =>
    formatShortTimestamp(date.toISOString(), timestampFormat, locale);

  const switchTab = (nextTab: SnoozePickerTab) => {
    clearHoverTimer();
    setActiveTab(nextTab);
    setTriggerSub(null);
    setHoverSummary(null);
    setCalendarError(null);
  };

  const commitSnooze = (snoozedUntil: string) => {
    clearHoverTimer();
    onSnooze({ snoozedUntil });
    onClose();
  };

  const handleTabPointerEnter = (
    tabId: SnoozePickerTab,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.pointerType !== "mouse" || activeTab === tabId || triggerSub !== null) return;
    const activeElement = event.currentTarget.ownerDocument.activeElement;
    if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
      return;
    }
    clearHoverTimer();
    setPrimingTab(tabId);
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      setPrimingTab(null);
      setActiveTab(tabId);
      setTriggerSub(null);
      setHoverSummary(null);
      setCalendarError(null);
    }, HOVER_INTENT_MS);
  };

  const onWindowKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    if (event.key === "Escape" && triggerSub !== null) {
      event.preventDefault();
      event.stopPropagation();
      setTriggerSub(null);
      setHoverSummary(null);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    const index = Number(event.key) - 1;
    if (index >= 0 && index < SNOOZE_PICKER_TABS.length) {
      event.preventDefault();
      event.stopPropagation();
      const targetTab = SNOOZE_PICKER_TABS[index];
      if (targetTab) switchTab(targetTab);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window capture keydown listener for popover tab shortcuts and subview back
  useEffect(() => {
    globalThis.window.addEventListener("keydown", onWindowKeyDown, true);
    return () => globalThis.window.removeEventListener("keydown", onWindowKeyDown, true);
  }, []);

  const handleTabListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const currentIndex = SNOOZE_PICKER_TABS.indexOf(activeTab);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex =
      (currentIndex + delta + SNOOZE_PICKER_TABS.length) % SNOOZE_PICKER_TABS.length;
    const nextTab = SNOOZE_PICKER_TABS[nextIndex];
    if (!nextTab) return;
    switchTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  const tabItems: ReadonlyArray<{ readonly id: SnoozePickerTab; readonly label: string }> = [
    { id: "hours", label: gt("Hours") },
    { id: "interval", label: gt("Interval") },
    { id: "calendar", label: gt("Calendar") },
    { id: "trigger", label: gt("Trigger") },
  ];

  const hourOptions = resolveHourGridOptions(openedAt, formatTime, locale, messages);
  const customPreviewMinutes = customUnit === "hours" ? customVal * 60 : customVal;
  const customPreviewDate = new Date(openedAt.getTime() + customPreviewMinutes * 60_000);
  const customPreviewSummary = formatWakeSummary(
    customPreviewDate,
    openedAt,
    formatTime,
    locale,
    messages,
  );

  const intervalOptions = resolveIntervalOptions(
    openedAt,
    anchorHour,
    formatTime,
    locale,
    messages,
  );

  const startOfWeek = weekStartsOn ?? 1;
  const weekdayHeaders = [0, 1, 2, 3, 4, 5, 6].map((offset) => {
    const dayIndex = (startOfWeek + offset) % 7;
    // 2024-01-07 is Sunday, so adding dayIndex gives the exact weekday in UTC.
    const refDate = new Date(Date.UTC(2024, 0, 7 + dayIndex));
    return {
      key: dayIndex,
      label: new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(refDate),
    };
  });
  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
  }).format(new Date(calYear, calMonth, 1));
  const calendarCells = buildCalendarMonthCells(calYear, calMonth, openedAt, startOfWeek);
  const selectedCalendarIso = resolveCustomSnooze(
    { mode: "date", date: selectedDateKey, time: calTime },
    openedAt,
  );
  const selectedCalendarSummary = selectedCalendarIso
    ? formatWakeSummary(new Date(selectedCalendarIso), openedAt, formatTime, locale, messages)
    : gt("Choose a valid date and time in the future.");

  const prSubtitle = linkedPullRequestLabel
    ? gt("PR {pr}: CI, review, or merge", { pr: linkedPullRequestLabel })
    : gt("CI pass/fail, comment, or merge");

  const triggerEntries: ReadonlyArray<{
    readonly id: TriggerSubId;
    readonly title: string;
    readonly subtitle: string;
    readonly accent: boolean;
  }> = (
    hasLinkedPullRequest
      ? (["pr", "thread", "session", "webhook", "ai"] as const)
      : (["thread", "pr", "session", "webhook", "ai"] as const)
  ).map((id) => {
    switch (id) {
      case "pr":
        return {
          id,
          title: gt("PR checks or review"),
          subtitle: prSubtitle,
          accent: hasLinkedPullRequest,
        };
      case "thread":
        return {
          id,
          title: gt("Another thread finishes"),
          subtitle: gt("Wake when a running task settles"),
          accent: !hasLinkedPullRequest,
        };
      case "session":
        return {
          id,
          title: gt("Next active session"),
          subtitle: gt("Resurface next time you open Browne"),
          accent: false,
        };
      case "webhook":
        return {
          id,
          title: gt("External or webhook"),
          subtitle: gt("Email reply, message, or webhook ping"),
          accent: false,
        };
      case "ai":
        return {
          id,
          title: gt("Condition watch"),
          subtitle: gt("Wake when a condition becomes true"),
          accent: true,
        };
    }
  });

  const prChoices = [
    { id: "checks-pass", label: gt("Checks pass (green)") },
    { id: "checks-fail", label: gt("Checks fail") },
    { id: "new-review", label: gt("New review or comment") },
    { id: "merged", label: gt("PR merged") },
  ] as const;

  const webhookChoices = [
    { id: "email", label: gt("Email reply") },
    { id: "message", label: gt("Connected channel message") },
    { id: "webhook", label: gt("Inbound webhook ping") },
  ] as const;

  const fallbackOptions: ReadonlyArray<{ readonly id: TriggerFallback; readonly label: string }> = [
    { id: "none", label: gt("Off", { $context: "snooze fallback disabled" }) },
    { id: "24h", label: gt("24h", { $context: "snooze duration, 24 hours" }) },
    { id: "3d", label: gt("3d", { $context: "snooze duration, 3 days" }) },
    { id: "1w", label: gt("1w", { $context: "snooze duration, 1 week" }) },
  ];
  const activeFallbackLabel =
    fallbackOptions.find((item) => item.id === triggerFallback)?.label ?? "";

  const defaultTabSummary =
    activeTab === "hours"
      ? (hourOptions[4]?.wakeSummary ?? gt("Quick durations"))
      : activeTab === "interval"
        ? gt("Calendar milestones")
        : activeTab === "calendar"
          ? selectedCalendarSummary
          : gt("Event wakeups (preview)");

  const PrIcon = PullRequestGlyph.pullRequest;
  const renderTriggerIcon = (id: TriggerSubId) => {
    switch (id) {
      case "pr":
        return <PrIcon className="size-3.5" />;
      case "thread":
        return <MessageSquareIcon className="size-3.5" />;
      case "session":
        return <MonitorIcon className="size-3.5" />;
      case "webhook":
        return <Link2Icon className="size-3.5" />;
      case "ai":
        return <EyeIcon className="size-3.5" />;
    }
  };

  return (
    <div
      className="flex w-[296px] flex-col overflow-hidden text-popover-foreground select-none"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        role="tablist"
        aria-label={gt("Snooze mode")}
        onKeyDown={handleTabListKeyDown}
        className="grid grid-cols-4 gap-0.5 border-b border-border/70 bg-muted/55 p-1"
      >
        {tabItems.map((tab) => {
          const isActive = activeTab === tab.id;
          const isPriming = primingTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                tabRefs.current[tab.id] = node;
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              data-tab={tab.id}
              onPointerEnter={(event) => handleTabPointerEnter(tab.id, event)}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse") clearHoverTimer();
              }}
              onClick={() => switchTab(tab.id)}
              className={cn(
                "relative flex cursor-pointer items-center justify-center overflow-hidden rounded-md px-1 py-1.5 text-2xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                isActive
                  ? "bg-popover text-foreground shadow-xs ring-1 ring-border/70"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span>{tab.label}</span>
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute inset-x-1.5 bottom-0.5 h-0.5 origin-left rounded-full bg-primary transition-transform duration-120 ease-linear",
                  isPriming ? "scale-x-100 opacity-75" : "scale-x-0 opacity-0",
                )}
              />
            </button>
          );
        })}
      </div>

      <div className="flex min-h-[252px] flex-col justify-between gap-2 p-2">
        {activeTab === "hours" ? (
          <>
            <div className="grid grid-cols-3 gap-1.5">
              {hourOptions.map((option) => (
                <button
                  key={option.minutes}
                  type="button"
                  onMouseEnter={() => setHoverSummary(option.wakeSummary)}
                  onMouseLeave={() => setHoverSummary(null)}
                  onClick={() =>
                    commitSnooze(new Date(Date.now() + option.minutes * 60_000).toISOString())
                  }
                  className="flex cursor-pointer flex-col items-start gap-0.5 rounded-lg border border-border/80 bg-muted/25 px-2 py-2 text-left transition-colors hover:border-primary/50 hover:bg-accent active:scale-[0.98] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <div className="flex w-full items-center justify-between gap-1">
                    <span className="text-xs font-semibold text-foreground tabular-nums">
                      {option.shortLabel}
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        option.period === "day"
                          ? "bg-success/75"
                          : option.period === "evening"
                            ? "bg-warning/85"
                            : "bg-info/85",
                      )}
                    />
                  </div>
                  <span className="text-2xs whitespace-nowrap text-muted-foreground tabular-nums">
                    {option.timeLabel}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-1.5 rounded-lg border border-border/75 bg-muted/35 px-1.5 py-1.5">
              <div className="flex items-center gap-1">
                <Button
                  size="icon-micro"
                  variant="outline"
                  aria-label={gt("Decrease duration")}
                  onClick={() => {
                    const step = customUnit === "minutes" ? 5 : 1;
                    const min = customUnit === "minutes" ? 5 : 1;
                    setCustomVal((current) => Math.max(min, current - step));
                  }}
                >
                  <MinusIcon className="size-3" />
                </Button>
                <span className="min-w-6 text-center text-xs font-semibold text-foreground tabular-nums">
                  {customVal}
                </span>
                <Button
                  size="icon-micro"
                  variant="outline"
                  aria-label={gt("Increase duration")}
                  onClick={() => {
                    const step = customUnit === "minutes" ? 5 : 1;
                    const max = customUnit === "minutes" ? 90 : 48;
                    setCustomVal((current) => Math.min(max, current + step));
                  }}
                >
                  <PlusIcon className="size-3" />
                </Button>
                <Button
                  size="micro"
                  variant="outline"
                  onClick={() => {
                    if (customUnit === "hours") {
                      setCustomUnit("minutes");
                      setCustomVal(45);
                    } else {
                      setCustomUnit("hours");
                      setCustomVal(5);
                    }
                  }}
                >
                  {customUnit === "hours"
                    ? gt("hr", { $context: "hours unit, abbreviated" })
                    : gt("min", { $context: "minutes unit, abbreviated" })}
                </Button>
              </div>
              <Button
                size="xs"
                variant="default"
                onMouseEnter={() => setHoverSummary(customPreviewSummary)}
                onMouseLeave={() => setHoverSummary(null)}
                onClick={() => {
                  const snoozedUntil = resolveCustomSnooze(
                    {
                      mode: "duration",
                      amount: String(customVal),
                      unit: customUnit,
                    },
                    new Date(),
                  );
                  if (snoozedUntil) commitSnooze(snoozedUntil);
                }}
              >
                <span className="tabular-nums">{formatTime(customPreviewDate)}</span>
              </Button>
            </div>
          </>
        ) : null}

        {activeTab === "interval" ? (
          <>
            <div className="flex flex-col gap-0.5">
              {intervalOptions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => setHoverSummary(item.wakeSummary)}
                  onMouseLeave={() => setHoverSummary(null)}
                  onClick={() => {
                    if (Date.parse(item.snoozedUntil) <= Date.now()) {
                      toastManager.add({
                        type: "warning",
                        title: gt("Could not snooze thread"),
                        description: gt("That snooze time has passed. Choose another time."),
                      });
                      setOpenedAt(new Date());
                      return;
                    }
                    commitSnooze(item.snoozedUntil);
                  }}
                  className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="truncate font-medium">{item.label}</span>
                  <span className="shrink-0 text-2xs whitespace-nowrap text-muted-foreground tabular-nums">
                    {item.whenLabel}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-1.5 border-t border-border/70 pt-1.5">
              <span className="text-2xs whitespace-nowrap text-muted-foreground">
                <T>Wake at</T>
              </span>
              <div className="flex items-center gap-1">
                {INTERVAL_ANCHOR_HOURS.map((hour) => {
                  const isSelected = anchorHour === hour;
                  return (
                    <button
                      key={hour}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => setAnchorHour(hour)}
                      className={cn(
                        "cursor-pointer rounded-md border px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {formatShortHourPill(hour, timestampFormat, locale)}
                    </button>
                  );
                })}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-muted"
                        aria-label={gt("Edit snooze options")}
                        onClick={() => {
                          onClose();
                          if (onOpenSnoozeSettings) {
                            onOpenSnoozeSettings();
                          } else {
                            void navigate({
                              to: "/settings/threads",
                              hash: "snooze-options",
                            });
                          }
                        }}
                      />
                    }
                  >
                    <Settings2Icon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup>
                    <T>Edit snooze options</T>
                  </TooltipPopup>
                </Tooltip>
              </div>
            </div>
          </>
        ) : null}

        {activeTab === "calendar" ? (
          <>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between px-0.5 pb-0.5">
                <span className="text-xs font-semibold text-foreground">{monthLabel}</span>
                <div className="flex items-center gap-0.5">
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={gt("Previous month")}
                    onClick={() => {
                      if (calMonth === 0) {
                        setCalMonth(11);
                        setCalYear((year) => year - 1);
                      } else {
                        setCalMonth((month) => month - 1);
                      }
                    }}
                  >
                    <ChevronLeftIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={gt("Next month")}
                    onClick={() => {
                      if (calMonth === 11) {
                        setCalMonth(0);
                        setCalYear((year) => year + 1);
                      } else {
                        setCalMonth((month) => month + 1);
                      }
                    }}
                  >
                    <ChevronRightIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-7 gap-0.5 text-center">
                {weekdayHeaders.map((weekday) => (
                  <div
                    key={weekday.key}
                    className="py-0.5 text-3xs font-medium text-muted-foreground"
                  >
                    {weekday.label}
                  </div>
                ))}
                {calendarCells.map((cell) => {
                  const isSelected = cell.dateKey === selectedDateKey;
                  const busyCount = busyDays.get(cell.dateKey) ?? 0;
                  const cellHoverText = (() => {
                    const iso = resolveCustomSnooze(
                      { mode: "date", date: cell.dateKey, time: calTime },
                      openedAt,
                    );
                    if (!iso) return null;
                    const summary = formatWakeSummary(
                      new Date(iso),
                      openedAt,
                      formatTime,
                      locale,
                      messages,
                    );
                    return busyCount > 0
                      ? gt("{summary} ({count} snoozed)", { summary, count: busyCount })
                      : summary;
                  })();

                  return (
                    <button
                      key={cell.dateKey}
                      type="button"
                      disabled={cell.isPast}
                      aria-label={cell.dateKey}
                      aria-pressed={isSelected}
                      onMouseEnter={() => {
                        if (cellHoverText) setHoverSummary(cellHoverText);
                      }}
                      onMouseLeave={() => setHoverSummary(null)}
                      onClick={() => {
                        setSelectedDateKey(cell.dateKey);
                        setCalendarError(null);
                      }}
                      className={cn(
                        "relative inline-flex h-[25px] items-center justify-center rounded-md text-2xs tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        cell.isPast
                          ? "cursor-not-allowed text-muted-foreground/35"
                          : isSelected
                            ? "cursor-pointer bg-primary font-semibold text-primary-foreground"
                            : cell.isToday
                              ? "cursor-pointer border border-border font-semibold text-foreground hover:bg-accent"
                              : cell.inCurrentMonth
                                ? "cursor-pointer text-foreground hover:bg-accent"
                                : "cursor-pointer text-muted-foreground/45 hover:bg-accent",
                      )}
                    >
                      <span>{cell.day}</span>
                      {busyCount > 0 ? (
                        <span
                          aria-hidden="true"
                          className={cn(
                            "absolute bottom-0.5 size-1 rounded-full",
                            isSelected ? "bg-primary-foreground" : "bg-info",
                          )}
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-col gap-1 border-t border-border/70 pt-1.5">
              {calendarError ? (
                <p role="alert" className="text-2xs text-destructive">
                  {calendarError}
                </p>
              ) : null}
              <div className="flex items-center justify-between gap-1">
                <div className="flex items-center gap-0.5">
                  {CALENDAR_QUICK_TIMES.map((timeStr) => {
                    const isSelected = calTime === timeStr;
                    const hour = Number(timeStr.slice(0, 2));
                    return (
                      <button
                        key={timeStr}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => {
                          setCalTime(timeStr);
                          setCalendarError(null);
                        }}
                        className={cn(
                          "cursor-pointer rounded-md border px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-transparent text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {formatShortHourPill(hour, timestampFormat, locale)}
                      </button>
                    );
                  })}
                </div>
                <div className="w-[96px] shrink-0">
                  <Input
                    nativeInput
                    size="compact"
                    font="mono"
                    type="time"
                    aria-label={gt("Snooze time")}
                    value={calTime}
                    onChange={(event) => {
                      setCalTime(event.target.value);
                      setCalendarError(null);
                    }}
                  />
                </div>
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => {
                    const snoozedUntil = resolveCustomSnooze(
                      { mode: "date", date: selectedDateKey, time: calTime },
                      new Date(),
                    );
                    if (!snoozedUntil) {
                      setCalendarError(gt("Choose a valid date and time in the future."));
                      return;
                    }
                    commitSnooze(snoozedUntil);
                  }}
                >
                  <T context="verb">Set</T>
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {activeTab === "trigger" && triggerSub === null ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between px-1 pb-0.5">
              <span className="text-2xs font-medium text-muted-foreground">
                <T>Wake on event</T>
              </span>
              <Badge variant="secondary" size="sm">
                <T>Preview</T>
              </Badge>
            </div>
            <div className="flex flex-col gap-0.5">
              {triggerEntries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onMouseEnter={() => setHoverSummary(entry.title)}
                  onMouseLeave={() => setHoverSummary(null)}
                  onClick={() => {
                    setTriggerSub(entry.id);
                    setHoverSummary(null);
                  }}
                  className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <span
                      className={cn(
                        "mt-0.5 inline-flex size-5.5 shrink-0 items-center justify-center rounded-md",
                        entry.accent ? "bg-primary/12 text-primary" : "bg-muted text-foreground",
                      )}
                    >
                      {renderTriggerIcon(entry.id)}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-foreground">
                        {entry.title}
                      </div>
                      <div className="truncate text-2xs text-muted-foreground">
                        {entry.subtitle}
                      </div>
                    </div>
                  </div>
                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {activeTab === "trigger" && triggerSub !== null ? (
          <>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 border-b border-border/70 pb-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => {
                      setTriggerSub(null);
                      setHoverSummary(null);
                    }}
                  >
                    <ChevronLeftIcon className="size-3" />
                    <T>Back</T>
                  </Button>
                  <span className="truncate text-xs font-semibold text-foreground">
                    {triggerEntries.find((entry) => entry.id === triggerSub)?.title}
                  </span>
                </div>
                <Badge variant="secondary" size="sm">
                  <T>Preview</T>
                </Badge>
              </div>

              {triggerSub === "thread" ? (
                <div className="flex flex-col gap-1">
                  {threadCandidates.length > 0 ? (
                    threadCandidates.map((candidate) => {
                      const isSelected = selectedThreadId === candidate.id;
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => setSelectedThreadId(candidate.id)}
                          className={cn(
                            "flex w-full cursor-pointer items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-2xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                            isSelected
                              ? "border-primary bg-accent font-medium text-foreground"
                              : "border-border bg-popover text-foreground hover:bg-accent/60",
                          )}
                        >
                          <span className="truncate">{candidate.title}</span>
                          {candidate.isActive ? (
                            <span className="shrink-0 text-3xs text-muted-foreground">
                              <T>running</T>
                            </span>
                          ) : null}
                        </button>
                      );
                    })
                  ) : (
                    <p className="px-1 py-2 text-2xs text-muted-foreground">
                      <T>No other active threads in this environment.</T>
                    </p>
                  )}
                </div>
              ) : null}

              {triggerSub === "pr" ? (
                <div className="flex flex-col gap-1">
                  {prChoices.map((choice) => {
                    const isSelected = selectedPrEvent === choice.id;
                    return (
                      <button
                        key={choice.id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => setSelectedPrEvent(choice.id)}
                        className={cn(
                          "flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1.5 text-left text-2xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          isSelected
                            ? "border-primary bg-accent font-medium text-foreground"
                            : "border-border bg-popover text-foreground hover:bg-accent/60",
                        )}
                      >
                        <span>{choice.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {triggerSub === "session" ? (
                <p className="px-1 py-1 text-2xs leading-relaxed text-muted-foreground">
                  <T>Resurfaces when a new Browne window or session becomes active.</T>
                </p>
              ) : null}

              {triggerSub === "webhook" ? (
                <div className="flex flex-col gap-1">
                  {webhookChoices.map((choice) => {
                    const isSelected = selectedWebhookSource === choice.id;
                    return (
                      <button
                        key={choice.id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => setSelectedWebhookSource(choice.id)}
                        className={cn(
                          "flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1.5 text-left text-2xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          isSelected
                            ? "border-primary bg-accent font-medium text-foreground"
                            : "border-border bg-popover text-foreground hover:bg-accent/60",
                        )}
                      >
                        <span>{choice.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {triggerSub === "ai" ? (
                <div className="flex flex-col gap-1.5">
                  <Input
                    size="compact"
                    value={aiConditionText}
                    onChange={(event) => setAiConditionText(event.target.value)}
                    placeholder={gt("Wake when...")}
                    aria-label={gt("Wake condition")}
                  />
                  <p className="text-2xs leading-snug text-muted-foreground">
                    <T>Checks periodically and resurfaces when matched.</T>
                  </p>
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5 border-t border-border/70 pt-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs text-muted-foreground">
                  <T>Max wait</T>
                </span>
                <div className="flex items-center gap-1">
                  {fallbackOptions.map((item) => {
                    const isSelected = triggerFallback === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => setTriggerFallback(item.id)}
                        className={cn(
                          "cursor-pointer rounded-md border px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-transparent text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid">
                <Button
                  size="xs"
                  variant={triggerFallback === "none" ? "outline" : "default"}
                  disabled={triggerFallback === "none"}
                  onClick={() => {
                    const wakeAt = resolveFallbackSnoozeUntil(triggerFallback, new Date());
                    if (wakeAt) commitSnooze(wakeAt);
                  }}
                >
                  {triggerFallback === "none" ? (
                    <T>Select a max wait to snooze</T>
                  ) : (
                    <T>
                      Snooze (<Var>{activeFallbackLabel}</Var> max wait)
                    </T>
                  )}
                </Button>
              </div>
              <p className="text-center text-3xs text-muted-foreground">
                <T>Event triggers are preview only. Max wait sets a real timer.</T>
              </p>
            </div>
          </>
        ) : null}
      </div>

      <div className="flex min-h-7 items-center justify-between gap-2 border-t border-border/70 bg-muted/35 px-2.5 py-1 text-2xs text-muted-foreground tabular-nums">
        <span className="min-w-0 truncate font-medium text-foreground">
          {hoverSummary ?? defaultTabSummary}
        </span>
        <span className="shrink-0 opacity-75">
          <T>
            Hover · <Var>{TAB_SHORTCUT_HINT}</Var>
          </T>
        </span>
      </div>
    </div>
  );
}
