// Skills / tools / duties lexicon for PR, communications, content, social, digital marketing,
// events, SEO, analytics and design/video roles, plus the text normaliser every matcher shares.
//
// Matching works on normalised token streams: lowercase, diacritics stripped, US spellings mapped
// to UK ones, and a light stemmer so "press release" ~ "press releases" and "organise events" ~
// "organising events". The same normaliser runs on JD text, lexicon phrases and fact text, so
// whatever the stemmer does it does consistently on both sides.

import type { Keyword } from '@/lib/types';

export type KeywordKind = Keyword['kind'];

export interface LexiconEntry {
  /** Canonical display term (what the UI and reasons show). */
  term: string;
  kind: KeywordKind;
  /** Other phrasings that mean the same thing. The term itself is always a variant. */
  synonyms: string[];
  /**
   * Phrases that, when found in a FACT, prove this keyword even though no synonym is there
   * (e.g. "wrote press releases" proves written communication). Never used on the JD side.
   * Keep these conservative: a match here becomes a claimable alignment.
   */
  evidence?: string[];
  /** Relative importance multiplier (default 1). Generic terms get less. */
  importance?: number;
}

// ───────────────────────────── Text normalisation ─────────────────────────────

const SPELLING: Record<string, string> = {
  color: 'colour', colors: 'colours', coloring: 'colouring', colored: 'coloured',
  center: 'centre', centers: 'centres', program: 'programme', programs: 'programmes',
  license: 'licence', licenses: 'licences', analyze: 'analyse', analyzed: 'analysed',
  analyzing: 'analysing', analyzes: 'analyses', catalog: 'catalogue', behavior: 'behaviour',
  favorite: 'favourite', labor: 'labour', traveling: 'travelling', modeling: 'modelling',
  enquiry: 'inquiry', enquiries: 'inquiries', judgment: 'judgement', fulfill: 'fulfil',
};

const IZE = /^([a-z]{3,})iz(e|es|ed|ing|ation|ations|er|ers)$/;
const DOUBLE_FINAL = /([bdgmnprt])\1$/;

