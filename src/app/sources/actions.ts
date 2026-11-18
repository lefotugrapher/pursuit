'use server';

import { revalidatePath } from 'next/cache';
import { fail, ok, type ActionResult } from '@/components/settings/action-result';
import { loadSources, saveSources } from '@/lib/config';
import { hasAdzuna, hasMail } from '@/lib/env';
import { log } from '@/lib/log';
import { formString, isBoardAts, isValidBoardToken, parseList, parseNumber, testBoard, type BoardAts } from '@/lib/server-more';
import { todayDublin } from '@/lib/time';
import type { SourcesConfig, WatchCompany } from '@/lib/types';

const companyKey = (c: Pick<WatchCompany, 'ats' | 'token'>) => `${c.ats}:${c.token.toLowerCase()}`;

function persist(next: SourcesConfig, message: string): ActionResult {
  saveSources(next);
  revalidatePath('/sources');
  return ok(message);
}

function describeTest(r: Awaited<ReturnType<typeof testBoard>>): string {
  return r.ok ? `${r.total} open job${r.total === 1 ? '' : 's'}, ${r.ireland} in Ireland/NI` : `Test failed: ${r.error}`;
}

function readBoard(fd: FormData): { ats?: BoardAts; token?: string; error?: string } {
  const ats = formString(fd, 'ats');
  const token = formString(fd, 'token').trim();
  if (!isBoardAts(ats)) return { error: 'Pick an ATS.' };
  if (!isValidBoardToken(token)) return { error: 'Token can only contain letters, numbers, dot, dash and underscore.' };
  return { ats, token };
}

/** Add-company form: `intent=test` only checks the board; `intent=add` checks then saves. */
export async function addCompanyAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const { ats, token, error } = readBoard(fd);
    if (!ats || !token) return fail(error ?? 'Invalid board.');
    const result = await testBoard(ats, token);
    if (formString(fd, 'intent') === 'test') return result.ok ? ok(describeTest(result)) : fail(describeTest(result));

    if (!result.ok) return fail(`${describeTest(result)}. Not added: check the token on the company's careers page.`);
    const sources = loadSources();
    if (sources.companies.some((c) => companyKey(c) === companyKey({ ats, token }))) return fail('That board is already on the watchlist.');
    const name = formString(fd, 'name').trim() || token;
    const company: WatchCompany = { name, ats, token, enabled: true, tags: parseList(formString(fd, 'tags')), verifiedAt: todayDublin() };
    const companies = [...sources.companies, company].sort((a, b) => a.name.localeCompare(b.name));
    log.info('sources', `watchlist add ${name} (${ats}/${token})`);
    return persist({ ...sources, companies }, `Added ${name}: ${describeTest(result)}.`);
  } catch (err) {
    log.error('dashboard', 'add company failed', err);
    return fail(`Couldn't add: ${(err as Error).message}`);
  }
}

/** Per-row actions on the watchlist: toggle | test | remove. */
export async function companyRowAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const { ats, token, error } = readBoard(fd);
    if (!ats || !token) return fail(error ?? 'Invalid board.');
    const sources = loadSources();
    const key = companyKey({ ats, token });
    const index = sources.companies.findIndex((c) => companyKey(c) === key);
    if (index < 0) return fail('That board is no longer on the watchlist.');
    const company = sources.companies[index];
    const companies = [...sources.companies];

    switch (formString(fd, 'intent')) {
      case 'toggle':
        companies[index] = { ...company, enabled: !company.enabled };
        return persist({ ...sources, companies }, `${company.name} ${company.enabled ? 'paused' : 'enabled'}.`);
      case 'remove':
        companies.splice(index, 1);
        log.info('sources', `watchlist remove ${company.name} (${ats}/${token})`);
        return persist({ ...sources, companies }, `Removed ${company.name}.`);
      case 'test': {
        const result = await testBoard(ats, token);
        if (!result.ok) return fail(`${company.name}: ${describeTest(result)}`);
        companies[index] = { ...company, verifiedAt: todayDublin() };
        return persist({ ...sources, companies }, `${company.name}: ${describeTest(result)}.`);
      }
      default:
        return fail('Unknown action.');
    }
  } catch (err) {
    log.error('dashboard', 'watchlist row action failed', err);
    return fail(`Couldn't update: ${(err as Error).message}`);
  }
}

const MAX_QUERIES = 40;

/** Saves the LinkedIn guest search rows (`kw_<i>` × `loc_<i>`), enabled flag and per-query cap. */
export async function saveLinkedInAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const sources = loadSources();
    const rows = Number(parseNumber(fd.get('rows')) ?? 0);
    const queries: SourcesConfig['linkedinGuest']['queries'] = [];
    const seen = new Set<string>();
    for (let i = 0; i < Math.min(rows, 200); i++) {
      const keywords = formString(fd, `kw_${i}`).trim().slice(0, 120);
      const location = formString(fd, `loc_${i}`).trim().slice(0, 120);
      if (!keywords || fd.get(`rm_${i}`) === 'on') continue;
      const key = `${keywords.toLowerCase()}|${location.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push({ keywords, location });
    }
    if (queries.length > MAX_QUERIES) return fail(`Keep it to ${MAX_QUERIES} searches or fewer: each one is a slow, rate-limited crawl.`);
    const maxPerQuery = Math.round(parseNumber(fd.get('maxPerQuery')) ?? sources.linkedinGuest.maxPerQuery);
    if (maxPerQuery < 1 || maxPerQuery > 100) return fail('Results per search must be between 1 and 100.');
    const linkedinGuest = { ...sources.linkedinGuest, enabled: fd.get('enabled') === 'on', queries, maxPerQuery };
    return persist({ ...sources, linkedinGuest }, `Saved ${queries.length} LinkedIn search${queries.length === 1 ? '' : 'es'}.`);
  } catch (err) {
    log.error('dashboard', 'save linkedin queries failed', err);
    return fail(`Couldn't save: ${(err as Error).message}`);
  }
}

/** Toggles a feed-level source: `source` = adzuna | gmailAlerts. */
export async function toggleFeedAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const sources = loadSources();
    const which = formString(fd, 'source');
    if (which === 'adzuna') {
      const enabled = !sources.adzuna.enabled;
      if (enabled && !hasAdzuna()) return fail('Add ADZUNA_APP_ID and ADZUNA_APP_KEY to .env.local first (free at developer.adzuna.com).');
      return persist({ ...sources, adzuna: { ...sources.adzuna, enabled } }, `Adzuna ${enabled ? 'on' : 'off'}.`);
    }
    if (which === 'gmailAlerts') {
      const enabled = !sources.gmailAlerts.enabled;
      const note = enabled && !hasMail() ? ' It starts working once Gmail is connected (see Inbox).' : '';
      return persist({ ...sources, gmailAlerts: { enabled } }, `Gmail job alerts ${enabled ? 'on' : 'off'}.${note}`);
    }
    return fail('Unknown source.');
  } catch (err) {
    log.error('dashboard', 'toggle feed failed', err);
    return fail(`Couldn't update: ${(err as Error).message}`);
  }
}
