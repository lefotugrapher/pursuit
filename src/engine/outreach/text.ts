// Small text + address helpers shared by the comms modules (outreach, inbox, follow-ups).

import type { Profile } from '@/lib/types';

const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** Lowercased, trimmed address; strips "Name <addr>" wrappers and mailto:. Undefined when not an address. */
export function normalizeEmail(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  let s = String(value).trim();
  const angle = /<([^>]+)>/.exec(s);
  if (angle) s = angle[1];
  s = s.replace(/^mailto:/i, '').split('?')[0].trim().replace(/[.,;:]+$/, '').toLowerCase();
  return EMAIL_RE.test(s) ? s : undefined;
}

/** Exactly one well-formed address (no lists). */
export function isSingleAddress(value: string | null | undefined): boolean {
  const s = String(value ?? '').trim();
  if (!s || /[,;]/.test(s)) return false;
  return normalizeEmail(s) !== undefined;
}

const NO_REPLY_LOCAL = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply|mailer[-_.]?daemon|postmaster|bounce[s]?|notifications?|alerts?)(?:[-_.+].*)?$/i;

/** True for no-reply / bounce / notification mailboxes that nobody reads. */
export function isNoReplyAddress(address: string | null | undefined): boolean {
  const email = normalizeEmail(address);
  if (!email) return false;
  return NO_REPLY_LOCAL.test(email.split('@')[0]);
}

export function emailDomain(address: string | null | undefined): string | undefined {
  return normalizeEmail(address)?.split('@')[1];
}

/** "Jane Doe <jane@x.com>" → "Jane Doe"; '' when the header carries no display name. */
export function displayName(fromHeader: string | null | undefined): string {
  if (!fromHeader) return '';
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(fromHeader);
  return (m ? m[1] : '').trim();
}

const TEAM_WORDS = /\b(team|talent|careers?|recruit\w*|hiring|hr|human|resources|people|jobs?|no-?reply|notifications?|support|info|admin|acquisition|via|linkedin|indeed|greenhouse|workday|lever)\b/i;

/** First name of a real person from a display name ("Jane Doe" → "Jane"); undefined for team inboxes. */
export function personFirstName(name: string | null | undefined): string | undefined {
  const clean = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!clean || TEAM_WORDS.test(clean) || /[@\d]/.test(clean)) return undefined;
  const first = clean.split(' ')[0].replace(/[^A-Za-zÀ-ÖØ-öø-ÿ'-]/g, '');
  if (first.length < 2) return undefined;
  return first[0].toUpperCase() + first.slice(1);
}

/** Word count used for the length limits (signature excluded by callers). */
export function wordCount(text: string): number {
  const words = text.trim().match(/\S+/g);
  return words ? words.length : 0;
}

/** Placeholders Kayzee must fill before a draft can be sent, e.g. "[your availability]". */
const PLACEHOLDER_RE = /\[(?:your|insert|add|confirm|todo)[^\]]*\]/i;

export function findPlaceholder(text: string): string | undefined {
  return PLACEHOLDER_RE.exec(text)?.[0];
}

/** Sign-off block: profile.coverLetter.signOff then the full legal name. */
export function signature(profile: Profile): string {
  const signOff = profile.coverLetter?.signOff?.trim() || 'Kind Regards,';
  const full = profile.name?.full?.trim();
  return full && !signOff.includes(full) ? `${signOff}\n${full}` : signOff;
}

/** "Re: subject" without stacking prefixes. */
export function replySubject(subject: string): string {
  const s = (subject ?? '').trim();
  if (!s) return 'Re: your email';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** Message-ID in angle brackets (RFC 5322), or undefined. */
export function angleId(id: string | null | undefined): string | undefined {
  const s = (id ?? '').trim();
  if (!s) return undefined;
  return s.startsWith('<') ? s : `<${s}>`;
}

/** Collapses whitespace and trims to `max` chars on a word boundary. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

/** Day + month in Dublin time, e.g. "3 November". */
export function formatDayMonth(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'long' }).format(d);
}
