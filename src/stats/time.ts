/**
 * Time-zone helpers for voice stats. The only module that talks to Intl; everything else
 * works in epoch ms plus the local parts returned here.
 */
import type { Ms, Weekday } from './types.js';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export interface LocalParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number; // 0-23
  readonly minute: number;
  readonly second: number;
  /** Monday = 0 ... Sunday = 6. */
  readonly weekday: Weekday;
  /** 'YYYY-MM-DD' local. */
  readonly dateKey: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Local calendar parts of an instant in `timeZone`. */
export function localParts(ms: Ms, timeZone: string): LocalParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const year = values.year ?? 1970;
  const month = values.month ?? 1;
  const day = values.day ?? 1;
  // h23 can still yield 24 at midnight on some engines; normalise.
  const hour = (values.hour ?? 0) % 24;
  const dateKey = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  // Weekday from the local calendar date (UTC math on the date only): 1970-01-05 was a Monday.
  const weekday = ((((Date.UTC(year, month - 1, day) / DAY_MS - 4) % 7) + 7) % 7) as Weekday;
  return { year, month, day, hour, minute: values.minute ?? 0, second: values.second ?? 0, weekday, dateKey };
}

/** 'YYYY-MM-DD' local date of an instant. */
export function dateKeyOf(ms: Ms, timeZone: string): string {
  return localParts(ms, timeZone).dateKey;
}

/** The next local top-of-hour strictly after `ms`. */
export function nextLocalHour(ms: Ms, timeZone: string): Ms {
  const p = localParts(ms, timeZone);
  const intoHour = (p.minute * 60 + p.second) * 1000 + (((ms % 1000) + 1000) % 1000);
  return ms - intoHour + HOUR_MS;
}

/**
 * Split [start, end) at local hour boundaries and call `fn` for every non-empty slice with
 * the local parts of the slice start. Slices never cross a local hour.
 */
export function forEachLocalHourSlice(
  start: Ms,
  end: Ms,
  timeZone: string,
  fn: (sliceStart: Ms, sliceEnd: Ms, parts: LocalParts) => void,
): void {
  let t = start;
  while (t < end) {
    const parts = localParts(t, timeZone);
    const intoHour = (parts.minute * 60 + parts.second) * 1000 + (((t % 1000) + 1000) % 1000);
    const next = Math.min(end, t - intoHour + HOUR_MS);
    fn(t, next, parts);
    t = next;
  }
}

/** Shift a 'YYYY-MM-DD' key by whole calendar days. */
export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Whole calendar days from a to b ('YYYY-MM-DD'); positive when b is later. */
export function daysBetween(a: string, b: string): number {
  const toUtc = (key: string) => {
    const [y, m, d] = key.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

/** True when `timeZone` is a valid IANA zone for Intl. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
