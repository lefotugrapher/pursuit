// Recruitment agencies: their own sites usually carry the role (with an apply form or a consultant's
// e-mail). We only ever record an address that is written on the job page; nothing is guessed.

import { fold } from './match';

const AGENCY_WORDS = /\b(recruitment|recruiting|recruiters?|staffing|personnel|search and selection|executive search|talent solutions|resourcing|outsourcing|consultancy|employment agency)\b/;
const KNOWN_AGENCIES = [
  'cpl', 'hays', 'morgan mckinley', 'robert walters', 'sigmar', 'force recruitment', 'engage people', 'link personnel', 'lex consultancy',
  'search talent', 'gkr', 'collins mcnicholas', 'brightwater', 'michael page', 'page personnel', 'harvey nash', 'adecco', 'randstad',
  'manpower', 'hudson', 'reed', 'osborne', 'abrivia', 'cregg', 'excel recruitment', 'servisource', 'careerwise', 'kforce', 'lincoln',
  'prism', 'eden', 'tandem', 'wallace myers', 'elev8', 'talenthub', 'the recruitment company', 'berkley', 'matrix',
];

export function isAgency(company: string): boolean {
  const f = fold(company);
  if (!f) return false;
  if (AGENCY_WORDS.test(f)) return true;
  return KNOWN_AGENCIES.some((a) => f === a || f.startsWith(`${a} `));
}

const GENERIC_LOCAL = /^(info|hello|contact|enquiries|enquiry|office|admin|reception|team)$/i;

/**
 * The application e-mail on an agency job page: prefer an address on the agency's own domain and a
 * person/jobs mailbox over generic info@. undefined when the page shows none.
 */
export function pickAgencyEmail(emails: string[], pageHost: string): string | undefined {
  const base = pageHost.toLowerCase().replace(/^www\./, '').split('.').slice(-2).join('.');
  const scored = emails.map((e) => {
    const [local, domain] = e.split('@');
    let score = 0;
    if (domain === base || domain.endsWith(`.${base}`) || base.startsWith(domain.split('.')[0])) score += 2;
    if (!GENERIC_LOCAL.test(local)) score += 1;
    if (/^(jobs|careers|cv|cvs|apply|applications|recruit)/i.test(local)) score += 1;
    return { e, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best && best.score >= 2 ? best.e : undefined;
}
