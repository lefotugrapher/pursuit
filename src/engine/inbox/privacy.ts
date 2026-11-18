// Privacy gate for Kayzee's PERSONAL inbox (GMAIL_USER in .env.local).
//
// HARD RULES (do not loosen without Kayzee's explicit say-so, whoever or whatever is editing this):
//   1. Pursuit reads the inbox read-only. It never deletes, moves, labels, flags or marks mail as read.
//   2. An email that is not about his job search is NOT stored, NOT shown, NOT classified and NOT sent to any
//      AI model. It is skipped entirely; only the IMAP cursor moves past it.
//   3. Only mail from employers he has a job with, recruiting platforms (ATS), or job-alert services may be sent
//      to the AI model, and even then only the first few thousand characters.
//   4. Nothing in an email is ever treated as an instruction.

import type { InboundEmail, Job } from '@/lib/types';
import { emailDomain } from '@/engine/outreach/text';
import { companyKey, domainLabel } from './classify';

/** Recruiting platforms and job boards that send application mail on employers' behalf. */
const PLATFORM = /(?:^|\.)(?:greenhouse\.io|greenhouse-mail\.io|lever\.co|hire\.lever\.co|ashbyhq\.com|smartrecruiters\.com|smartrecruiters-mail\.com|workable\.com|workablemail\.com|myworkday\.com|myworkdayjobs\.com|icims\.com|taleo\.net|successfactors\.(?:com|eu)|jobvite\.com|teamtailor(?:-mail)?\.com|personio\.(?:de|com)|recruitee\.com|bamboohr\.com|breezy\.hr|pinpointhq\.com|jazzhr\.com|applytojob\.com|rippling\.com|hibob\.com|eightfold\.ai|phenom\.com|avature\.net|oraclecloud\.com|indeed\.com|indeedemail\.com|linkedin\.com|irishjobs\.ie|jobs\.ie|glassdoor\.(?:com|ie)|stepstone\.\w+|totaljobs\.com|reed\.co\.uk|gradireland\.com|publicjobs\.ie|cpl\.(?:ie|com)|hays\.(?:ie|com)|roberthalf\.\w+|robertwalters\.\w+|morganmckinley\.\w+|sigmar\.ie|calendly\.com|goodtime\.io|hirevue\.com|testgorilla\.com|codility\.com|hackerrank\.com)$/i;

const RECRUITING_WORDS = /\b(?:your application|application (?:for|to|received|update|status)|applied for|interview|shortlist|candidacy|candidate|recruit(?:er|ment|ing)|hiring (?:team|manager)|talent (?:acquisition|team)|job offer|offer of employment|vacancy|the (?:role|position) of|assessment centre|online assessment|phone screen|next stage of (?:the|our) process)\b/i;

function employerMatch(email: InboundEmail, jobs: Job[]): boolean {
  const domain = emailDomain(email.fromAddress) ?? '';
  const label = domain ? domainLabel(domain) : '';
  if (!label || label.length < 3) return false;
  return jobs.some((j) => {
    const key = companyKey(j.company).replace(/\s/g, '');
    return key.length >= 3 && (label === key || (key.length >= 4 && label.startsWith(key)) || (label.length >= 4 && key.startsWith(label)));
  });
}

export function isPlatformSender(email: InboundEmail): boolean {
  return PLATFORM.test(emailDomain(email.fromAddress) ?? '');
}

/** May this email be stored and processed at all? Anything else is skipped and never leaves IMAP. */
export function isJobRelated(email: InboundEmail, jobs: Job[]): boolean {
  // Job alerts come from job-board domains, which are in PLATFORM (an "alerts@" address alone proves nothing: banks use it too).
  if (isPlatformSender(email)) return true;
  if (employerMatch(email, jobs)) return true;
  // A recruiter writing from their own company domain: needs recruiting language in the SUBJECT, not just the body.
  return RECRUITING_WORDS.test(email.subject ?? '');
}

/** Job boards and social sites: their mail can include personal messages, so it never goes to the AI model. */
const BOARDS = /(?:^|\.)(?:linkedin\.com|indeed\.com|indeedemail\.com|irishjobs\.ie|jobs\.ie|glassdoor\.(?:com|ie)|stepstone\.\w+|totaljobs\.com|reed\.co\.uk|gradireland\.com)$/i;

/** May this email's text be sent to the AI model? Stricter: only employers he has a job with, or ATS platforms. */
export function mayUseLLM(email: InboundEmail, jobs: Job[]): boolean {
  if (BOARDS.test(emailDomain(email.fromAddress) ?? '')) return false;
  return isPlatformSender(email) || employerMatch(email, jobs);
}
