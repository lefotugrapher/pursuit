'use server';

import { revalidatePath } from 'next/cache';
import { fail, ok, type ActionResult } from '@/components/settings/action-result';
import {
  ConfigError, loadAnswers, loadProfile, saveAnswers, saveFacts, saveProfile, validateConfigJson,
} from '@/lib/config';
import { getSettings, SettingsValidationError, updateSettings, type DeepPartial } from '@/lib/db';
import { log } from '@/lib/log';
import {
  AUTOPILOT_ATS, confirmAnswerEntry, formString, parseList, parseNumber, removeAnswerEntry, runSeedScript, seedScriptAvailable, slugify,
  upsertAnswerEntry,
} from '@/lib/server-more';
import type { AnswerEntry, AtsKind, FactBank, Profile, Settings } from '@/lib/types';

const AUTOPILOT_WORD = 'AUTOPILOT';
const SENIORITY: Profile['targets']['seniority'] = ['intern', 'graduate', 'junior', 'executive', 'mid'];
const ANSWER_TYPES: NonNullable<AnswerEntry['type']>[] = ['text', 'select', 'yesno', 'number', 'url'];

function refresh(): void {
  revalidatePath('/settings');
  revalidatePath('/');
}

function errorMessage(err: unknown): string {
  if (err instanceof SettingsValidationError || err instanceof ConfigError) return err.message;
  return (err as Error)?.message ?? String(err);
}

function applySettings(patch: DeepPartial<Settings>, message: string): ActionResult {
  try {
    updateSettings(patch);
    refresh();
    return ok(message);
  } catch (err) {
    return fail(errorMessage(err));
  }
}

// ───────────────────────────── Mode + pause ─────────────────────────────

export async function setPausedAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const paused = fd.get('paused') === '1';
  log.info('settings', paused ? 'paused all outbound actions' : 'resumed outbound actions');
  return applySettings({ paused }, paused ? 'Paused. Nothing will be submitted or sent.' : 'Resumed.');
}

/** Turning autopilot on requires typing AUTOPILOT; turning it off never does. */
export async function setModeAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const mode = formString(fd, 'mode');
  if (mode === 'review') {
    log.info('settings', 'autopilot off (review mode)');
    return applySettings({ mode: 'review', autopilot: { enabled: false } }, 'Review mode: everything waits for your approval.');
  }
  if (mode !== 'autopilot') return fail('Unknown mode.');
  if (formString(fd, 'confirmText').trim() !== AUTOPILOT_WORD) return fail(`Type ${AUTOPILOT_WORD} to turn on autopilot.`);
  log.warn('settings', 'autopilot enabled from dashboard');
  return applySettings({ mode: 'autopilot', autopilot: { enabled: true } }, 'Autopilot on, within the hard limits shown.');
}

const HANDS_FREE_WORD = 'HANDS-FREE';

/**
 * Hands-free: Kayzee's "do the whole application for me" mode. Turning it on requires typing HANDS-FREE.
 * Truth guard, CAPTCHA/account-wall hand-offs, caps and the pause switch still apply; emails still need his tap.
 */
export async function setHandsFreeAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const on = fd.get('on') === '1';
  if (!on) {
    log.info('settings', 'hands-free off');
    return applySettings({ mode: 'review', autopilot: { enabled: false, handsFree: false } }, 'Hands-free off: everything waits for your approval again.');
  }
  if (formString(fd, 'confirmText').trim().toUpperCase() !== HANDS_FREE_WORD) return fail(`Type ${HANDS_FREE_WORD} to turn it on.`);
  const s = getSettings();
  log.warn('settings', 'hands-free enabled from dashboard');
  return applySettings(
    { mode: 'autopilot', autopilot: { enabled: true, handsFree: true, minScore: Math.max(s.minScore, 60), dailyCap: Math.min(25, s.dailyApplyCap), requireAllAnswers: false } },
    'Hands-free on: Pursuit applies by itself and texts you when it needs an answer.',
  );
}

export async function saveAutopilotLimitsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const current = getSettings();
  const minScore = parseNumber(fd.get('minScore'));
  const dailyCap = parseNumber(fd.get('dailyCap'));
  if (minScore === undefined || minScore < current.minScore || minScore > 100) {
    return fail(`Autopilot minimum score must be between your review minimum (${current.minScore}) and 100.`);
  }
  if (dailyCap === undefined || !Number.isInteger(dailyCap) || dailyCap < 0 || dailyCap > current.dailyApplyCap) {
    return fail(`Autopilot daily cap must be a whole number from 0 to your overall cap (${current.dailyApplyCap}).`);
  }
  const ats = fd.getAll('ats').filter((a): a is AtsKind => typeof a === 'string' && (AUTOPILOT_ATS as string[]).includes(a));
  // requireAllAnswers stays true: SPEC §7 requires every question answered from the bank.
  return applySettings({ autopilot: { minScore, dailyCap, ats, requireAllAnswers: true } }, 'Autopilot limits saved.');
}

