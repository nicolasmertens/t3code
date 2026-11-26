// @effect-diagnostics globalDate:off -- Snooze picker uses local calendar boundaries and Intl labels.
import { localSnoozeDate } from "@t3tools/client-runtime/state/thread-settled";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export const SNOOZE_PICKER_TABS = ["hours", "interval", "calendar", "trigger"] as const;
export type SnoozePickerTab = (typeof SNOOZE_PICKER_TABS)[number];

const HOURS_PRESET_MINUTES = [15, 30, 60, 120, 180, 240, 360, 480, 720] as const;

export type TimeOfDayPeriod = "day" | "evening" | "night";

export interface HourGridOption {
  readonly minutes: number;
  readonly shortLabel: string;
  readonly timeLabel: string;
  readonly period: TimeOfDayPeriod;
  readonly snoozedUntil: string;
  readonly wakeSummary: string;
}

export const INTERVAL_ANCHOR_HOURS = [9, 13, 18] as const;
export type IntervalAnchorHour = (typeof INTERVAL_ANCHOR_HOURS)[number];

export interface IntervalOption {
  readonly id: string;
  readonly label: string;
  readonly whenLabel: string;
  readonly snoozedUntil: string;
  readonly wakeSummary: string;
}

export interface CalendarMonthCell {
  readonly dateKey: string;
  readonly day: number;
  readonly inCurrentMonth: boolean;
  readonly isPast: boolean;
  readonly isToday: boolean;
}

const TRIGGER_FALLBACKS = ["none", "24h", "3d", "1w"] as const;
export type TriggerFallback = (typeof TRIGGER_FALLBACKS)[number];

const DAY_MS = 86_400_000;

