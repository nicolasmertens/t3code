// @effect-diagnostics globalDate:off -- Unit tests exercise fixed local calendar dates and Intl time labels.
import { describe, expect, it } from "vite-plus/test";

import {
  buildCalendarMonthCells,
  collectBusySnoozeDayCounts,
  defaultCalendarDateKey,
  formatWakeSummary,
  resolveFallbackSnoozeUntil,
  resolveHourGridOptions,
  resolveIntervalOptions,
  timeOfDayPeriod,
} from "./snoozePicker.logic";

const formatTestTime = (date: Date) =>
  date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

describe("snoozePicker.logic", () => {
  const thursdayMorning = new Date(2026, 10, 26, 8, 32, 0);

  it("resolves all 9 hour grid options with time-of-day periods", () => {
    const options = resolveHourGridOptions(thursdayMorning, formatTestTime, "en-US");
    expect(options).toHaveLength(9);
    expect(options.map((item) => item.shortLabel)).toEqual([
      "15m",
      "30m",
      "1h",
      "2h",
      "3h",
      "4h",
      "6h",
      "8h",
      "12h",
    ]);
    expect(options[0]).toMatchObject({
      minutes: 15,
      period: "day",
      timeLabel: "8:47 AM",
      wakeSummary: "Today at 8:47 AM",
    });
    expect(options[8]).toMatchObject({
      minutes: 720,
      period: "evening",
      timeLabel: "8:32 PM",
      wakeSummary: "Today at 8:32 PM",
    });

    expect(timeOfDayPeriod(new Date(2026, 10, 26, 22, 0, 0))).toBe("night");
    expect(timeOfDayPeriod(new Date(2026, 10, 26, 4, 30, 0))).toBe("night");
    expect(timeOfDayPeriod(new Date(2026, 10, 26, 18, 0, 0))).toBe("evening");
    expect(timeOfDayPeriod(new Date(2026, 10, 26, 9, 0, 0))).toBe("day");
  });

  it("resolves interval options for morning and updates cleanly with anchor hour", () => {
    const atNine = resolveIntervalOptions(thursdayMorning, 9, formatTestTime, "en-US");
    expect(atNine.map((item) => item.id)).toEqual([
      "later-today",
      "this-evening",
      "tomorrow",
      "this-weekend",
      "next-monday",
      "in-2-weeks",
      "next-month",
    ]);
    expect(atNine.find((item) => item.id === "later-today")?.whenLabel).toBe("1:00 PM");
    expect(atNine.find((item) => item.id === "tomorrow")?.whenLabel).toBe("Fri 9:00 AM");
    expect(atNine.find((item) => item.id === "this-weekend")?.whenLabel).toBe("Sat 10:00 AM");
    expect(atNine.find((item) => item.id === "next-monday")?.whenLabel).toBe("Nov 30, 9:00 AM");
    expect(atNine.find((item) => item.id === "in-2-weeks")?.whenLabel).toBe("Dec 10, 9:00 AM");
    expect(atNine.find((item) => item.id === "next-month")?.whenLabel).toBe("Dec 1, 9:00 AM");

    const atEvening = resolveIntervalOptions(thursdayMorning, 18, formatTestTime, "en-US");
    expect(atEvening.find((item) => item.id === "tomorrow")?.whenLabel).toBe("Fri 6:00 PM");
    expect(atEvening.find((item) => item.id === "next-monday")?.whenLabel).toBe("Nov 30, 6:00 PM");
  });

  it("omits passed today anchors after 17:30 and avoids duplicate Monday/Tomorrow on Sunday", () => {
    const sundayEvening = new Date(2026, 10, 29, 18, 0, 0);
    const options = resolveIntervalOptions(sundayEvening, 9, formatTestTime, "en-US");
    expect(options.map((item) => item.id)).not.toContain("later-today");
    expect(options.map((item) => item.id)).not.toContain("this-evening");
    const tomorrow = options.find((item) => item.id === "tomorrow");
    const nextMonday = options.find((item) => item.id === "next-monday");
    const nextMonth = options.find((item) => item.id === "next-month");
    expect(tomorrow?.whenLabel).toBe("Mon 9:00 AM");
    expect(nextMonday?.whenLabel).toBe("Dec 7, 9:00 AM");
    expect(nextMonth?.whenLabel).toBe("Dec 1, 9:00 AM");

    const minuteSet = new Set(
      options.map((item) => Math.floor(Date.parse(item.snoozedUntil) / 60_000)),
    );
    expect(minuteSet.size).toBe(options.length);

    // On the last day of November, Tomorrow is Dec 1, so Next month advances to Jan 1.
    const monthEnd = new Date(2026, 10, 30, 10, 0, 0);
    const monthEndOptions = resolveIntervalOptions(monthEnd, 9, formatTestTime, "en-US");
    expect(monthEndOptions.find((item) => item.id === "tomorrow")?.whenLabel).toBe("Tue 9:00 AM");
    expect(monthEndOptions.find((item) => item.id === "next-month")?.whenLabel).toBe(
      "Jan 1, 9:00 AM",
    );
  });

  it("builds whole-week calendar grids respecting weekStartsOn and past-day flags", () => {
    const cells = buildCalendarMonthCells(2026, 10, thursdayMorning, 1);
    expect(cells.length % 7).toBe(0);
    // Nov 1, 2026 is Sunday -> Monday-first grid leads with Oct 26..Nov 1 (6 Oct days + 30 Nov days = 36 -> 42 cells).
    expect(cells[0]).toMatchObject({
      dateKey: "2026-10-26",
      day: 26,
      inCurrentMonth: false,
      isPast: true,
      isToday: false,
    });
    const todayCell = cells.find((cell) => cell.dateKey === "2026-11-26");
    expect(todayCell).toMatchObject({
      inCurrentMonth: true,
      isPast: false,
      isToday: true,
    });
    const nov25 = cells.find((cell) => cell.dateKey === "2026-11-25");
    expect(nov25?.isPast).toBe(true);
    const nov27 = cells.find((cell) => cell.dateKey === "2026-11-27");
    expect(nov27?.isPast).toBe(false);
  });

  it("counts future active snoozed threads per local date and ignores past/archived/deleted", () => {
    const futureA = new Date(2026, 10, 30, 9, 0, 0).toISOString();
    const futureB = new Date(2026, 10, 30, 14, 0, 0).toISOString();
    const past = new Date(2026, 10, 25, 9, 0, 0).toISOString();

    const counts = collectBusySnoozeDayCounts(
      [
        { snoozedUntil: futureA, archivedAt: null, deletedAt: null },
        { snoozedUntil: futureB, archivedAt: null, deletedAt: null },
        { snoozedUntil: past, archivedAt: null, deletedAt: null },
        { snoozedUntil: futureA, archivedAt: "2026-11-26T00:00:00Z", deletedAt: null },
        { snoozedUntil: futureA, archivedAt: null, deletedAt: "2026-11-26T00:00:00Z" },
        { snoozedUntil: null, archivedAt: null, deletedAt: null },
      ],
      thursdayMorning.getTime(),
    );

    expect(counts.get("2026-11-30")).toBe(2);
    expect(counts.has("2026-11-25")).toBe(false);
  });

  it("resolves trigger fallback timers and wake summaries", () => {
    expect(resolveFallbackSnoozeUntil("none", thursdayMorning)).toBeNull();
    expect(resolveFallbackSnoozeUntil("24h", thursdayMorning)).toBe(
      new Date(thursdayMorning.getTime() + 24 * 3_600_000).toISOString(),
    );
    expect(resolveFallbackSnoozeUntil("3d", thursdayMorning)).toBe(
      new Date(2026, 10, 29, 8, 32, 0).toISOString(),
    );
    expect(resolveFallbackSnoozeUntil("1w", thursdayMorning)).toBe(
      new Date(2026, 11, 3, 8, 32, 0).toISOString(),
    );

    expect(defaultCalendarDateKey(thursdayMorning)).toBe("2026-11-30");
    expect(
      formatWakeSummary(new Date(2026, 10, 30, 9, 0, 0), thursdayMorning, formatTestTime, "en-US"),
    ).toBe("Mon, Nov 30 at 9:00 AM");
  });
});
