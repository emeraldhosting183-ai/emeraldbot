import { DateTime } from "luxon";

export interface WorkSchedule {
  enabled: boolean;
  timezone: string;
  startMinute: number;
  endMinute: number;
  days: string;
}

export function parseScheduleDays(value: string): ReadonlySet<number> {
  const days = value
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return new Set(days);
}

export function isWithinSchedule(
  schedule: WorkSchedule,
  at = new Date(),
): boolean {
  if (!schedule.enabled) {
    return true;
  }

  const local = DateTime.fromJSDate(at, { zone: schedule.timezone });
  if (!local.isValid) {
    return false;
  }

  const weekday = local.weekday % 7;
  if (!parseScheduleDays(schedule.days).has(weekday)) {
    return false;
  }

  const minute = local.hour * 60 + local.minute;
  if (schedule.startMinute === schedule.endMinute) {
    return true;
  }

  if (schedule.startMinute < schedule.endMinute) {
    return minute >= schedule.startMinute && minute < schedule.endMinute;
  }

  return minute >= schedule.startMinute || minute < schedule.endMinute;
}

export function parseClock(value: string): number | undefined {
  const match = /^(?<hour>\d{1,2}):(?<minute>\d{2})$/u.exec(value);
  if (!match?.groups) {
    return undefined;
  }

  const hour = Number.parseInt(match.groups.hour ?? "", 10);
  const minute = Number.parseInt(match.groups.minute ?? "", 10);
  if (hour > 23 || minute > 59) {
    return undefined;
  }
  return hour * 60 + minute;
}

export function formatClock(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60).toString().padStart(2, "0");
  const minutes = (normalized % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}
