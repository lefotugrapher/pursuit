// Shared contract for every Pursuit module. Change only with care: all modules depend on it.

// ───────────────────────────── Jobs ─────────────────────────────

export type SourceId =
  | 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable'
  | 'linkedin_guest' | 'adzuna' | 'gmail_alert' | 'manual' | 'board_search';

export type AtsKind =
  | 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable'
  | 'workday' | 'linkedin' | 'indeed' | 'email' | 'unknown';

export type JobStatus =
  | 'discovered' | 'filtered_out' | 'scored' | 'skipped' | 'tailoring' | 'ready'
  | 'approved' | 'applying' | 'needs_you' | 'applied' | 'failed'
  | 'replied' | 'interview' | 'offer' | 'rejected' | 'withdrawn';

export const JOB_STATUSES: JobStatus[] = [
  'discovered', 'filtered_out', 'scored', 'skipped', 'tailoring', 'ready',
  'approved', 'applying', 'needs_you', 'applied', 'failed',
  'replied', 'interview', 'offer', 'rejected', 'withdrawn',
];

/** Status groups used by the kanban + funnel. */
export const STATUS_GROUPS: Record<string, JobStatus[]> = {
  Inbox: ['discovered', 'scored', 'tailoring'],
  Ready: ['ready'],
  'In flight': ['approved', 'applying', 'needs_you'],
  Applied: ['applied', 'replied'],
  Interview: ['interview'],
  Offer: ['offer'],
  Closed: ['rejected', 'skipped', 'filtered_out', 'failed', 'withdrawn'],
};

/** What an adapter returns before normalisation. */
export interface RawJob {
  source: SourceId;
  sourceId: string;              // id within the source
  company: string;
  title: string;
  location?: string;
  url: string;                   // human posting URL
  applyUrl?: string;             // direct application URL if known
  descriptionHtml?: string;
  descriptionText?: string;
  postedAt?: string;             // ISO
  salaryText?: string;
  employmentType?: string;       // full-time, contract, internship...
  department?: string;
  remote?: boolean;
  atsMeta?: Record<string, unknown>; // board token, posting id, question schema, etc.
}

export interface Salary { min?: number; max?: number; currency?: 'EUR' | 'GBP' | 'USD' | string; period?: 'year'; raw?: string }

/** Normalised job ready for upsert. */
export interface NewJob {
  id: string;                    // jobId(company,title,location)
  source: SourceId;
  sourceId: string;
  company: string;
  title: string;
  location: string;              // '' if unknown
  country?: 'IE' | 'GB-NIR' | 'GB' | 'OTHER' | 'REMOTE';
  remote: boolean;
  url: string;
  applyUrl: string;              // falls back to url
  ats: AtsKind;
  atsMeta: Record<string, unknown>;
  description: string;           // plain text, cleaned
  salary?: Salary;
  employmentType?: string;
  department?: string;
  postedAt?: string;
}

export interface Job extends NewJob {
  status: JobStatus;
  discoveredAt: string;
  updatedAt: string;
  score?: number;                // 0-100
  scoreDetail?: ScoreDetail;
  filters?: FilterResult;
  keywords?: KeywordCoverage;
  needs?: string[];              // why it's needs_you
  notes?: string;
  starred?: boolean;
}