function localDayIndex(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

function atLocalHour(base: Date, addDays: number, hour: number): Date {
  const next = new Date(base.getTime());
  next.setDate(next.getDate() + addDays);
  next.setHours(hour, 0, 0, 0);
  return next;
}

function formatWeekdayShort(date: Date, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
}

function formatMonthDayShort(date: Date, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
}

export function timeOfDayPeriod(date: Date): TimeOfDayPeriod {
  const hour = date.getHours();
  if (hour >= 6 && hour < 17) return "day";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

export function formatWakeSummary(
  wakeDate: Date,
  now: Date,
  formatTime: (date: Date) => string,
  locale: string | undefined,
  resolve: MessageResolver = m,
): string {
  const dayDiff = localDayIndex(wakeDate) - localDayIndex(now);
  const time = formatTime(wakeDate);
  if (dayDiff === 0) return resolve(msg("Today at {time}", { time }));
  if (dayDiff === 1) return resolve(msg("Tomorrow at {time}", { time }));
  const dateLabel = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(wakeDate);
  return resolve(msg("{date} at {time}", { date: dateLabel, time }));
}

export function resolveHourGridOptions(
  now: Date,
  formatTime: (date: Date) => string,
  locale: string | undefined,
  resolve: MessageResolver = m,
): ReadonlyArray<HourGridOption> {
  return HOURS_PRESET_MINUTES.map((minutes) => {
    const wake = new Date(now.getTime() + minutes * 60_000);
    const shortLabel =
      minutes < 60
        ? resolve(msg("{count}m", { count: minutes, $context: "snooze duration tile, minutes" }))
        : resolve(
            msg("{count}h", { count: minutes / 60, $context: "snooze duration tile, hours" }),
          );
    return {
      minutes,
      shortLabel,
      timeLabel: formatTime(wake),
      period: timeOfDayPeriod(wake),
      snoozedUntil: wake.toISOString(),
      wakeSummary: formatWakeSummary(wake, now, formatTime, locale, resolve),
    };
  });
}

export function resolveIntervalOptions(
  now: Date,
  anchorHour: IntervalAnchorHour,
  formatTime: (date: Date) => string,
  locale: string | undefined,
  resolve: MessageResolver = m,
): ReadonlyArray<IntervalOption> {
  const hour = now.getHours();
  const minute = now.getMinutes();

  const laterTodayWake =
    hour < 12 || (hour === 12 && minute < 30)
      ? atLocalHour(now, 0, 13)
      : hour < 14 || (hour === 14 && minute < 30)
        ? atLocalHour(now, 0, 15)
        : null;

  const thisEveningWake =
    hour < 17 || (hour === 17 && minute < 30) ? atLocalHour(now, 0, 18) : null;

  const tomorrowWake = atLocalHour(now, 1, anchorHour);

  const dayOfWeek = now.getDay();
  const weekendWake =
    dayOfWeek === 6 && hour < 10
      ? atLocalHour(now, 0, 10)
      : dayOfWeek === 6
        ? atLocalHour(now, 1, 10)
        : atLocalHour(now, (6 - dayOfWeek + 7) % 7 || 7, 10);

  const daysToMonday = (1 - dayOfWeek + 7) % 7 || 7;
  // On Sunday, Monday is already Tomorrow, so jump to the following Monday.
  const nextMondayWake = atLocalHour(now, daysToMonday === 1 ? 8 : daysToMonday, anchorHour);

  const inTwoWeeksWake = atLocalHour(now, 14, anchorHour);

  let nextMonthWake = new Date(now.getFullYear(), now.getMonth() + 1, 1, anchorHour, 0, 0, 0);
  if (
    Math.floor(nextMonthWake.getTime() / 60_000) === Math.floor(tomorrowWake.getTime() / 60_000)
  ) {
    nextMonthWake = new Date(now.getFullYear(), now.getMonth() + 2, 1, anchorHour, 0, 0, 0);
  }

  const candidates: Array<{
    readonly id: string;
    readonly label: string;
    readonly wake: Date | null;
    readonly whenMode: "time" | "weekday" | "date";
  }> = [
    {
      id: "later-today",
      label: resolve(msg("Later today")),
      wake: laterTodayWake,
      whenMode: "time",
    },
    {
      id: "this-evening",
      label: resolve(msg("This evening")),
      wake: thisEveningWake,
      whenMode: "time",
    },
    {
      id: "tomorrow",
      label: resolve(msg("Tomorrow")),
      wake: tomorrowWake,
      whenMode: "weekday",
    },
    {
      id: "this-weekend",
      label: resolve(msg("This weekend")),
      wake: weekendWake,
      whenMode: "weekday",
    },
    {
      id: "next-monday",
      label: resolve(msg("Next Monday")),
      wake: nextMondayWake,
      whenMode: "date",
    },
    {
      id: "in-2-weeks",
      label: resolve(msg("In 2 weeks")),
      wake: inTwoWeeksWake,
      whenMode: "date",
    },
    {
      id: "next-month",
      label: resolve(msg("Next month")),
      wake: nextMonthWake,
      whenMode: "date",
    },
  ];

  const seenMinutes = new Set<number>();
  const results: IntervalOption[] = [];

  for (const candidate of candidates) {
    if (candidate.wake === null) continue;
    if (candidate.wake.getTime() <= now.getTime()) continue;
    const wakeMinute = Math.floor(candidate.wake.getTime() / 60_000);
    if (seenMinutes.has(wakeMinute)) continue;
    seenMinutes.add(wakeMinute);

    const time = formatTime(candidate.wake);
    const whenLabel =
      candidate.whenMode === "time"
        ? time
        : candidate.whenMode === "weekday"
          ? `${formatWeekdayShort(candidate.wake, locale)} ${time}`
          : `${formatMonthDayShort(candidate.wake, locale)}, ${time}`;

    results.push({
      id: candidate.id,
      label: candidate.label,
      whenLabel,
      snoozedUntil: candidate.wake.toISOString(),
      wakeSummary: formatWakeSummary(candidate.wake, now, formatTime, locale, resolve),
    });
  }

  return results;
}

export function buildCalendarMonthCells(
  year: number,
  month: number,
  today: Date,
  weekStartsOn: number = 1,
): ReadonlyArray<CalendarMonthCell> {
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const todayKey = localSnoozeDate(todayStart);
  const firstOfMonth = new Date(year, month, 1);
  const leadingDays = (firstOfMonth.getDay() - weekStartsOn + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((leadingDays + daysInMonth) / 7) * 7;

  const cells: CalendarMonthCell[] = [];
  for (let index = 0; index < totalCells; index += 1) {
    const cellDate = new Date(year, month, 1 - leadingDays + index);
    const dateKey = localSnoozeDate(cellDate);
    cells.push({
      dateKey,
      day: cellDate.getDate(),
      inCurrentMonth: cellDate.getMonth() === month && cellDate.getFullYear() === year,
      isPast: cellDate.getTime() < todayStart.getTime(),
      isToday: dateKey === todayKey,
    });
  }
  return cells;
}

export function collectBusySnoozeDayCounts(
  threads: ReadonlyArray<{
    readonly snoozedUntil?: string | null;
    readonly archivedAt?: string | null;
    readonly deletedAt?: string | null;
  }>,
  nowMs: number,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (thread.archivedAt != null || thread.deletedAt != null || thread.snoozedUntil == null) {
      continue;
    }
    const wakeMs = Date.parse(thread.snoozedUntil);
    if (Number.isNaN(wakeMs) || wakeMs <= nowMs) continue;
    const key = localSnoozeDate(new Date(wakeMs));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function resolveFallbackSnoozeUntil(fallback: TriggerFallback, now: Date): string | null {
  if (fallback === "none") return null;
  if (fallback === "24h") return new Date(now.getTime() + 24 * 3_600_000).toISOString();
  const days = fallback === "3d" ? 3 : 7;
  const next = new Date(now.getTime());
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

export function defaultCalendarDateKey(now: Date): string {
  const daysToMonday = (1 - now.getDay() + 7) % 7 || 7;
  const next = new Date(now.getTime());
  next.setDate(next.getDate() + (daysToMonday === 1 ? 8 : daysToMonday));
  return localSnoozeDate(next);
}