// ───────────────────────────── Caps + schedule ─────────────────────────────

export async function saveCapsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const num = (k: string) => parseNumber(fd.get(k));
  const fields = {
    dailyApplyCap: num('dailyApplyCap'),
    dailyEmailCap: num('dailyEmailCap'),
    dailyTailorCap: num('dailyTailorCap'),
    minScore: num('minScore'),
    autoSkipBelow: num('autoSkipBelow'),
    followUpDays: num('followUpDays'),
    discoveryEveryHours: num('discoveryEveryHours'),
  };
  const missing = Object.entries(fields).filter(([, v]) => v === undefined).map(([k]) => k);
  if (missing.length) return fail(`Fill in every number (missing: ${missing.join(', ')}).`);
  if (fields.autoSkipBelow! > fields.minScore!) return fail('Auto-skip threshold must be at or below the minimum score.');
  const current = getSettings();
  const autopilot = current.autopilot.dailyCap > fields.dailyApplyCap! ? { dailyCap: fields.dailyApplyCap! } : undefined;
  return applySettings(
    {
      dailyApplyCap: fields.dailyApplyCap,
      dailyEmailCap: fields.dailyEmailCap,
      dailyTailorCap: fields.dailyTailorCap,
      minScore: fields.minScore,
      autoSkipBelow: fields.autoSkipBelow,
      followUpDays: fields.followUpDays,
      discoveryEveryHours: fields.discoveryEveryHours,
      quietHours: { start: formString(fd, 'quietStart'), end: formString(fd, 'quietEnd') },
      ...(autopilot ? { autopilot } : {}),
    },
    autopilot ? 'Saved. Autopilot cap lowered to match the daily cap.' : 'Saved.',
  );
}

// ───────────────────────────── Profile ─────────────────────────────

const lines = (fd: FormData, key: string) => parseList(formString(fd, key), /\n/);
const commaLines = (fd: FormData, key: string) => parseList(formString(fd, key));
const optionalUrl = (fd: FormData, key: string) => formString(fd, key).trim() || undefined;

export async function saveProfileAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const current = loadProfile();
    const maxYears = parseNumber(fd.get('maxYearsRequired'));
    const salary = parseNumber(fd.get('salaryFloorEUR'));
    if (maxYears === undefined || maxYears < 0) return fail('Max years required must be 0 or more.');
    if (salary === undefined || salary < 0) return fail('Salary floor must be 0 or more.');
    const links: Profile['links'] = {};
    for (const k of ['linkedin', 'portfolio', 'website', 'github'] as const) {
      const v = optionalUrl(fd, `link_${k}`);
      if (v && !/^https?:\/\//i.test(v)) return fail(`${k} link must start with https://`);
      if (v) links[k] = v;
    }
    const next: Profile = {
      ...current,
      name: {
        first: formString(fd, 'first').trim(),
        last: formString(fd, 'last').trim(),
        preferred: formString(fd, 'preferred').trim(),
        full: formString(fd, 'full').trim(),
      },
      email: formString(fd, 'email').trim(),
      phone: formString(fd, 'phone').trim(),
      location: formString(fd, 'location').trim(),
      links,
      targets: {
        ...current.targets,
        roles: lines(fd, 'roles'),
        keywords: lines(fd, 'keywords'),
        locations: commaLines(fd, 'locations').map((l) => l.toLowerCase()),
        secondaryLocations: commaLines(fd, 'secondaryLocations').map((l) => l.toLowerCase()),
        remoteOk: fd.get('remoteOk') === 'on',
        seniority: SENIORITY.filter((s) => fd.getAll('seniority').includes(s)),
        excludeTitleWords: commaLines(fd, 'excludeTitleWords').map((w) => w.toLowerCase()),
        maxYearsRequired: maxYears,
        salaryFloorEUR: salary,
        blacklistCompanies: commaLines(fd, 'blacklistCompanies'),
        languages: commaLines(fd, 'languages'),
      },
      coverLetter: {
        signOff: formString(fd, 'signOff').replace(/\r\n/g, '\n').trim() || current.coverLetter.signOff,
        voiceNotes: lines(fd, 'voiceNotes'),
      },
    };
    if (!next.name.first || !next.name.full) return fail('First name and full name are required.');
    if (!next.targets.seniority.length) return fail('Pick at least one seniority level.');
    saveProfile(next);
    refresh();
    return ok('Profile saved. New searches and scores use it from the next run.');
  } catch (err) {
    log.error('dashboard', 'save profile failed', err);
    return fail(errorMessage(err));
  }
}

