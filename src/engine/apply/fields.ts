// Shared form discovery + filling for every ATS adapter.
//
// Flow: scan the DOM (SCAN_FIELDS_JS tags each control) → decide a value per field (profile, EEO
// decline, approved answers, confirmed answer-bank entries) → optionally ask a resolver about the
// questions still unknown (answer bank + guarded mapping, see llmfill.ts) → fill → rescan and report
// what the page itself says is still empty. Nothing here clicks submit.
//
// Truth rules enforced here: values come only from the profile, the approved answers artifact, or
// confirmed answer-bank entries. EEO questions are answered only with a "decline" option. Legal
// attestations are never ticked unless an approved answer says so. Data-processing consent for this
// application is ticked only with Kayzee's recorded OK (approved answer or the confirmed bank entry
// CONSENT_BANK_ID). Marketing / talent-pool / future-opportunity opt-ins are never ticked.

import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import type { AnswerBank, AnswerEntry, AnsweredQuestion, ApplyPackage, Blocker, FillResult, ScreeningQuestion } from '@/lib/types';
import { scanBlockers, type SiteKind } from './detect';
import { CONTAINER_ATTR, FIELD_ATTR, OPTION_ATTR, SCAN_FIELDS_JS, type RawField, type ScanArgs } from './inpage';

export type { RawField } from './inpage';

// ───────────────────────────── Text helpers (pure) ─────────────────────────────

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'for', 'and', 'or', 'you', 'your', 'are', 'is', 'do', 'does', 'we', 'our', 'with', 'this', 'that', 'please', 'if', 'any', 'be', 'on', 'at', 'as', 'by']);

