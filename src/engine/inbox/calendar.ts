// Detects proposed interview times in email text and builds Google Calendar "add event" links.
// All wall-clock times in emails are read as Europe/Dublin. Nothing here touches the network.

import { addDays, dublinDate, dublinMidnight, dublinParts } from '@/lib/time';

export interface ProposedTime {
  raw: string;          // the text the time was read from
  start: string;        // ISO UTC (for all-day: Dublin midnight of that date)
  end: string;          // ISO UTC
  allDay: boolean;
  date: string;         // Dublin calendar date YYYY-MM-DD
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

const MONTH_ALT = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
const WEEKDAY_ALT = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun';

const DAY_MONTH = new RegExp(
  `\\b(?:(${WEEKDAY_ALT})\\.?,?\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_ALT})\\.?(?:,?\\s+(\\d{4}))?\\b`,
  'gi',
);
const MONTH_DAY = new RegExp(
  `\\b(?:(${WEEKDAY_ALT})\\.?,?\\s+)?(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  'gi',
);
// Irish order: day/month[/year].
const NUMERIC = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/g;
const WEEKDAY_ONLY = new RegExp(`\\b(?:(next|this|on)\\s+)?(${WEEKDAY_ALT})\\b`, 'gi');
const RELATIVE = /\b(today|tomorrow)\b/gi;

const MERIDIEM = '(am|pm|a\\.m\\.?|p\\.m\\.?)';
const TIME_RANGE = new RegExp(
  `(?<![€£$\\d.,:/])\\b(?:between\\s+)?(\\d{1,2})(?:[:.](\\d{2}))?(?!\\d)\\s*${MERIDIEM}?` +
    `(?:\\s*(?:-|–|to|and|until|till)\\s*(\\d{1,2})(?:[:.](\\d{2}))?(?!\\d)\\s*${MERIDIEM}?)?|\\b(noon|midday)\\b`,
  'gi',
);

const DEFAULT_DURATION_MIN = 60;
const PAIR_AFTER_CHARS = 45;
const PAIR_BEFORE_CHARS = 30;

interface DateMention { index: number; end: number; ymd: string; raw: string; needsTime?: boolean }
interface TimeMention { index: number; end: number; startMin: number; endMin?: number; raw: string }

const pad = (n: number) => String(n).padStart(2, '0');

function validYmd(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return undefined;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function weekdayOf(ymd: string): number {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay();
}

/** Year for a day/month without one: the nearest occurrence that isn't more than a week in the past. */
function inferYmd(month: number, day: number, ref: Date, weekday?: number): string | undefined {
  const refYmd = dublinDate(ref);
  const refYear = Number(refYmd.slice(0, 4));
  const candidates = [refYear, refYear + 1]
    .map((y) => validYmd(y, month, day))
    .filter((v): v is string => Boolean(v) && (v as string) >= addDays(refYmd, -7));
  if (!candidates.length) return undefined;
  if (weekday !== undefined) {
    const matching = candidates.find((c) => weekdayOf(c) === weekday);
    if (matching) return matching;
  }
  return candidates[0];
}

function explicitYmd(year: string | undefined, month: number, day: number, ref: Date, weekday?: number): string | undefined {
  if (!year) return inferYmd(month, day, ref, weekday);
  const y = Number(year.length === 2 ? `20${year}` : year);
  return validYmd(y, month, day);
}

function weekdayNumber(name: string | undefined): number | undefined {
  return name ? WEEKDAYS[name.toLowerCase().replace(/\.$/, '')] : undefined;
}

function findDates(text: string, ref: Date): DateMention[] {
  const found: DateMention[] = [];
  const push = (index: number, raw: string, ymd: string | undefined, needsTime = false) => {
    if (ymd) found.push({ index, end: index + raw.length, ymd, raw, needsTime });
  };

  for (const m of text.matchAll(DAY_MONTH)) {
    push(m.index, m[0], explicitYmd(m[4], MONTHS[m[3].toLowerCase()], Number(m[2]), ref, weekdayNumber(m[1])));
  }
  for (const m of text.matchAll(MONTH_DAY)) {
    push(m.index, m[0], explicitYmd(m[4], MONTHS[m[2].toLowerCase()], Number(m[3]), ref, weekdayNumber(m[1])));
  }
  for (const m of text.matchAll(NUMERIC)) {
    // Without a year, "24/7" or "1/2" are too ambiguous unless a time sits next to them.
    push(m.index, m[0], explicitYmd(m[3], Number(m[2]), Number(m[1]), ref), !m[3]);
  }
  const refYmd = dublinDate(ref);
  const refDow = weekdayOf(refYmd);
  for (const m of text.matchAll(WEEKDAY_ONLY)) {
    const target = weekdayNumber(m[2]);
    if (target === undefined) continue;
    let diff = (target - refDow + 7) % 7;
    if (diff === 0) diff = 7; // "Monday" said on a Monday means next week
    push(m.index, m[0], addDays(refYmd, diff));
  }
  for (const m of text.matchAll(RELATIVE)) {
    push(m.index, m[0], addDays(refYmd, m[1].toLowerCase() === 'tomorrow' ? 1 : 0));
  }

  // Prefer the longest mention where matches overlap ("Tuesday 18th November" over "Tuesday").
  found.sort((a, b) => a.index - b.index || b.end - a.end);
  const kept: DateMention[] = [];
  for (const d of found) {
    const last = kept[kept.length - 1];
    if (last && d.index < last.end) {
      if (d.end - d.index > last.end - last.index) kept[kept.length - 1] = d;
      continue;
    }
    kept.push(d);
  }
  return kept;
}

function toMinutes(hourText: string, minuteText: string | undefined, meridiem: string | undefined): number | undefined {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (!Number.isInteger(hour) || minute > 59) return undefined;
  const mer = meridiem?.toLowerCase().replace(/\./g, '');
  if (mer) {
    if (hour < 1 || hour > 12) return undefined;
    if (mer === 'pm' && hour < 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;
  } else {
    if (!minuteText || hour > 23) return undefined; // bare numbers are not times
    if (hour >= 1 && hour <= 7) hour += 12;        // "2:30" in an interview email means afternoon
  }
  return hour * 60 + minute;
}

function findTimes(text: string): TimeMention[] {
  const out: TimeMention[] = [];
  for (const m of text.matchAll(TIME_RANGE)) {
    if (m[7]) {
      out.push({ index: m.index, end: m.index + m[0].length, startMin: 12 * 60, raw: m[0] });
      continue;
    }
    const [, h1, mi1, mer1, h2, mi2, mer2] = m;
    const endMin = h2 ? toMinutes(h2, mi2, mer2 ?? mer1) : undefined;
    // "2 - 3pm": the first time borrows the second's meridiem.
    const startMin = toMinutes(h1, mi1, mer1 ?? (h2 ? mer2 : undefined));
    if (startMin === undefined) continue;
    out.push({
      index: m.index,
      end: m.index + m[0].length,
      startMin,
      endMin: endMin !== undefined && endMin > startMin ? endMin : undefined,
      raw: m[0].trim(),
    });
  }
  return out;
}

/** UTC instant of a Dublin wall-clock time (handles the DST offset of that date). */
export function dublinWallToUtc(ymd: string, minutes: number): Date {
  let t = dublinMidnight(ymd).getTime() + minutes * 60_000;
  const p = dublinParts(new Date(t));
  const actual = p.hour * 60 + p.minute;
  if (dublinDate(new Date(t)) === ymd && actual !== minutes) t += (minutes - actual) * 60_000;
  return new Date(t);
}

function crossesParagraph(text: string, from: number, to: number): boolean {
  return /\n\s*\n/.test(text.slice(Math.min(from, to), Math.max(from, to)));
}

/**
 * Proposed interview times in `text`, read relative to `ref` (normally the email's date).
 * Dates with no nearby time come back as all-day entries; times with no date are ignored.
 */
export function extractProposedTimes(text: string, ref: Date = new Date(), durationMin = DEFAULT_DURATION_MIN): ProposedTime[] {
  const body = String(text ?? '').slice(0, 20_000);
  const dates = findDates(body, ref);
  const times = findTimes(body).filter((t) => !dates.some((d) => t.index >= d.index && t.end <= d.end));
  const used = new Set<number>();
  const results: ProposedTime[] = [];

  for (const d of dates) {
    let best: { i: number; dist: number } | undefined;
    times.forEach((t, i) => {
      if (used.has(i)) return;
      const after = t.index >= d.end ? t.index - d.end : Infinity;
      const before = t.end <= d.index ? d.index - t.end : Infinity;
      const dist = after <= PAIR_AFTER_CHARS ? after : before <= PAIR_BEFORE_CHARS ? before + 0.5 : Infinity;
      if (dist === Infinity || crossesParagraph(body, d.index, t.index)) return;
      if (!best || dist < best.dist) best = { i, dist };
    });

    if (best) {
      used.add(best.i);
      const t = times[best.i];
      const start = dublinWallToUtc(d.ymd, t.startMin);
      const end = dublinWallToUtc(d.ymd, t.endMin ?? t.startMin + durationMin);
      const raw = (t.index > d.index ? body.slice(d.index, t.end) : body.slice(t.index, d.end)).replace(/\s+/g, ' ').trim();
      results.push({ raw, start: start.toISOString(), end: end.toISOString(), allDay: false, date: d.ymd });
    } else if (!d.needsTime) {
      const start = dublinMidnight(d.ymd);
      results.push({ raw: d.raw.trim(), start: start.toISOString(), end: dublinMidnight(addDays(d.ymd, 1)).toISOString(), allDay: true, date: d.ymd });
    }
  }

  const earliest = ref.getTime() - 60 * 60_000;
  const seen = new Set<string>();
  return results
    .filter((r) => (r.allDay ? r.date >= dublinDate(ref) : new Date(r.start).getTime() >= earliest))
    .filter((r) => {
      const key = `${r.start}|${r.allDay}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

function gcalStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface CalendarEvent { title: string; start: string; end: string; allDay?: boolean; details?: string; location?: string }

/** https://calendar.google.com/calendar/render?action=TEMPLATE&text=..&dates=..&details=.. */
export function googleCalendarUrl(ev: CalendarEvent): string {
  const dates = ev.allDay
    ? `${dublinDate(new Date(ev.start)).replace(/-/g, '')}/${dublinDate(new Date(ev.end)).replace(/-/g, '')}`
    : `${gcalStamp(ev.start)}/${gcalStamp(ev.end)}`;
  const parts = [
    'action=TEMPLATE',
    `text=${encodeURIComponent(ev.title.slice(0, 200))}`,
    `dates=${dates}`,
  ];
  if (ev.details) parts.push(`details=${encodeURIComponent(ev.details.slice(0, 1500))}`);
  if (ev.location) parts.push(`location=${encodeURIComponent(ev.location.slice(0, 300))}`);
  return `https://calendar.google.com/calendar/render?${parts.join('&')}`;
}

/** Human label for a proposed time, e.g. "Tue 18 Nov, 14:00" (Dublin). */
export function formatProposedTime(t: Pick<ProposedTime, 'start' | 'allDay'>): string {
  // Built by hand: ICU versions disagree on punctuation ("Tue 18 Nov" vs "Tue, 18 Nov").
  const p = dublinParts(new Date(t.start));
  const day = `${p.weekday} ${p.day} ${MONTH_SHORT[p.month - 1]}`;
  return t.allDay ? day : `${day}, ${pad(p.hour)}:${pad(p.minute)}`;
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