export async function saveWorkAuthAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const current = loadProfile();
    const summary = formString(fd, 'summary').trim();
    if (!summary) return fail('Summary is required.');
    const raw = formString(fd, 'needsSponsorship');
    const needsSponsorship = raw === 'yes' ? true : raw === 'no' ? false : null;
    const confirmed = fd.get('confirmAccurate') === 'on';
    saveProfile({ ...current, workAuth: { summary, needsSponsorship, confirm: !confirmed } });
    refresh();
    return ok(confirmed ? 'Saved and confirmed. Forms can use this wording.' : 'Saved. Still marked unconfirmed.');
  } catch (err) {
    return fail(errorMessage(err));
  }
}

// ───────────────────────────── Fact bank ─────────────────────────────

/** `intent=validate` checks the JSON against the schema; `intent=save` validates then writes facts.json. */
export async function factsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const text = formString(fd, 'json');
  const check = validateConfigJson('facts', text);
  if (!check.ok) return fail(check.error);
  const bank = JSON.parse(text) as FactBank;
  const ids = bank.facts.map((f) => f.id);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length) return fail(`Duplicate fact ids: ${dupes.join(', ')}`);
  const summary = `${bank.facts.length} facts, ${bank.skills.length} skills, ${bank.tools.length} tools, ${bank.doNotClaim.length} do-not-claim`;
  if (formString(fd, 'intent') !== 'save') return ok(`Valid: ${summary}.`);
  try {
    saveFacts(bank);
    log.info('settings', 'fact bank saved from dashboard', { facts: bank.facts.length });
    refresh();
    return ok(`Saved: ${summary}. New drafts use it; existing drafts aren't rewritten.`);
  } catch (err) {
    return fail(errorMessage(err));
  }
}

// ───────────────────────────── Answer bank ─────────────────────────────

function answerFromForm(fd: FormData, existing?: AnswerEntry): AnswerEntry | string {
  const answer = formString(fd, 'answer').trim();
  // A blank answer on an existing entry means "always ask me"; new entries need an answer.
  if (!answer && !existing) return 'Answer is required.';
  const patterns = fd.has('patterns') ? parseList(formString(fd, 'patterns'), /\n/).map((p) => p.toLowerCase()) : existing?.patterns ?? [];
  if (!patterns.length) return 'Add at least one question pattern.';
  const typeRaw = formString(fd, 'type');
  const type = (ANSWER_TYPES as string[]).includes(typeRaw) ? (typeRaw as AnswerEntry['type']) : existing?.type;
  const notes = fd.has('notes') ? formString(fd, 'notes').trim() || undefined : existing?.notes;
  return { ...existing, id: existing?.id ?? '', patterns, answer, type, notes };
}

/** Per-entry actions: `intent` = save | confirm | remove. */
export async function answerRowAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const bank = loadAnswers();
    const id = formString(fd, 'id');
    const existing = bank.entries.find((e) => e.id === id);
    if (!existing) return fail('That answer no longer exists.');
    switch (formString(fd, 'intent')) {
      case 'confirm':
        if (!existing.answer.trim()) return fail('Write an answer before confirming it.');
        saveAnswers(confirmAnswerEntry(bank, id));
        log.info('settings', `answer confirmed: ${id}`);
        break;
      case 'remove':
        saveAnswers(removeAnswerEntry(bank, id));
        break;
      case 'save': {
        const entry = answerFromForm(fd, existing);
        if (typeof entry === 'string') return fail(entry);
        // Changing the wording of a confirmed answer needs confirming again.
        const confirm = existing.confirm || entry.answer !== existing.answer ? true : existing.confirm;
        saveAnswers(upsertAnswerEntry(bank, { ...entry, confirm }));
        break;
      }
      default:
        return fail('Unknown action.');
    }
    refresh();
    return ok('Saved.');
  } catch (err) {
    return fail(errorMessage(err));
  }
}

export async function addAnswerAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const bank = loadAnswers();
    const entry = answerFromForm(fd);
    if (typeof entry === 'string') return fail(entry);
    let id = slugify(formString(fd, 'id') || entry.patterns[0]);
    for (let n = 2; bank.entries.some((e) => e.id === id); n++) id = `${slugify(entry.patterns[0])}-${n}`;
    // New entries start unconfirmed until Kayzee confirms them explicitly.
    saveAnswers(upsertAnswerEntry(bank, { ...entry, id, confirm: true }));
    refresh();
    return ok(`Added "${id}". Confirm it when the wording is right.`);
  } catch (err) {
    return fail(errorMessage(err));
  }
}

// ───────────────────────────── System ─────────────────────────────

export async function rerunDoctorAction(): Promise<ActionResult> {
  refresh();
  return ok('Checks re-run.');
}

export async function demoDataAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  if (!seedScriptAvailable()) return fail('scripts/seed.ts is not available.');
  const clear = formString(fd, 'intent') === 'clear';
  const result = await runSeedScript(clear ? ['--clear'] : []);
  revalidatePath('/', 'layout');
  return result.ok ? ok(clear ? `Demo data cleared.\n${result.output}` : `Demo data added.\n${result.output}`) : fail(result.output);
}