export interface JobQuery {
  status?: JobStatus | JobStatus[];
  source?: SourceId;
  minScore?: number;
  search?: string;               // matches title/company/location
  company?: string;
  orderBy?: 'score' | 'discoveredAt' | 'updatedAt' | 'postedAt';
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

// ───────────────────────────── Scoring ─────────────────────────────

export interface FilterResult {
  pass: boolean;
  rejected: string[];            // hard-rejection reasons (pass=false if any)
  flags: string[];               // soft warnings shown to Kayzee (visa, NI right-to-work, years asked...)
}

export interface ScoreDetail {
  total: number;                 // 0-100
  components: { skills: number; roleFit: number; seniority: number; location: number; freshness: number; salary: number }; // each 0-1
  reasons: string[];
  flags: string[];
  llmUsed: boolean;
  scoredAt: string;
}

export interface Keyword { term: string; kind: 'skill' | 'tool' | 'duty' | 'domain' | 'soft'; weight: number }

export interface KeywordCoverage {
  keywords: Keyword[];
  matched: { term: string; factIds: string[] }[];
  gaps: string[];                // in JD, NOT backed by facts → never claimed
  pct: number;                   // weighted 0-100
}

// ───────────────────────────── Config ─────────────────────────────

export interface Profile {
  name: { first: string; last: string; preferred: string; full: string };
  email: string;
  phone: string;
  location: string;              // "Dundalk, Co. Louth, Ireland"
  links: { linkedin?: string; portfolio?: string; website?: string; github?: string };
  targets: {
    roles: string[];             // role families / titles to search
    keywords: string[];          // search keywords
    locations: string[];         // acceptable locations (lowercase match)
    secondaryLocations: string[];// allowed but flagged (e.g. Northern Ireland)
    remoteOk: boolean;
    seniority: ('intern' | 'graduate' | 'junior' | 'executive' | 'mid')[];
    excludeTitleWords: string[]; // senior, head of, director...
    maxYearsRequired: number;    // reject when JD demands more
    salaryFloorEUR: number;
    blacklistCompanies: string[];
    languages: string[];         // languages he can work in
    /** Only long-term roles: reject fixed-term, contract, temporary, maternity cover, internships and part-time. */
    permanentOnly?: boolean;
    /** Has the right to work in the UK (Northern Ireland). When false and he needs sponsorship, UK roles are
     *  rejected unless the posting offers visa sponsorship. */
    ukRightToWork?: boolean;
  };
  workAuth: { summary: string; needsSponsorship: boolean | null; confirm: boolean };
  coverLetter: { signOff: string; voiceNotes: string[] };
}

export interface Fact {
  id: string;                    // stable, e.g. "su-vp-2026", "canopy-seo-page1"
  kind: 'role' | 'achievement' | 'education' | 'project' | 'skill' | 'tool' | 'award' | 'summary' | 'other';
  text: string;                  // the exact true statement
  org?: string;
  title?: string;
  start?: string;                // "2025-09"
  end?: string | null;           // null = present
  tags: string[];                // pr, comms, social, content, seo, events, research, leadership...
  numbers?: string[];            // numbers that may be quoted (e.g. "1:1", "page 1")
  cvSection?: string;            // section in master CV it belongs to
  cvBullet?: string;             // original bullet text from master CV, if any
}

export interface FactBank {
  version: number;
  summaries: Record<string, string>;   // variant → summary paragraph (all true)
  facts: Fact[];
  skills: string[];                    // confirmed skills (claimable)
  tools: string[];                     // confirmed tools (claimable)
  doNotClaim: string[];                // phrases that must never appear as claims
}

export interface AnswerEntry {
  id: string;
  patterns: string[];            // lowercase substrings / regex sources matched against question label
  answer: string;                // for select: preferred option text; for yes/no: "Yes"/"No"
  type?: 'text' | 'select' | 'yesno' | 'number' | 'url';
  confirm?: boolean;             // true = Kayzee hasn't confirmed; autopilot must not use it
  notes?: string;
}
export interface AnswerBank { entries: AnswerEntry[] }

export interface WatchCompany {
  name: string;
  ats: Extract<AtsKind, 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable'>;
  token: string;                 // board token / company id
  enabled: boolean;
  tags?: string[];
  verifiedAt?: string;
}
export interface SourcesConfig {
  companies: WatchCompany[];
  linkedinGuest: { enabled: boolean; queries: { keywords: string; location: string }[]; maxPerQuery: number; minIntervalMs: number };
  adzuna: { enabled: boolean; queries: { what: string; where: string; country: 'ie' | 'gb' }[] };
  gmailAlerts: { enabled: boolean };
  /** Workable + SmartRecruiters public job search (Ireland). Empty queries = reuse the LinkedIn keywords. */
  boardSearch: { enabled: boolean; queries: string[] };
  titleMustMatch: string[];      // pre-filter: job title must contain one of these (lowercase) for ATS boards
}

export interface Settings {
  mode: 'review' | 'autopilot';
  paused: boolean;
  minScore: number;
  autoSkipBelow: number;
  dailyApplyCap: number;
  dailyEmailCap: number;
  dailyTailorCap: number;
  followUpDays: number;
  discoveryEveryHours: number;
  quietHours: { start: string; end: string };
  autopilot: {
    enabled: boolean; minScore: number; dailyCap: number; ats: AtsKind[]; requireAllAnswers: boolean;
    /** Kayzee's "do everything for me" mode (asked for 2026-11-16): any fillable ATS, runs overnight, style-only letter
     *  issues don't block, and missing answers are asked on Telegram instead of stalling. Truth guard, CAPTCHA,
     *  account walls and caps still apply. */
    handsFree?: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'review',
  paused: false,
  minScore: 60,
  autoSkipBelow: 45,
  dailyApplyCap: 20,
  dailyEmailCap: 15,
  dailyTailorCap: 40,
  followUpDays: 6,
  discoveryEveryHours: 3,
  quietHours: { start: '22:00', end: '08:00' },
  autopilot: { enabled: false, minScore: 85, dailyCap: 10, ats: ['greenhouse', 'lever', 'ashby'], requireAllAnswers: true, handsFree: false },
};

// ───────────────────────────── Tailoring ─────────────────────────────

export interface CvBullet { text: string; factIds: string[] }
export interface CvEntry { kind: 'role' | 'education' | 'project' | 'other'; title: string; org?: string; location?: string; dates?: string; note?: string; bullets: CvBullet[]; factId?: string }
export interface CvSection { title: string; entries: CvEntry[]; raw?: string }   // raw = verbatim LaTeX for sections we don't restructure (e.g. Skills)
export interface CvModel { preamble: string; header: string; summary: string; sections: CvSection[]; postamble: string }

export interface GuardResult { ok: boolean; problems: string[] }

export interface TailoredCv {
  model: CvModel;
  texPath: string;
  pdfPath: string | null;        // null if compile failed
  summaryVariant: string;
  guard: { ok: boolean; rejectedBullets: { text: string; problems: string[] }[] };
  ats: AtsReport | null;
  compileLog?: string;
}

export interface AtsReport {
  score: number;                 // 0-100
  pages: number;
  textExtractable: boolean;
  badChars: string[];            // e.g. U+2011
  sectionsFound: string[];
  sectionsMissing: string[];
  contactFound: boolean;
  keywordPct: number;
  keywordsInText: string[];
  keywordsMissing: string[];     // matched-by-facts keywords that didn't make it into the PDF text
  problems: string[];
}

export interface ScreeningQuestion {
  id: string;                    // field name / id in the form
  label: string;
  type: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file' | 'number' | 'url' | 'date' | 'yesno';
  required: boolean;
  options?: string[];
}
export interface AnsweredQuestion extends ScreeningQuestion {
  answer: string | null;
  source: 'bank' | 'profile' | 'llm' | 'none';
  answerId?: string;             // AnswerEntry id
  needsHuman: boolean;
  confirm?: boolean;             // from an unconfirmed bank entry
}

// ───────────────────────────── Apply ─────────────────────────────

export interface ApplyPackage {
  job: Job;
  profile: Profile;
  cvPdfPath: string;             // absolute
  coverLetterText: string;
  coverLetterPdfPath?: string;
  answers: AnsweredQuestion[];
}

export type Blocker = 'captcha' | 'login' | 'account_required' | 'mfa' | 'closed' | 'unsupported' | 'attestation' | 'unknown_required_field';

export interface FillResult {
  filled: string[];              // field labels filled
  unfilledRequired: string[];    // labels still empty and required
  blockers: Blocker[];
  questionsSeen: ScreeningQuestion[];
}

export interface ApplyOutcome {
  status: 'applied' | 'needs_you' | 'failed' | 'skipped';
  needs?: string[];
  confirmation?: string;         // text/url evidence
  screenshotPath?: string;
  error?: string;
  /** Required questions the form asked that nothing could answer (ask Kayzee, then remember the answers). */
  questions?: ScreeningQuestion[];
  /** Why the run stopped short of submitting (captcha, account wall, unanswered questions...). */
  blockedBy?: Blocker[];
}

export interface Application {
  id: number;
  jobId: string;
  startedAt: string;
  submittedAt?: string;
  method: 'auto' | 'autopilot' | 'manual' | 'email';
  status: 'started' | 'submitted' | 'needs_you' | 'failed';
  confirmation?: string;
  screenshotPath?: string;
  cvArtifactId?: number;
  summaryVariant?: string;
  error?: string;
}

// ───────────────────────────── Artifacts ─────────────────────────────

export type ArtifactKind = 'cv_tex' | 'cv_pdf' | 'cover_letter' | 'answers' | 'prep' | 'screenshot' | 'ats_report' | 'compile_log';
export interface NewArtifact { jobId: string; kind: ArtifactKind; path?: string; content?: string; meta?: Record<string, unknown> }
export interface Artifact extends NewArtifact { id: number; version: number; createdAt: string }

// ───────────────────────────── Comms ─────────────────────────────

export interface NewContact {
  jobId?: string;
  company: string;
  name?: string;
  role?: string;
  email?: string;
  emailVerified: boolean;        // seen verbatim on a page/JD; false = guessed (never auto-used)
  linkedinUrl?: string;          // profile or people-search URL
  source: string;                // 'jd' | 'company_site' | 'manual' | 'inbox'
  confidence: number;            // 0-1
}
export interface Contact extends NewContact { id: number; createdAt: string }

/** 'in_gmail' = SMTP was unreachable, so the email was saved to Gmail Drafts for Kayzee to press Send. */
export type MessageStatus = 'draft' | 'approved' | 'sent' | 'in_gmail' | 'failed' | 'discarded';
export interface NewMessage {
  jobId?: string;
  contactId?: number;
  inboxId?: number;              // reply to
  direction: 'out' | 'in';
  channel: 'email' | 'linkedin';
  kind: 'outreach' | 'follow_up' | 'reply' | 'linkedin_note' | 'digest' | 'thank_you';
  to?: string;
  subject?: string;
  body: string;
  status: MessageStatus;
  attachCv?: boolean;
  inReplyTo?: string;            // Message-ID
  guardProblems?: string[];
  slopHits?: string[];
}
export interface Message extends NewMessage { id: number; createdAt: string; sentAt?: string; messageId?: string; error?: string }

export interface InboundEmail {
  messageId: string;
  uid?: number;
  from: string;                  // "Name <addr>"
  fromAddress: string;
  to?: string;
  subject: string;
  date: string;                  // ISO
  text: string;
  html?: string;
  links?: { href: string; text: string }[];
}

export type EmailKind = 'interview' | 'rejection' | 'offer' | 'assessment' | 'question' | 'confirmation' | 'job_alert' | 'other';
export interface Classification { kind: EmailKind; jobId?: string; confidence: number; summary: string; proposedTimes?: string[]; llmUsed: boolean }

export interface InboxItem {
  id: number;
  messageId: string;
  fromAddress: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  jobId?: string;
  kind?: EmailKind;
  confidence?: number;
  summary?: string;
  handled: boolean;
  createdAt: string;
}

// ───────────────────────────── Ops ─────────────────────────────

export interface EventRow { id: number; ts: string; type: string; jobId?: string; detail?: Record<string, unknown> }
export interface RunRow { id: number; kind: string; startedAt: string; finishedAt?: string; ok?: boolean; stats?: Record<string, unknown>; error?: string }

export interface FunnelStats {
  discovered: number; scored: number; ready: number; applied: number; replied: number; interview: number; offer: number; rejected: number;
  appliedToday: number; appliedWeek: number; responseRate: number; // replies(any inbound linked)/applied
}
export interface ResponseRateRow { dimension: 'source' | 'ats' | 'scoreBucket' | 'summaryVariant'; key: string; applied: number; responded: number; interviews: number; rate: number }

export interface LLMUsage { ts?: string; purpose: string; model: string; promptTokens: number; completionTokens: number; costUsd?: number; ok: boolean }

// ───────────────────────────── Sources runtime ─────────────────────────────

export interface Http {
  get(url: string, opts?: { headers?: Record<string, string>; minIntervalMs?: number }): Promise<{ status: number; text: string; url: string }>;
  json<T = unknown>(url: string, opts?: { headers?: Record<string, string>; minIntervalMs?: number }): Promise<T>;
}
export interface Logger { info(msg: string, d?: unknown): void; warn(msg: string, d?: unknown): void; error(msg: string, d?: unknown): void }
export interface SourceContext { sources: SourcesConfig; profile: Profile; http: Http; since?: string; log: Logger }
export interface SourceAdapter { id: SourceId; label: string; fetch(ctx: SourceContext): Promise<RawJob[]> }
