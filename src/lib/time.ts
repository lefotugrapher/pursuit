// Time helpers. All stored timestamps are UTC ISO strings (Date#toISOString), so they compare
// lexicographically. "Today" and daily caps use Europe/Dublin calendar days.

import type { Settings } from './types';

export const TZ = 'Europe/Dublin';
const DAY_MS = 86_400_000;

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: string }

export function nowIso(): string {
  return new Date().toISOString();
}

/** Parses Date | ISO-ish string | epoch ms into a Date; undefined when invalid. */
export function toDate(value: Date | string | number | null | undefined): Date | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Normalises to a UTC ISO string; undefined when unparseable. */
export function toIso(value: Date | string | number | null | undefined): string | undefined {
  return toDate(value)?.toISOString();
}

export function dublinParts(date: Date = new Date()): ZonedParts {
  const map: Record<string, string> = {};
  for (const p of partsFormatter.formatToParts(date)) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: map.weekday ?? '',
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Dublin calendar date, 'YYYY-MM-DD'. */
export function dublinDate(date: Date = new Date()): string {
  const p = dublinParts(date);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function todayDublin(): string {
  return dublinDate(new Date());
}

/** Dublin wall-clock time, 'HH:MM'. */
export function dublinClock(date: Date = new Date()): string {
  const p = dublinParts(date);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Dublin local minus UTC, in ms, at the given instant (0 in winter, +1h in summer). */
function dublinOffsetMs(date: Date): number {
  const p = dublinParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant of 00:00 Dublin time on the calendar date 'YYYY-MM-DD'. */
export function dublinMidnight(ymd: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new Error(`Expected YYYY-MM-DD, got ${JSON.stringify(ymd)}`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const first = guess - dublinOffsetMs(new Date(guess));
  const second = guess - dublinOffsetMs(new Date(first)); // settles the DST-change edge
  return new Date(second);
}

/** Start of the Dublin day containing `date`. */
export function startOfDayDublin(date: Date = new Date()): Date {
  return dublinMidnight(dublinDate(date));
}

/** Calendar arithmetic on 'YYYY-MM-DD' strings (timezone-free). */
export function addDays(ymd: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new Error(`Expected YYYY-MM-DD, got ${JSON.stringify(ymd)}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** ISO instant of Dublin midnight `days` calendar days before today (0 = start of today). */
export function dublinDayStartIso(daysAgo = 0, now: Date = new Date()): string {
  return dublinMidnight(addDays(dublinDate(now), -daysAgo)).toISOString();
}

/** 'HH:MM' → minutes since midnight; null when malformed. */
export function parseHHMM(value: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value?.trim() ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * True inside settings.quietHours (Dublin time). The window may wrap midnight
 * (22:00–08:00). start === end or malformed values mean "no quiet hours".
 */
export function isQuietHours(settings: Pick<Settings, 'quietHours'>, date: Date = new Date()): boolean {
  const start = parseHHMM(settings.quietHours?.start ?? '');
  const end = parseHHMM(settings.quietHours?.end ?? '');
  if (start === null || end === null || start === end) return false;
  const p = dublinParts(date);
  const now = p.hour * 60 + p.minute;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Fractional days from `a` to `b` (positive when b is later). NaN if either is invalid. */
export function daysBetween(a: Date | string | number, b: Date | string | number = new Date()): number {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return Number.NaN;
  return (db.getTime() - da.getTime()) / DAY_MS;
}