export function normalizeText(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[*✱]/g, ' ')
    .replace(/\(required\)|\(optional\)/g, ' ')
    .replace(/[^a-z0-9'+#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalizeText(s).split(' ').filter((t) => t && !STOPWORDS.has(t));
}

/** 0..1 similarity between two question labels. */
export function labelSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (long.includes(short) && short.length / long.length >= 0.6) return 0.9;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Best option for an answer, or null when nothing is a confident match (never guesses). */
export function bestOption(answer: string, options: string[]): { index: number; score: number } | null {
  const a = normalizeText(answer);
  if (!a || !options.length) return null;
  let best: { index: number; score: number } | null = null;
  options.forEach((opt, index) => {
    const o = normalizeText(opt);
    if (!o) return;
    let score = 0;
    if (o === a) score = 1;
    else if ((a === 'yes' || a === 'no') && o.split(' ')[0] === a) score = 0.95;
    else if (o.startsWith(`${a} `) || a.startsWith(`${o} `)) score = 0.85;
    else if (a.length >= 4 && o.includes(a)) score = 0.75;
    else if (o.length >= 4 && a.includes(o)) score = 0.7;
    else score = labelSimilarity(a, o) * 0.9;
    if (!best || score > best.score) best = { index, score };
  });
  const found = best as { index: number; score: number } | null;
  return found && found.score >= 0.6 ? found : null;
}

const DECLINE_RE = /\b(decline|prefer not|rather not|choose not|wish not|not (to )?(wish|want) to|don'?t (wish|want) to|do not (wish|want) to|not to (say|disclose|answer|self[- ]?identify)|not disclose|i don'?t want to answer)\b/i;

/** Index of a "decline to self-identify" style option, or -1. */
export function findDeclineOption(options: string[]): number {
  return options.findIndex((o) => DECLINE_RE.test(o.replace(/[’‘]/g, "'")));
}

const EEO_RE = /\b(gender|sex|race|racial|ethnic|ethnicity|hispanic|latin[oax]|veteran|disability|disabled|sexual orientation|transgender|lgbtq?\+?|religio\w*|marital status|national origin|age (range|group|bracket)|date of birth)\b/i;

/** Demographic / EEO question (SPEC §0.3: decline if possible, else hand off). */
export function isEeoLabel(label: string): boolean {
  return EEO_RE.test(label);
}

const ATTESTATION_RE = /\b(i (hereby )?(certify|confirm|acknowledge|agree|declare|attest|consent|understand)|by (checking|ticking|submitting)|terms (and|&) conditions|terms of (use|service)|privacy (policy|notice|statement)|attest|true and (complete|accurate))\b/i;

export function isAttestationLabel(label: string): boolean {
  return ATTESTATION_RE.test(label);
}

// ───────────────────────────── Consent classification (pure) ─────────────────────────────

/** Answer-bank entry id that records Kayzee's OK to tick data-processing consent boxes for applications. */
export const CONSENT_BANK_ID = 'data-processing-consent';

// Opt-in wording only. Bare "marketing" / "promotional" must NOT count: Kayzee applies for marketing jobs, and
// "Do you have marketing experience?" is a real question, not an opt-in (live bug 2026-11-16, Focus Ireland).
const MARKETING_RE = /\b(newsletters?|(opt[- ]?in|consent|agree) to (receive|be contacted)|receive (sms|texts?|text messages|whatsapp)|whatsapp messages|(receive|send me|get|opt[- ]?in (to|for)|sign up (to|for)|subscribe to|consent to receiving?|agree to receiv\w*) ((our|the|your|any|occasional|relevant|future) )?(marketing|promotional)\b|marketing (emails?|e-mails?|messages|communications?|materials?|updates|offers|preferences|consent|opt[- ]?in)|promotional (emails?|e-mails?|messages|communications?|offers|materials?)|special offers|keep me (informed|updated|posted|in the loop)|stay (informed|updated|in touch)|future (job |career |employment )?(opportunit\w*|openings?|vacanc\w*|roles?|positions?|jobs?)|other (job )?(opportunit\w*|openings?|vacanc\w*|roles|positions|jobs)|similar (roles|jobs|positions|opportunit\w*)|talent (pool|community|network|pipeline|database)|job alerts?|career (updates|news)|join our (community|network|mailing list)|mailing list|subscribe|(contact|email|e-mail|notify|inform) me (about|regarding|with|of) (future|other|new|relevant|upcoming)|send me (news|updates|information|offers)|receive (updates|news|information|communications|emails|e-mails|newsletters|marketing|offers)|via (sms|text( message)?|whatsapp)|by (sms|text message|whatsapp)|share my (data|details|profile|information|cv) with (third|partner|other|group)|third[- ]part(y|ies)|retain my (data|cv|details|information) for (future|other)|follow (the )?company|events and offers)\b/i;
const PROCESSING_RE = /\b(privacy (policy|notice|statement|information)|data (protection|privacy|processing)( (policy|notice|statement|information))?|process(ing)? (of )?(my|your) (personal )?(data|information|details|application)|personal (data|information|details)|gdpr|store (my|your) (personal )?(details|data|information)|recruitment (process|purposes?)|purposes? of (this|my|the) (application|recruitment)|(this|my) (job )?application|candidate privacy|applicant privacy)\b/i;
const CONSENT_VERB_RE = /\b(consent|agree|accept|acknowledge|read|understand|confirm|allow|authori[sz]e|permit)\b/i;
const ATTEST_STRICT_RE = /\b(certify|declare|attest|true(,)? (and|&) (complete|accurate|correct)|accurate (and|&) (complete|true)|terms (and|&) conditions|terms of (use|service)|false (or misleading )?information|misrepresentation|background (check|screening)|drug (test|screen)|right to (dismiss|terminate))\b/i;

export type ConsentKind = 'processing' | 'marketing' | 'attestation';

/**
 * What a consent-style checkbox asks for: 'marketing' (newsletters, job alerts, talent pool, future
 * opportunities, SMS — never ticked), 'attestation' (truth declarations, terms — approved answer
 * only), 'processing' (privacy policy / data processing for this application), or null.
 */
export function classifyConsent(text: string): ConsentKind | null {
  const t = (text ?? '').replace(/[’‘]/g, "'");
  if (MARKETING_RE.test(t)) return 'marketing';
  if (ATTEST_STRICT_RE.test(t)) return 'attestation';
  if (PROCESSING_RE.test(t) && CONSENT_VERB_RE.test(t)) return 'processing';
  if (isAttestationLabel(t)) return 'attestation';
  return null;
}

/** "Yes"-ish answers for single checkboxes. */
export function isTruthy(answer: string): boolean {
  return /^(yes|y|true|1|checked|agree|i agree|i consent|accept|i accept)\b/i.test(answer.trim());
}

function patternMatches(pattern: string, label: string, normLabel: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (/[\\^$[\]()|?+{}]/.test(p)) {
    try {
      return new RegExp(p, 'i').test(label);
    } catch {
      // not a valid regex: fall through to substring
    }
  }
  return normLabel.includes(normalizeText(p));
}

/**
 * Most specific confirmed answer-bank entry for a label. Unconfirmed entries (`confirm: true`) and
 * empty answers are never used at apply time: those are for Kayzee to settle in the dashboard.
 */
export function matchBankEntry(label: string, bank: AnswerBank | undefined): AnswerEntry | null {
  if (!bank?.entries?.length) return null;
  const norm = normalizeText(label);
  let best: { entry: AnswerEntry; len: number } | null = null;
  for (const entry of bank.entries) {
    if (entry.confirm === true || !entry.answer?.trim()) continue;
    for (const p of entry.patterns) {
      if (patternMatches(p, label, norm) && (!best || p.length > best.len)) best = { entry, len: p.length };
    }
  }
  return best?.entry ?? null;
}

/** Kayzee's recorded OK for data-processing consent: the canonical entry, or a confirmed consent entry for this wording. */
export function bankConsents(text: string, bank: AnswerBank | undefined): boolean {
  const canonical = bank?.entries?.find((e) => e.id === CONSENT_BANK_ID && e.confirm !== true && e.answer?.trim());
  if (canonical) return isTruthy(canonical.answer);
  const matched = matchBankEntry(text, bank);
  if (!matched || !isTruthy(matched.answer)) return false;
  return /consent|privacy|gdpr|data|processing/i.test(`${matched.id} ${matched.patterns.join(' ')}`) && !/^eeo-|marketing/i.test(matched.id);
}

/** The approved answer for a field: by field id/name first, then by label similarity ≥ 0.75. */
export function findAnswer(field: Pick<RawField, 'id' | 'name' | 'label'>, answers: AnsweredQuestion[]): AnsweredQuestion | null {
  const byId = answers.find((q) => q.id && (q.id === field.id || q.id === field.name));
  if (byId) return byId;
  let best: { q: AnsweredQuestion; s: number } | null = null;
  for (const q of answers) {
    const s = labelSimilarity(q.label, field.label);
    if (s >= 0.75 && (!best || s > best.s)) best = { q, s };
  }
  return best?.q ?? null;
}

function usable(q: AnsweredQuestion | null): q is AnsweredQuestion & { answer: string } {
  return !!q && !q.needsHuman && typeof q.answer === 'string' && q.answer.trim() !== '';
}

// ───────────────────────────── Standard profile fields ─────────────────────────────

export type StandardKind = 'first' | 'last' | 'full' | 'preferred' | 'email' | 'phone' | 'phone_country' | 'location' | 'city' | 'country'
  | 'linkedin' | 'github' | 'website' | 'cv' | 'cover_file' | 'cover_text';

const TEXTY = new Set<RawField['kind']>(['text', 'email', 'tel', 'url', 'textarea']);
const DIAL_LABEL_RE = /\b(country (calling )?code|calling code|dial(l)?ing code|dial code|phone (country|prefix|code)|country prefix|area code|prefix)\b/;
const COVER_TEXT_RE = /\b(cover(ing)? letter|motivation(al)? letter|letter of motivation|message to the hiring (team|manager)|message for the hiring (team|manager)|note to the hiring (team|manager)|let the company know (about )?your interest)\b/;
const SOCIAL_LINK_RE = /^(facebook|x|twitter|x fka twitter|x formerly twitter|instagram|tiktok|youtube|snapchat|pinterest|behance|dribbble|medium|threads|bluesky|mastodon|xing|other (link|url|website))( (profile|url|link|page|handle|username))?$/;
const LOCATION_LABEL_RE = /^(current |your |home )?(location|address|city|town|city of residence|location city|location \(city\)|city \(location\))( city)?$|^where are you (currently )?(based|located)$/;

/** Which profile field a form control asks for, if any. Deliberately strict: a wrong match fills a wrong box. */
export function standardKind(field: Pick<RawField, 'kind' | 'label' | 'name' | 'id' | 'autocomplete' | 'placeholder'> & { required?: boolean }, ats?: SiteKind): StandardKind | null {
  const n = normalizeText(field.label);
  const nm = `${field.name} ${field.id}`.toLowerCase();
  const ac = field.autocomplete.toLowerCase();
  const kind = field.kind;

  if (kind === 'file') {
    if (/cover/.test(n) || /cover/.test(nm)) return 'cover_file';
    if (/\b(resume|cv|curriculum)\b/.test(n) || /resume|(^|[_\W])cv([_\W]|$)/.test(nm)) return 'cv';
    if (field.required && /^(attach(ment)?s?|upload( a)?( file)?|documents?|files?|upload (your )?documents?)$/.test(n)) return 'cv';
    // SmartRecruiters' dropzone input often carries no label at all; the only upload on that form is the resume.
    if (ats === 'smartrecruiters' && (!n || /^(choose|select|upload|drop|browse)\b/.test(n))) return 'cv';
    return null;
  }
  if (kind === 'textarea') {
    if (COVER_TEXT_RE.test(n) || /cover_?letter/.test(nm)) return 'cover_text';
    if (/cover letter/i.test(field.placeholder)) return 'cover_text';
    if (ats === 'lever' && field.name === 'comments') return 'cover_text';
    return null;
  }
  if (kind === 'combobox' || kind === 'select') {
    if (DIAL_LABEL_RE.test(n)) return 'phone_country';
    if (/^country( of residence)?$/.test(n) || field.id === 'country') return 'country';
    if (kind === 'combobox' && field.required && LOCATION_LABEL_RE.test(n) && !/address/.test(n)) return /city|town/.test(n) && !/location/.test(n) ? 'city' : 'location';
    if (kind === 'combobox' && field.required && /^(current |home )?address$/.test(n)) return 'location';
    return null;
  }
  if (!TEXTY.has(kind)) return null;

  if (ac === 'given-name' || /^(legal )?first name\b|^given name|^forename/.test(n) || /first_?name/.test(nm)) return 'first';
  if (ac === 'family-name' || /^(legal )?(last name|surname|family name)\b/.test(n) || /last_?name/.test(nm)) return 'last';
  if (/^preferred (first )?name\b/.test(n)) return 'preferred';
  if (ac === 'name' || /^(full |your |legal )?name$/.test(n) || /^full name\b/.test(n) || field.name === 'name' || nm.includes('_systemfield_name')) return 'full';
  if (/consent|subscribe|opt in|marketing/.test(n)) return null;
  if (ac === 'email' || kind === 'email' || /^(your )?e ?mail( address)?$/.test(n) || nm.includes('_systemfield_email') || field.name === 'email') return 'email';
  if (/^(confirm|re ?enter|repeat|verify|retype)( your)? e ?mail( address)?$|^e ?mail( address)? (again|confirmation)$/.test(n)) return 'email';
  if (ac.startsWith('tel') || kind === 'tel' || /^(phone|mobile|telephone|cell|contact)( phone)?( number)?$/.test(n) || field.name === 'phone') return 'phone';
  if (/linkedin/.test(n) || /linkedin/.test(nm)) return 'linkedin';
  if (/github/.test(n) || /github/.test(nm)) return 'github';
  if (/^(personal )?(website|portfolio|site|web site)( url| link| address)?$|^portfolio( url| link)?$|personal website/.test(n) || /urls\[portfolio\]|urls\[website\]/.test(nm)) return 'website';
  if (/^(current |your )?(city|town)( of residence)?$/.test(n)) return 'city';
  if (/^(country|country of residence|current country)$/.test(n)) return 'country';
  if (/^(current |your )?(location|city|town)( city)?$|^where are you (currently )?(based|located)$/.test(n) || field.name === 'location') return 'location';
  return null;
}

/** Country name from "Dundalk, Co. Louth, Ireland". */
export function countryFromLocation(location: string): string {
  const parts = (location ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function cityFromLocation(location: string): string {
  return (location ?? '').split(',')[0]?.trim() ?? '';
}

const DIAL_CODES: Record<string, { country: string; iso: string }> = {
  '+353': { country: 'Ireland', iso: 'IE' }, '+44': { country: 'United Kingdom', iso: 'GB' }, '+1': { country: 'United States', iso: 'US' },
  '+91': { country: 'India', iso: 'IN' }, '+49': { country: 'Germany', iso: 'DE' }, '+33': { country: 'France', iso: 'FR' },
  '+34': { country: 'Spain', iso: 'ES' }, '+31': { country: 'Netherlands', iso: 'NL' }, '+48': { country: 'Poland', iso: 'PL' },
};

/** Splits "+353 1 555 0100" into dial code + national number (leading 0 dropped). */
export function phoneParts(phone: string): { dial: string; national: string; country: string; iso: string } | null {
  const compact = (phone ?? '').replace(/[^\d+]/g, '');
  if (!compact.startsWith('+')) return null;
  for (const code of Object.keys(DIAL_CODES).sort((a, b) => b.length - a.length)) {
    if (compact.startsWith(code)) {
      const rest = (phone ?? '').trim().replace(/^\+\s*/, '').replace(new RegExp(`^${code.slice(1)}\\s*`), '').replace(/^\(0\)\s*/, '').replace(/^0/, '').trim();
      return { dial: code, national: rest, ...DIAL_CODES[code] };
    }
  }
  return null;
}

/** Chooser for a dial-code / country picker: "Ireland (+353)", "+353", "IE"... */
function dialChooser(pkg: ApplyPackage): (options: string[]) => number {
  const parts = phoneParts(pkg.profile.phone);
  const country = parts?.country ?? countryFromLocation(pkg.profile.location);
  const dial = parts?.dial ?? '';
  return (options) => {
    const norm = options.map((o) => o.replace(/\s+/g, ' ').trim());
    if (dial) {
      const both = norm.findIndex((o) => o.includes(dial) && (!country || o.toLowerCase().includes(country.toLowerCase())));
      if (both >= 0) return both;
      const exact = norm.findIndex((o) => new RegExp(`(^|[^\\d])${dial.replace('+', '\\+')}($|[^\\d])`).test(o));
      if (exact >= 0) return exact;
    }
    if (country) return bestOption(country, norm)?.index ?? -1;
    return -1;
  };
}

function standardValue(kind: StandardKind, pkg: ApplyPackage): string | null {
  const p = pkg.profile;
  switch (kind) {
    case 'first': return p.name.first || null;
    case 'last': return p.name.last || null;
    case 'full': return p.name.full || `${p.name.first} ${p.name.last}`.trim() || null;
    case 'preferred': return p.name.preferred || null;
    case 'email': return p.email || null;
    case 'phone': return p.phone || null;
    case 'phone_country': return phoneParts(p.phone)?.country ?? (countryFromLocation(p.location) || null);
    case 'location': return p.location || null;
    case 'city': return cityFromLocation(p.location) || null;
    case 'country': return countryFromLocation(p.location) || null;
    case 'linkedin': return p.links.linkedin ?? null;
    case 'github': return p.links.github ?? null;
    case 'website': return p.links.portfolio ?? p.links.website ?? null;
    case 'cv': return pkg.cvPdfPath || null;
    case 'cover_file': return pkg.coverLetterPdfPath ?? null;
    case 'cover_text': return pkg.coverLetterText?.trim() || null;
  }
}

// ───────────────────────────── Decisions ─────────────────────────────

export type NeedKind = 'question' | 'eeo' | 'attestation' | 'consent' | 'marketing' | 'file' | 'profile';

export type Decision =
  | { action: 'fill'; value: string; source: 'profile' | 'answers' | 'bank' }
  | { action: 'decline' }
  | { action: 'optout' }
  | { action: 'cover_manual'; value: string }
  | { action: 'skip' }
  | { action: 'need'; reason: string; kind?: NeedKind };

export interface FillContext {
  ats: SiteKind;
  bank?: AnswerBank;
}

const NO_RE = /^(no|none|n\/a|not interested|do not|don'?t)\b/i;

/** What to do with one field. Pure: depends only on the field, the package and the bank. */
export function decide(field: RawField, pkg: ApplyPackage, ctx: FillContext): Decision {
  const label = field.label || field.name || field.id;
  const std = standardKind(field, ctx.ats);

  if (field.kind === 'file') {
    if (std === 'cv') return pkg.cvPdfPath ? { action: 'fill', value: pkg.cvPdfPath, source: 'profile' } : { action: 'need', reason: 'CV PDF missing', kind: 'file' };
    if (std === 'cover_file') {
      if (pkg.coverLetterPdfPath) return { action: 'fill', value: pkg.coverLetterPdfPath, source: 'profile' };
      if (pkg.coverLetterText?.trim() && field.hasManualToggle) return { action: 'cover_manual', value: pkg.coverLetterText.trim() };
      return field.required ? { action: 'need', reason: `Cover letter upload required: "${label}"`, kind: 'file' } : { action: 'skip' };
    }
    return field.required ? { action: 'need', reason: `File upload required: "${label}"`, kind: 'file' } : { action: 'skip' };
  }

  if (isEeoLabel(label) || field.eeoSection) {
    if (field.kind === 'select' || field.kind === 'combobox' || field.kind === 'radio' || field.kind === 'checkbox-group' || field.kind === 'checkbox') return { action: 'decline' };
    return field.required ? { action: 'need', reason: `Demographic question needs you: "${label}"`, kind: 'eeo' } : { action: 'skip' };
  }

  const answer = findAnswer(field, pkg.answers);
  const singleBox = field.kind === 'checkbox' && field.options.length <= 1;
  const boxText = `${label} ${singleBox ? field.options[0] ?? '' : ''}`.trim();
  const consent = classifyConsent(boxText);

  if (consent === 'marketing') {
    // SPEC: never opt Kayzee into marketing / talent pools / future-opportunity mailings.
    if (singleBox) return field.required ? { action: 'need', reason: `Required marketing / communications opt-in: "${label}" (never ticked automatically)`, kind: 'marketing' } : { action: 'skip' };
    if (field.kind === 'combobox' || field.options.some((o) => NO_RE.test(o.trim()))) return { action: 'optout' };
    return field.required ? { action: 'need', reason: `Marketing / communications question needs you: "${label}"`, kind: 'marketing' } : { action: 'skip' };
  }

  if (singleBox && (consent === 'processing' || consent === 'attestation' || isAttestationLabel(label) || isAttestationLabel(field.options[0] ?? ''))) {
    if (usable(answer) && isTruthy(answer.answer)) return { action: 'fill', value: 'yes', source: 'answers' };
    if (consent === 'processing' && !(usable(answer) && NO_RE.test(answer.answer)) && bankConsents(boxText, ctx.bank)) return { action: 'fill', value: 'yes', source: 'bank' };
    const what = consent === 'processing' ? 'Legal attestation needs your decision (data-processing consent for this application)' : 'Legal attestation needs your decision';
    // A data-processing consent box for this application is effectively required even when the page doesn't mark it
    // (Workable's name="gdpr" box only has a visual asterisk): skipping it silently makes the submit fail.
    const required = field.required || consent === 'processing';
    return required ? { action: 'need', reason: `${what}: "${label}"`, kind: consent === 'processing' ? 'consent' : 'attestation' } : { action: 'skip' };
  }

  if (std) {
    const v = standardValue(std, pkg);
    if (v) return { action: 'fill', value: v, source: 'profile' };
  }

  // A profile link he doesn't have (Facebook, X...) is left blank, never raised as a question to answer.
  if (!std && TEXTY.has(field.kind) && SOCIAL_LINK_RE.test(normalizeText(label))) return { action: 'skip' };

  if (usable(answer)) return { action: 'fill', value: answer.answer, source: 'answers' };
  const entry = matchBankEntry(label, ctx.bank);
  if (entry) return { action: 'fill', value: entry.answer, source: 'bank' };

  if (!field.required) return { action: 'skip' };
  return { action: 'need', reason: `Answer required question: "${label}"`, kind: std ? 'profile' : 'question' };
}

// ───────────────────────────── Page helpers ─────────────────────────────

export async function scanFields(page: Page, root: string | null, fileNames: string[] = []): Promise<RawField[]> {
  const args: ScanArgs = { root, fileNames };
  return (await page.evaluate(`(${SCAN_FIELDS_JS})(${JSON.stringify(args)})`)) as RawField[];
}

const fieldLoc = (page: Page, idx: number): Locator => page.locator(`[${FIELD_ATTR}="${idx}"]`).first();
const optionLoc = (page: Page, idx: number, opt: number): Locator => page.locator(`[${FIELD_ATTR}="${idx}"][${OPTION_ATTR}="${opt}"], [${FIELD_ATTR}="${idx}"] [${OPTION_ATTR}="${opt}"]`).first();
const containerLoc = (page: Page, idx: number): Locator => page.locator(`[${CONTAINER_ATTR}="${idx}"]`).first();

async function settle(page: Page, ms = 150): Promise<void> {
  await page.waitForTimeout(ms).catch(() => undefined);
}

const ACTION_MS = 5_000;

async function fillText(page: Page, field: RawField, value: string): Promise<boolean> {
  const loc = fieldLoc(page, field.idx);
  await loc.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
  await loc.fill(value, { timeout: ACTION_MS });
  return (await loc.inputValue({ timeout: 2_000 }).catch(() => '')).trim().length > 0;
}

async function checkOption(page: Page, field: RawField, index: number): Promise<boolean> {
  const loc = optionLoc(page, field.idx, index);
  try {
    await loc.check({ timeout: 2_500 });
  } catch {
    // custom-styled inputs are often hidden behind their label: a DOM click toggles them and fires change
    await loc.dispatchEvent('click', undefined, { timeout: 2_500 }).catch(() => undefined);
  }
  return loc.isChecked({ timeout: 2_000 }).catch(() => false);
}

async function comboboxOptionLocator(page: Page, field: RawField): Promise<Locator> {
  const scoped = containerLoc(page, field.idx).locator('[role="option"]');
  if (await scoped.count()) return scoped;
  return page.locator('[role="listbox"] [role="option"]:visible, .select__menu [role="option"]:visible');
}

async function openCombobox(page: Page, field: RawField): Promise<Locator> {
  const input = fieldLoc(page, field.idx);
  await input.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
  try {
    await input.click({ timeout: 3_000 });
  } catch {
    await input.focus().catch(() => undefined);
  }
  let opts = await comboboxOptionLocator(page, field);
  if (!(await opts.count())) {
    await input.press('ArrowDown', { timeout: 2_000 }).catch(() => undefined);
    await settle(page, 200);
    opts = await comboboxOptionLocator(page, field);
  }
  await opts.first().waitFor({ state: 'visible', timeout: 2_500 }).catch(() => undefined);
  return comboboxOptionLocator(page, field);
}

async function readOptionTexts(opts: Locator): Promise<string[]> {
  return (await opts.allInnerTexts().catch(() => [] as string[])).map((t) => t.replace(/\s+/g, ' ').trim());
}

/** Reads a combobox's options by opening it, then closes it again. */
export async function readComboboxOptions(page: Page, field: RawField): Promise<string[]> {
  const texts = await readOptionTexts(await openCombobox(page, field));
  await fieldLoc(page, field.idx).press('Escape', { timeout: 2_000 }).catch(() => undefined);
  return texts;
}

type Chooser = (options: string[]) => number;

async function chooseCombobox(page: Page, field: RawField, choose: Chooser, query?: string): Promise<{ ok: boolean; options: string[] }> {
  const input = fieldLoc(page, field.idx);
  let opts = await openCombobox(page, field);
  let texts = await readOptionTexts(opts);
  let index = choose(texts);
  if (index < 0 && query && field.type !== 'combobox-button') {
    await input.fill(query.slice(0, 40), { timeout: ACTION_MS }).catch(() => undefined);
    await settle(page, 400);
    opts = await comboboxOptionLocator(page, field);
    await opts.first().waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
    const filtered = await readOptionTexts(opts);
    index = choose(filtered);
    if (filtered.length) texts = filtered;
  }
  if (index < 0) {
    await input.press('Escape', { timeout: 2_000 }).catch(() => undefined);
    return { ok: false, options: texts };
  }
  await opts.nth(index).click({ timeout: ACTION_MS });
  await settle(page);
  return { ok: true, options: texts };
}

async function chooseInField(page: Page, field: RawField, choose: Chooser, query?: string): Promise<{ ok: boolean; options: string[] }> {
  switch (field.kind) {
    case 'combobox':
      return chooseCombobox(page, field, choose, query);
    case 'select': {
      const index = choose(field.options);
      if (index < 0) return { ok: false, options: field.options };
      await fieldLoc(page, field.idx).selectOption({ index: field.optionDomIndex[index] }, { timeout: ACTION_MS });
      return { ok: true, options: field.options };
    }
    case 'radio':
    case 'checkbox-group':
    case 'checkbox': {
      const index = choose(field.options);
      if (index < 0) return { ok: false, options: field.options };
      return { ok: await checkOption(page, field, index), options: field.options };
    }
    case 'yesno': {
      const index = choose(field.options);
      if (index < 0) return { ok: false, options: field.options };
      await optionLoc(page, field.idx, index).click({ timeout: ACTION_MS });
      return { ok: true, options: field.options };
    }
    default:
      return { ok: false, options: [] };
  }
}

const answerChooser = (answer: string): Chooser => (options) => bestOption(answer, options)?.index ?? -1;

/** Location autocomplete: only a suggestion that contains the city (and, when shown, the country) is accepted. */
function locationChooser(pkg: ApplyPackage): Chooser {
  const city = cityFromLocation(pkg.profile.location).toLowerCase();
  const country = countryFromLocation(pkg.profile.location).toLowerCase();
  return (options) => {
    if (!city) return -1;
    const withCity = options.map((o, i) => ({ o: o.toLowerCase(), i })).filter((x) => x.o.includes(city));
    const both = withCity.find((x) => country && x.o.includes(country));
    return (both ?? withCity[0])?.i ?? -1;
  };
}

/**
 * "Check all that apply": ticks one box per comma/semicolon/newline-separated part of the answer.
 * Succeeds only when every part matched an option, so a half-applied answer is reported, not hidden.
 */
async function checkMany(page: Page, field: RawField, value: string): Promise<{ ok: boolean; options: string[] }> {
  const whole = bestOption(value, field.options);
  const parts = whole && whole.score >= 0.85 ? [value] : value.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  let all = parts.length > 0;
  for (const part of parts) {
    const hit = bestOption(part, field.options);
    all = (!!hit && (await checkOption(page, field, hit.index))) && all;
  }
  return { ok: all, options: field.options };
}

/** Fills one field with a value. Returns true when the page accepted it. */
export async function fillField(page: Page, field: RawField, value: string): Promise<{ ok: boolean; options: string[] }> {
  switch (field.kind) {
    case 'file':
      await fieldLoc(page, field.idx).setInputFiles(path.resolve(value), { timeout: ACTION_MS });
      return { ok: true, options: [] };
    case 'checkbox':
      if (field.options.length <= 1) {
        if (!isTruthy(value)) return { ok: true, options: field.options };
        return { ok: await checkOption(page, field, 0), options: field.options };
      }
      return checkMany(page, field, value);
    case 'checkbox-group':
      return checkMany(page, field, value);
    case 'select':
    case 'combobox':
    case 'radio':
    case 'yesno':
      return chooseInField(page, field, answerChooser(value), value);
    case 'date': {
      const iso = toIsoDate(value);
      if (!iso) return { ok: false, options: [] };
      return { ok: await fillText(page, field, iso), options: [] };
    }
    default:
      return { ok: await fillText(page, field, formatForPlaceholder(value, field)), options: [] };
  }
}

/** YYYY-MM-DD from "2026-12-01", "01/12/2026" (Irish day-first) or "1 December 2026"; null when it isn't a date. */
export function toIsoDate(value: string): string | null {
  const v = (value ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return v;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = /^\d{1,2} [A-Za-z]+ \d{4}$/.test(v) ? new Date(`${v} 12:00 UTC`) : null;
  if (d && !Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

/** Date answers typed into text date-pickers follow the field's placeholder (dd/mm/yyyy, mm/dd/yyyy...). */
function formatForPlaceholder(value: string, field: RawField): string {
  const ph = `${field.placeholder} ${field.label}`.toLowerCase();
  if (!/(dd|mm)[/.-](mm|dd)[/.-](yyyy|yy)|yyyy-mm-dd/.test(ph)) return value;
  const iso = toIsoDate(value);
  if (!iso) return value;
  const [y, mo, d] = iso.split('-');
  if (/yyyy-mm-dd/.test(ph)) return iso;
  if (/mm[/.-]dd/.test(ph)) return `${mo}/${d}/${y}`;
  return `${d}${ph.includes('.') ? '.' : '/'}${mo}${ph.includes('.') ? '.' : '/'}${y}`;
}

async function fillCoverManually(page: Page, field: RawField, text: string): Promise<boolean> {
  const container = containerLoc(page, field.idx);
  const toggleName = /enter manually|paste|write it here|write (it )?instead|type it (here|instead)|type here instead/i;
  let toggle = container.getByRole('button', { name: toggleName }).first();
  if (!(await toggle.count())) toggle = container.locator('xpath=ancestor::*[self::section or self::fieldset or self::li or contains(@class,"field")][1]').getByRole('button', { name: toggleName }).first();
  if (!(await toggle.count())) return false;
  await toggle.click({ timeout: ACTION_MS });
  await settle(page, 250);
  let area = container.locator('textarea').first();
  if (!(await area.count())) area = page.locator('textarea#cover_letter_text, textarea[id*="cover_letter"], textarea[name*="cover_letter"], textarea[name*="coverLetter"], textarea[id*="coverLetter"]').first();
  if (!(await area.count())) return false;
  await area.fill(text, { timeout: ACTION_MS });
  return true;
}

/** Waits while an ATS is parsing an uploaded resume (it pre-fills fields; filling during parsing gets overwritten). */
async function waitForResumeParsing(page: Page): Promise<void> {
  const working = page.locator('.resume-upload-working:visible, [data-pursuit-parsing]:visible');
  if (await working.count().catch(() => 0)) await working.first().waitFor({ state: 'hidden', timeout: 12_000 }).catch(() => undefined);
  const busy = page.getByText(/^(analy[sz]ing|parsing|reading|processing|uploading) (your )?(resume|cv|file)\b/i).first();
  if (await busy.isVisible().catch(() => false)) await busy.waitFor({ state: 'hidden', timeout: 12_000 }).catch(() => undefined);
  await settle(page, 400);
}

// ───────────────────────────── Form fill ─────────────────────────────

/** Answer for a question the profile/approved answers/bank couldn't fill (see llmfill.ts makeResolver). */
export interface ResolvedAnswer { value: string; source: 'bank' | 'profile' | 'llm' | 'llm-map'; key?: string }
export interface ResolverInput { field: RawField; question: ScreeningQuestion }
/** Called with the unknown questions of a pass; returns answers keyed by field idx. Must never invent facts. */
export type QuestionResolver = (questions: ResolverInput[]) => Promise<Map<number, ResolvedAnswer>>;

export interface FormFillOptions extends FillContext {
  /** CSS selector of the form root; null scans the whole page. */
  root: string | null;
  /** Second-chance answering for unknown questions (answer bank via tailor/answers + guarded mapping). */
  resolve?: QuestionResolver;
}

export interface FormFillResult extends FillResult {
  /** label → why it still needs Kayzee. */
  reasons: Record<string, string>;
  /** Labels answered from confirmed answer-bank entries at apply time (not in the approved package). */
  bankAnswered: string[];
  /** Labels whose fill attempt the page did not accept. */
  failedFills: string[];
  /** The required questions still unanswered, as ScreeningQuestions (what to ask Kayzee). */
  unanswered: ScreeningQuestion[];
  /** Labels answered by the resolver, with where the answer came from. */
  resolved: { label: string; source: ResolvedAnswer['source']; key?: string }[];
  /** Multi-step forms: how many steps were filled, and whether a submit button is on screen. */
  steps?: number;
  submitReady?: boolean;
  /** Standard profile fields that were filled (cv, email, phone...): tells a real application form from a newsletter box. */
  kindsFilled?: string[];
}

function fieldKey(f: RawField): string {
  return `${f.kind}:${f.id || f.name || normalizeText(f.label)}`;
}

function displayLabel(f: RawField): string {
  return f.label || f.name || f.id || `${f.kind} field`;
}

/** Maps a scanned field to the contract's ScreeningQuestion. */
export function toScreeningQuestion(f: RawField, options?: string[]): ScreeningQuestion {
  const opts = options ?? f.options;
  const yesNo = opts.length === 2 && opts.every((o) => /^(yes|no)$/i.test(o.trim()));
  const typeMap: Record<RawField['kind'], ScreeningQuestion['type']> = {
    text: 'text', email: 'text', tel: 'text', url: 'url', number: 'number', date: 'date', textarea: 'textarea',
    select: yesNo ? 'yesno' : 'select', combobox: yesNo ? 'yesno' : 'select', radio: yesNo ? 'yesno' : 'radio', checkbox: 'checkbox', 'checkbox-group': 'checkbox',
    yesno: 'yesno', file: 'file',
  };
  const slug = normalizeText(f.label).replace(/\s+/g, '_').slice(0, 60);
  const q: ScreeningQuestion = { id: f.name || f.id || slug || `field_${f.idx}`, label: displayLabel(f), type: typeMap[f.kind], required: f.required };
  if (opts.length) q.options = opts;
  return q;
}

function isQuestion(f: RawField, ats: SiteKind): boolean {
  return standardKind(f, ats) === null && !(f.kind === 'file' && !f.required);
}

const OPTIONY = new Set<RawField['kind']>(['select', 'combobox', 'radio', 'yesno', 'checkbox-group']);

/**
 * Fills a form: files first (uploads can reshape the form or pre-fill it), then everything else,
 * repeating while answering reveals new conditional questions. Reports the page's own view of what
 * is still empty.
 */
export async function fillForm(page: Page, pkg: ApplyPackage, opts: FormFillOptions): Promise<FormFillResult> {
  const fileNames = [pkg.cvPdfPath, pkg.coverLetterPdfPath].filter((p): p is string => !!p).map((p) => path.basename(p));
  const decided = new Map<string, Decision>();
  const optionCache = new Map<string, string[]>();
  const filled = new Set<string>();
  const reasons: Record<string, string> = {};
  const bankAnswered: string[] = [];
  const failedFills: string[] = [];
  const resolved: FormFillResult['resolved'] = [];
  const asked = new Set<string>();
  const dialGroups = new Set<string>();
  const kindsFilled = new Set<string>();
  let attestation = false;

  const recordFill = (field: RawField, label: string, res: { ok: boolean; options: string[] }, key: string, value: string, source: string) => {
    if (res.options.length) optionCache.set(key, res.options);
    if (res.ok) {
      filled.add(label);
      if (source === 'bank') bankAnswered.push(label);
    } else {
      failedFills.push(label);
      reasons[label] = OPTIONY.has(field.kind)
        ? `No option matches the approved answer "${value.slice(0, 60)}" for "${label}"`
        : `Could not fill "${label}"`;
    }
  };

  for (let pass = 0; pass < 4; pass++) {
    const fields = await scanFields(page, opts.root, fileNames);
    const pending = fields.filter((f) => !decided.has(fieldKey(f)) && (pass > 0 || f.kind === 'file'));
    if (pass > 0 && !pending.length) break;
    const unknown: ResolverInput[] = [];

    for (const field of pending) {
      const key = fieldKey(field);
      const decision = decide(field, pkg, opts);
      decided.set(key, decision);
      const label = displayLabel(field);
      try {
        if (decision.action === 'fill') {
          const std = standardKind(field, opts.ats);
          let res: { ok: boolean; options: string[] };
          if (std === 'phone_country') {
            res = await chooseInField(page, field, dialChooser(pkg));
            if (res.ok && field.group) dialGroups.add(field.group);
          } else if (std === 'location' && field.kind === 'combobox') {
            res = await chooseCombobox(page, field, locationChooser(pkg), cityFromLocation(pkg.profile.location));
          } else if (std === 'city' && field.kind === 'combobox') {
            res = await chooseCombobox(page, field, locationChooser(pkg), cityFromLocation(pkg.profile.location));
          } else if (std === 'phone' && field.group && dialGroups.has(field.group)) {
            res = { ok: await fillText(page, field, phoneParts(decision.value)?.national ?? decision.value), options: [] };
          } else {
            res = await fillField(page, field, decision.value);
          }
          recordFill(field, label, res, key, decision.value, decision.source);
          if (res.ok && std) kindsFilled.add(std);
          // A bank answer that matches none of the options ("Company careers page" vs "Company website")
          // gets a second chance through the resolver, which knows option synonyms.
          if (!res.ok && decision.source === 'bank' && OPTIONY.has(field.kind) && opts.resolve && !asked.has(key)) {
            unknown.push({ field, question: toScreeningQuestion(field, res.options.length ? res.options : undefined) });
          }
        } else if (decision.action === 'decline') {
          const res = await chooseInField(page, field, findDeclineOption);
          if (res.options.length) optionCache.set(key, res.options);
          if (res.ok) filled.add(label);
          else if (field.required) reasons[label] = `Demographic question has no "decline" option: "${label}"`;
        } else if (decision.action === 'optout') {
          const res = await chooseInField(page, field, (options) => options.findIndex((o) => NO_RE.test(o.trim())));
          if (res.options.length) optionCache.set(key, res.options);
          if (res.ok) filled.add(label);
          else if (field.required) reasons[label] = `Marketing / communications question needs you: "${label}"`;
        } else if (decision.action === 'cover_manual') {
          if (await fillCoverManually(page, field, decision.value)) filled.add(label);
          else failedFills.push(label);
        } else if (decision.action === 'need') {
          reasons[label] = decision.reason;
          if (/attestation/i.test(decision.reason)) attestation = true;
          if ((decision.kind === 'question' || decision.kind === 'profile') && opts.resolve && !asked.has(key)) {
            unknown.push({ field, question: toScreeningQuestion(field, optionCache.get(key)) });
          }
        }
      } catch (err) {
        failedFills.push(label);
        reasons[label] = `Could not fill "${label}": ${(err as Error).message.split('\n')[0].slice(0, 120)}`;
      }
    }

    // Second chance for unknown questions: answer bank (tailor/answers) and guarded mapping.
    if (unknown.length && opts.resolve) {
      for (const u of unknown) {
        asked.add(fieldKey(u.field));
        if (u.field.kind === 'combobox' && !u.question.options?.length) {
          const options = await readComboboxOptions(page, u.field).catch(() => [] as string[]);
          if (options.length) {
            optionCache.set(fieldKey(u.field), options);
            u.question = toScreeningQuestion(u.field, options);
          }
        }
      }
      const answers = await opts.resolve(unknown).catch(() => new Map<number, ResolvedAnswer>());
      for (const u of unknown) {
        const a = answers.get(u.field.idx);
        if (!a?.value?.trim()) continue;
        const label = displayLabel(u.field);
        try {
          const res = await fillField(page, u.field, a.value);
          if (res.options.length) optionCache.set(fieldKey(u.field), res.options);
          if (res.ok) {
            filled.add(label);
            delete reasons[label];
            resolved.push({ label, source: a.source, ...(a.key ? { key: a.key } : {}) });
            if (a.source === 'bank') bankAnswered.push(label);
          } else {
            failedFills.push(label);
          }
        } catch (err) {
          failedFills.push(label);
          reasons[label] = `Could not fill "${label}": ${(err as Error).message.split('\n')[0].slice(0, 120)}`;
        }
      }
    }
    if (pass === 0) await waitForResumeParsing(page);
  }

  const finalFields = await scanFields(page, opts.root, fileNames);
  const missing = finalFields.filter((f) => f.required && !f.hasValue);
  const unfilledRequired = missing.map(displayLabel);
  for (const label of unfilledRequired) reasons[label] ??= `Answer required question: "${label}"`;
  for (const label of Object.keys(reasons)) if (!unfilledRequired.includes(label)) delete reasons[label];

  const questionsSeen = finalFields
    .filter((f) => isQuestion(f, opts.ats))
    .map((f) => toScreeningQuestion(f, optionCache.get(fieldKey(f))));
  const unanswered = missing.map((f) => ({ ...toScreeningQuestion(f, optionCache.get(fieldKey(f))), required: true }));

  const blockers = new Set<Blocker>((await scanBlockers(page).catch(() => null))?.blockers ?? []);
  if (attestation && Object.values(reasons).some((r) => /attestation/i.test(r))) blockers.add('attestation');
  if (unfilledRequired.length) blockers.add('unknown_required_field');

  return {
    filled: [...filled],
    unfilledRequired,
    blockers: [...blockers],
    questionsSeen,
    reasons,
    bankAnswered,
    failedFills,
    unanswered,
    resolved,
    kindsFilled: [...kindsFilled],
  };
}

/** Lists the form's questions (with combobox options) without filling anything. */
export async function scanFormQuestions(page: Page, root: string | null, ats: SiteKind): Promise<ScreeningQuestion[]> {
  const fields = await scanFields(page, root);
  const out: ScreeningQuestion[] = [];
  for (const f of fields) {
    if (!isQuestion(f, ats)) continue;
    const options = f.kind === 'combobox' ? await readComboboxOptions(page, f).catch(() => [] as string[]) : undefined;
    out.push(toScreeningQuestion(f, options));
  }
  return out;
}