/** Light, deterministic stemmer. Only consistency matters: both sides go through it. */
export function stemToken(token: string): string {
  if (token.length <= 3 || /\d/.test(token)) return token;
  let s = token;
  if (s.endsWith('ies') && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (/(ches|shes|sses|xes|zes)$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith('s') && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);

  if (s.endsWith('ing') && s.length >= 6) s = undouble(s.slice(0, -3));
  else if (s.endsWith('ed') && s.length >= 5) s = undouble(s.slice(0, -2));

  if (s.endsWith('e') && s.length > 3) s = s.slice(0, -1);
  return s;
}

function undouble(s: string): string {
  return DOUBLE_FINAL.test(s) ? s.slice(0, -1) : s;
}

function canonicalToken(raw: string): string {
  const spelled = SPELLING[raw] ?? raw.replace(IZE, '$1is$2');
  return stemToken(spelled);
}

/** Lowercase, strip accents and punctuation, unify a few compound spellings. */
export function cleanText(text: string): string {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['‘’`]/g, '')
    .replace(/\be-mail/g, 'email')
    .replace(/\bp\.\s?r\.(?=\s|$|[,;:)])/g, ' pr ')
    .replace(/&/g, ' and ');
}

/** Normalised token stream for matching. */
export function tokenize(text: string): string[] {
  return cleanText(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(canonicalToken);
}

/** Space-padded normalised string, for cheap `includes(' phrase ')` checks. */
export function normalizedHaystack(text: string): string {
  return ` ${tokenize(text).join(' ')} `;
}

/** Normalised form of a phrase (no padding). */
export function normalizePhrase(phrase: string): string {
  return tokenize(phrase).join(' ');
}

/** True when `phrase` occurs as whole tokens inside the padded haystack. */
export function haystackHas(haystack: string, phrase: string): boolean {
  const p = normalizePhrase(phrase);
  return p.length > 0 && haystack.includes(` ${p} `);
}

// ───────────────────────────── Lexicon ─────────────────────────────

const e = (
  term: string,
  kind: KeywordKind,
  synonyms: string[] = [],
  extra: Pick<LexiconEntry, 'evidence' | 'importance'> = {},
): LexiconEntry => ({ term, kind, synonyms, ...extra });

export const LEXICON: readonly LexiconEntry[] = [
  // ── PR & communications ──
  e('public relations', 'skill', ['pr', 'pr campaigns', 'pr activity', 'pr activities', 'pr strategy', 'pr plans']),
  e('press releases', 'skill', ['press release', 'news release', 'media release', 'press notice', 'press announcements']),
  e('media relations', 'skill', [
    'media relations', 'press relations', 'journalist relations', 'relationships with journalists',
    'relationships with the media', 'relationships with media', 'liaise with media', 'liaising with media',
    'liaise with journalists', 'liaising with journalists', 'media liaison', 'media contacts', 'press office',
  ]),
  e('media pitching', 'duty', ['pitching to journalists', 'pitch to journalists', 'pitch stories', 'media pitches', 'sell in stories', 'selling in stories', 'story pitching']),
  e('media lists', 'duty', ['media list', 'press list', 'media database', 'journalist database']),
  e('press kits', 'skill', ['press kit', 'media kit', 'press pack', 'media pack']),
  e('media monitoring', 'duty', ['media monitoring', 'monitor media', 'monitoring media', 'press cuttings', 'media tracking']),
  e('coverage reporting', 'duty', ['coverage report', 'coverage reports', 'coverage analysis', 'media coverage', 'press coverage', 'secure coverage', 'securing coverage', 'evaluation reports']),
  e('media queries', 'duty', ['media queries', 'press queries', 'media inquiries', 'press inquiries', 'journalist queries', 'responding to journalists']),
  e('media statements', 'duty', ['media statement', 'press statement', 'holding statement', 'holding statements']),
  e('briefing documents', 'duty', ['briefing document', 'briefing notes', 'briefing note', 'briefing docs', 'briefing papers']),
  e('crisis communications', 'skill', ['crisis communications', 'crisis comms', 'issues management', 'crisis management', 'reputation management']),
  e('internal communications', 'skill', ['internal communications', 'internal comms', 'employee communications', 'staff communications', 'internal newsletters']),
  e('external communications', 'skill', ['external communications', 'external comms']),
  e('corporate communications', 'skill', ['corporate communications', 'corporate comms', 'corporate affairs']),
  e('communications', 'domain', ['communications', 'comms', 'communications strategy', 'communications plans', 'communication plans'], { importance: 0.9 }),
  e('stakeholder engagement', 'skill', [
    'stakeholder engagement', 'stakeholder management', 'stakeholder relations', 'stakeholder communications',
    'engage with stakeholders', 'engaging with stakeholders', 'engage stakeholders', 'working with stakeholders',
    'work with stakeholders', 'liaise with stakeholders', 'liaising with stakeholders', 'stakeholder relationships',
  ]),
  e('influencer outreach', 'skill', ['influencer marketing', 'influencer outreach', 'influencer relations', 'influencer campaigns', 'influencers', 'creator partnerships', 'creator outreach']),
  e('event PR', 'skill', ['event pr', 'event publicity', 'event promotion']),
  e('campaign planning', 'skill', ['campaign strategy', 'campaign planning', 'plan campaigns', 'planning campaigns', 'campaign management', 'integrated campaigns', 'deliver campaigns', 'campaign delivery', 'campaign execution']),
  e('marketing communications', 'skill', ['marketing communications', 'marcomms', 'marcom']),
  e('copywriting', 'skill', ['copywriting', 'copy writing', 'write copy', 'writing copy', 'copywriter', 'marketing copy', 'compelling copy', 'engaging copy']),
  e('content writing', 'skill', ['content writing', 'blog writing', 'writing blogs', 'blog posts', 'articles', 'write articles', 'writing articles', 'web copy', 'website copy']),
  e('proofreading', 'skill', ['proofreading', 'proof reading', 'proofread', 'copy editing', 'copyediting', 'editing copy', 'sub editing']),
  e('speechwriting', 'skill', ['speech writing', 'speechwriting', 'speeches', 'writing speeches']),
  e('public affairs', 'domain', ['government relations', 'lobbying', 'policy communications']),
  e('presentations', 'skill', ['presentations', 'presenting', 'public speaking', 'presentation skills', 'deliver presentations', 'delivering presentations'], { evidence: ['presented'] }),

  // ── Content & social ──
  e('content creation', 'skill', ['content creation', 'create content', 'creating content', 'content production', 'produce content', 'producing content', 'content creator', 'content development', 'develop content', 'developing content', 'creative content']),
  e('content strategy', 'skill', ['content strategy', 'content planning', 'content plan', 'content plans', 'content calendar', 'content calendars', 'editorial calendar', 'content schedule']),
  e('social media content', 'skill', ['social media content', 'social content', 'content for social media', 'social media posts', 'social posts', 'social media copy', 'social output']),
  e('social media management', 'skill', [
    'social media management', 'manage social media', 'managing social media', 'social media manager',
    'manage social channels', 'managing social channels', 'manage our social channels', 'social media accounts',
    'run social media', 'running social media', 'social media channels', 'own our social channels',
  ]),
  e('social media', 'domain', ['social media', 'social channels', 'social platforms', 'social media platforms']),
  e('community management', 'skill', ['community management', 'community manager', 'online community', 'moderate comments', 'responding to comments', 'social listening']),
  e('community engagement', 'skill', ['community engagement', 'community outreach', 'engage the community', 'community relations', 'local engagement']),
  e('short-form video', 'skill', ['short form video', 'short form content', 'vertical video', 'reels', 'instagram reels', 'tiktok videos', 'youtube shorts']),
  e('video production', 'skill', ['video production', 'video content', 'produce video', 'producing video', 'produce videos', 'filming', 'videography', 'videographer', 'shoot video', 'shooting video', 'film content']),
  e('video editing', 'skill', ['video editing', 'edit video', 'editing video', 'edit videos', 'video editor', 'post production', 'editing footage']),
  e('photography', 'skill', ['photography', 'photographer', 'photo shoots', 'photoshoots', 'take photos', 'taking photos']),
  e('photo editing', 'skill', ['photo editing', 'image editing', 'retouching', 'photo retouching', 'editing images']),
  e('video scripting', 'skill', ['video scripting', 'scriptwriting', 'script writing', 'writing scripts', 'video scripts', 'scripts']),
  e('UGC', 'skill', ['ugc', 'user generated content', 'ugc direction', 'ugc creators']),
  e('brand storytelling', 'skill', ['brand storytelling', 'storytelling', 'tell stories', 'telling stories', 'brand stories', 'brand narrative']),
  e('brand voice', 'skill', ['brand voice', 'tone of voice', 'brand guidelines', 'brand consistency', 'brand identity']),
  e('brand awareness', 'duty', ['brand awareness', 'raise awareness', 'raising awareness', 'build awareness', 'grow awareness', 'brand profile']),
  e('graphic design', 'skill', ['graphic design', 'graphic designer', 'design graphics', 'designing graphics', 'visual assets', 'design assets', 'visual design', 'layout design']),
  e('motion graphics', 'skill', ['motion graphics', 'animation', 'animated content']),
  e('drone videography', 'skill', ['drone', 'drone footage', 'aerial videography', 'aerial filming', 'aerial photography', 'drone piloting']),
  e('podcasts', 'skill', ['podcast', 'podcasting', 'podcast production']),
  e('newsletters', 'duty', ['newsletter', 'email newsletters', 'e newsletter', 'ezine']),

  // ── Digital marketing, SEO & analytics ──
  e('digital marketing', 'skill', ['digital marketing', 'online marketing', 'digital campaigns', 'digital channels', 'digital marketing campaigns']),
  e('marketing', 'domain', ['marketing', 'marketing campaigns', 'marketing activity', 'marketing activities', 'marketing plans', 'marketing strategy'], { importance: 0.8 }),
  e('SEO', 'skill', ['seo', 'search engine optimisation', 'organic search', 'search rankings', 'organic traffic']),
  e('on-page SEO', 'skill', ['on page seo', 'on page optimisation', 'technical seo', 'metadata', 'meta descriptions']),
  e('local SEO', 'skill', ['local seo', 'local search', 'local listings']),
  e('keyword research', 'skill', ['keyword research', 'keyword clustering', 'keyword analysis', 'keyword strategy']),
  e('link building', 'skill', ['link building', 'backlinks', 'backlink', 'outreach links']),
  e('PPC', 'skill', ['ppc', 'pay per click', 'paid search', 'sem', 'search engine marketing', 'search ads']),
  e('paid social', 'skill', ['paid social', 'social ads', 'social media advertising', 'paid social campaigns', 'social advertising']),
  e('paid media', 'skill', ['paid media', 'media buying', 'paid campaigns', 'paid advertising', 'online advertising', 'digital advertising']),
  e('email marketing', 'skill', ['email marketing', 'email campaigns', 'email journeys', 'email automation', 'email marketing campaigns', 'edm', 'edms']),
  e('CRM', 'skill', ['crm', 'customer relationship management', 'crm system', 'crm systems']),
  e('marketing automation', 'skill', ['marketing automation', 'automation', 'automated workflows', 'workflow automation']),
  e('lead generation', 'skill', ['lead generation', 'lead gen', 'generate leads', 'generating leads', 'lead funnels', 'demand generation']),
  e('conversion rate optimisation', 'skill', ['conversion rate optimisation', 'cro', 'a b testing', 'ab testing', 'split testing', 'landing page optimisation']),
  e('ecommerce', 'domain', ['ecommerce', 'e commerce', 'online store', 'online shop']),
  e('analytics and reporting', 'skill', [
    'analytics', 'marketing analytics', 'web analytics', 'social analytics', 'performance reporting', 'campaign reporting',
    'report on performance', 'reporting on performance', 'kpis', 'kpi', 'performance metrics', 'campaign performance',
    'track performance', 'tracking performance', 'measure performance', 'measuring performance', 'data analysis', 'data driven',
    'monthly reports', 'performance reports',
  ]),
  e('market research', 'skill', ['market research', 'competitor research', 'competitor analysis', 'competitive analysis', 'consumer research', 'audience research', 'consumer insights', 'audience insights', 'market analysis']),
  e('research', 'skill', ['research', 'researching', 'desk research', 'primary research', 'surveys', 'case studies'], { importance: 0.8 }),
  e('website management', 'skill', ['website management', 'manage the website', 'managing the website', 'website updates', 'update the website', 'updating the website', 'website content', 'web content', 'content management system', 'cms']),
  e('AI tools', 'skill', ['ai tools', 'generative ai', 'genai', 'gen ai', 'chatgpt', 'prompt design', 'prompt engineering', 'artificial intelligence', 'ai powered', 'large language models', 'llms']),
  e('growth marketing', 'skill', ['growth marketing', 'growth hacking', 'user acquisition', 'customer acquisition']),
  e('product marketing', 'domain', ['product marketing', 'go to market', 'product launches', 'product launch']),
  e('partnerships', 'skill', ['partnerships', 'partnership', 'brand partnerships', 'sponsorship', 'sponsorships', 'collaborations', 'partner marketing']),
  e('budget management', 'skill', ['budget management', 'manage budgets', 'managing budgets', 'manage a budget', 'budgeting', 'budget tracking']),
  e('project management', 'skill', ['project management', 'project manage', 'manage projects', 'managing projects', 'project coordination', 'coordinate projects', 'managing multiple projects', 'manage multiple projects']),

  // ── Events & engagement ──
  e('event management', 'skill', [
    'event management', 'event planning', 'event organisation', 'event organising', 'organise events', 'organising events',
    'plan events', 'planning events', 'event coordination', 'coordinate events', 'coordinating events', 'event delivery',
    'deliver events', 'delivering events', 'run events', 'running events', 'events', 'event logistics',
  ]),
  e('student engagement', 'domain', ['student engagement', 'student experience', 'student voice', 'students union', 'student representation']),
  e('advocacy', 'skill', ['advocacy', 'advocate', 'casework', 'representation']),
  e('fundraising', 'skill', ['fundraising', 'fundraise', 'donor relations', 'donor engagement']),
  e('volunteer management', 'skill', ['volunteer management', 'manage volunteers', 'managing volunteers', 'volunteer coordination']),

  // ── Soft skills (low weight; facts rarely state them, evidence covers the honest cases) ──
  e('written communication', 'soft', ['written communication', 'writing skills', 'excellent writer', 'strong writer', 'written and verbal communication', 'written and oral communication', 'written communication skills'], {
    evidence: ['press releases', 'copywriting', 'marketing copy', 'wrote'],
  }),
  e('verbal communication', 'soft', ['verbal communication', 'oral communication', 'interpersonal skills', 'communication skills'], {
    evidence: ['presented', 'presentations', 'public speaking'],
  }),
  e('attention to detail', 'soft', ['attention to detail', 'eye for detail', 'detail oriented', 'meticulous', 'accuracy']),
  e('organisational skills', 'soft', ['organisational skills', 'organised', 'highly organised', 'multitask', 'multi task', 'juggle multiple', 'prioritise', 'time management'], {
    evidence: ['organised', 'event organisation'],
  }),
  e('teamwork', 'soft', ['teamwork', 'team player', 'collaborative', 'collaborate', 'work as part of a team', 'cross functional']),
  e('creativity', 'soft', ['creativity', 'creative', 'creative flair', 'creative thinking', 'fresh ideas', 'new ideas']),
  e('initiative', 'soft', ['initiative', 'self starter', 'self motivated', 'proactive', 'work independently', 'autonomy', 'entrepreneurial'], {
    evidence: ['co founder', 'cofounder', 'launched'],
  }),
  e('deadlines', 'soft', ['deadlines', 'deadline driven', 'tight deadlines', 'meet deadlines', 'under pressure']),

  // ── Domains / sectors ──
  e('charity sector', 'domain', ['charity', 'charities', 'not for profit', 'nonprofit', 'non profit', 'ngo', 'third sector']),
  e('higher education', 'domain', ['higher education', 'higher education sector', 'university sector', 'third level sector']),
  e('public sector', 'domain', ['public sector', 'government department', 'local authority', 'county council', 'civil service', 'semi state']),
  e('retail', 'domain', ['retail', 'retailer', 'grocery']),
  e('hospitality', 'domain', ['hospitality', 'food and drink', 'food and beverage', 'restaurants']),
  e('tourism', 'domain', ['tourism', 'travel and tourism', 'visitor attractions']),
  e('agency environment', 'domain', ['pr agency', 'communications agency', 'marketing agency', 'creative agency', 'agency side', 'agency environment']),
  e('B2B', 'domain', ['b2b', 'business to business']),
  e('B2C', 'domain', ['b2c', 'consumer brands', 'consumer pr', 'fmcg']),
  e('technology sector', 'domain', ['saas', 'tech company', 'technology company', 'software company', 'fintech']),
  e('sustainability', 'domain', ['sustainability', 'climate', 'renewable energy', 'energy efficiency', 'esg']),
  e('healthcare sector', 'domain', ['healthcare sector', 'healthcare industry', 'health service', 'hse', 'medtech', 'pharma', 'pharmaceutical']),
  e('sport', 'domain', ['sport', 'sports', 'gaa', 'sports club']),

  // ── Tools & platforms ──
  e('Adobe Creative Suite', 'tool', ['adobe creative suite', 'adobe creative cloud', 'adobe cc', 'adobe suite', 'creative cloud', 'adobe']),
  e('Photoshop', 'tool', ['photoshop', 'adobe photoshop']),
  e('Illustrator', 'tool', ['adobe illustrator', 'illustrator']),
  e('InDesign', 'tool', ['indesign', 'adobe indesign']),
  e('Premiere Pro', 'tool', ['premiere pro', 'adobe premiere', 'premiere']),
  e('After Effects', 'tool', ['after effects', 'adobe after effects']),
  e('Lightroom', 'tool', ['lightroom', 'adobe lightroom']),
  e('DaVinci Resolve', 'tool', ['davinci resolve', 'davinci', 'resolve studio']),
  e('Final Cut Pro', 'tool', ['final cut pro', 'final cut']),
  e('Canva', 'tool', ['canva']),
  e('CapCut', 'tool', ['capcut', 'cap cut']),
  e('Figma', 'tool', ['figma']),
  e('Procreate', 'tool', ['procreate']),
  e('Hootsuite', 'tool', ['hootsuite']),
  e('Buffer', 'tool', ['buffer app']),
  e('Sprout Social', 'tool', ['sprout social', 'sprout']),
  e('Later', 'tool', ['later com', 'later app']),
  e('Meta Business Suite', 'tool', ['meta business suite', 'facebook business suite', 'business suite', 'meta business manager']),
  e('Meta Ads Manager', 'tool', ['meta ads manager', 'meta ads', 'facebook ads', 'facebook ads manager', 'instagram ads', 'meta advertising']),
  e('LinkedIn Ads', 'tool', ['linkedin ads', 'linkedin advertising', 'linkedin campaign manager']),
  e('Google Ads', 'tool', ['google ads', 'adwords', 'google adwords']),
  e('Google Analytics', 'tool', ['google analytics', 'ga4', 'google analytics 4', 'universal analytics']),
  e('Google Search Console', 'tool', ['google search console', 'search console']),
  e('Google Tag Manager', 'tool', ['google tag manager', 'tag manager', 'gtm']),
  e('Google Business Profile', 'tool', ['google business profile', 'google my business', 'gmb']),
  e('Google Sheets', 'tool', ['google sheets']),
  e('Google Workspace', 'tool', ['google workspace', 'g suite', 'gsuite', 'google docs', 'google drive']),
  e('Looker Studio', 'tool', ['looker studio', 'google data studio', 'data studio']),
  e('Microsoft Office', 'tool', ['microsoft office', 'ms office', 'microsoft 365', 'office 365', 'microsoft word', 'ms word', 'office suite']),
  e('Microsoft Excel', 'tool', ['microsoft excel', 'ms excel', 'excel']),
  e('PowerPoint', 'tool', ['powerpoint', 'microsoft powerpoint', 'ms powerpoint']),
  e('Mailchimp', 'tool', ['mailchimp']),
  e('HubSpot', 'tool', ['hubspot']),
  e('Salesforce', 'tool', ['salesforce', 'marketing cloud', 'pardot']),
  e('WordPress', 'tool', ['wordpress']),
  e('Shopify', 'tool', ['shopify']),
  e('Squarespace', 'tool', ['squarespace']),
  e('Wix', 'tool', ['wix']),
  e('Webflow', 'tool', ['webflow']),
  e('Notion', 'tool', ['notion']),
  e('Trello', 'tool', ['trello']),
  e('Asana', 'tool', ['asana']),
  e('Monday.com', 'tool', ['monday com']),
  e('Slack', 'tool', ['slack']),
  e('Semrush', 'tool', ['semrush', 'sem rush']),
  e('Ahrefs', 'tool', ['ahrefs']),
  e('Moz', 'tool', ['moz']),
  e('Meltwater', 'tool', ['meltwater']),
  e('Cision', 'tool', ['cision']),
  e('Muck Rack', 'tool', ['muck rack', 'muckrack']),
  e('Prowly', 'tool', ['prowly']),
  e('Brandwatch', 'tool', ['brandwatch']),
  e('Sprinklr', 'tool', ['sprinklr']),
  e('Instagram', 'tool', ['instagram']),
  e('TikTok', 'tool', ['tiktok', 'tik tok']),
  e('LinkedIn', 'tool', ['linkedin']),
  e('Facebook', 'tool', ['facebook']),
  e('X (Twitter)', 'tool', ['twitter', 'x twitter', 'x formerly twitter', 'tweets']),
  e('YouTube', 'tool', ['youtube']),
  e('Pinterest', 'tool', ['pinterest']),
  e('Snapchat', 'tool', ['snapchat']),
  e('Threads', 'tool', ['threads app', 'meta threads']),
];

// ───────────────────────────── Lookups ─────────────────────────────

export interface CompiledEntry {
  entry: LexiconEntry;
  /** Normalised token arrays of the term + synonyms, longest first. */
  variants: string[][];
  /** Normalised evidence phrases (fact side only). */
  evidence: string[];
}

let compiled: CompiledEntry[] | null = null;
let byTerm: Map<string, CompiledEntry> | null = null;

function compileEntry(entry: LexiconEntry): CompiledEntry {
  const seen = new Set<string>();
  const variants: string[][] = [];
  for (const phrase of [entry.term, ...entry.synonyms]) {
    const tokens = tokenize(phrase);
    const key = tokens.join(' ');
    if (!tokens.length || seen.has(key)) continue;
    seen.add(key);
    variants.push(tokens);
  }
  variants.sort((a, b) => b.length - a.length);
  const evidence = (entry.evidence ?? []).map(normalizePhrase).filter(Boolean);
  return { entry, variants, evidence };
}

/** Compiled lexicon (memoised). */
export function compiledLexicon(): CompiledEntry[] {
  if (!compiled) compiled = LEXICON.map(compileEntry);
  return compiled;
}

/** Lexicon entry by canonical term or any synonym (case/plural-insensitive). */
export function findLexiconEntry(term: string): CompiledEntry | undefined {
  if (!byTerm) {
    byTerm = new Map();
    // Canonical terms win over synonyms that happen to collide.
    for (const c of compiledLexicon()) byTerm.set(normalizePhrase(c.entry.term), c);
    for (const c of compiledLexicon()) {
      for (const v of c.variants) {
        const key = v.join(' ');
        if (!byTerm.has(key)) byTerm.set(key, c);
      }
    }
  }
  return byTerm.get(normalizePhrase(term));
}

/** All normalised phrasings for a keyword term (its lexicon variants, or the term alone). */
export function variantsFor(term: string): string[] {
  const c = findLexiconEntry(term);
  if (!c) return [normalizePhrase(term)].filter(Boolean);
  return c.variants.map((v) => v.join(' '));
}
