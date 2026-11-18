# Job sources

Where Pursuit looks for jobs, and how to add more. The live file is `config/sources.json`
(local, gitignored). `config/sources.example.json` is the committed template with three public examples.

Target: PR & communications, content & social, digital marketing, marketing executive and
events/engagement roles at graduate, junior or executive level. Locations: Dublin, Louth
(Dundalk, Drogheda), remote within Ireland, then Northern Ireland as a secondary market.

## Watchlist snapshot (verified 2026-11-15)

Every board below returned HTTP 200 with the expected JSON shape from its public API on
2026-11-15. Nothing was copied from a list without that check. 95 companies in total
(greenhouse 64, ashby 21, smartrecruiters 6, lever 4).

- 82 had at least one Republic of Ireland posting on the day.
- 11 had at least one Northern Ireland posting.
- 20 had a marketing/comms/content/events title open in Ireland or NI.
- No Workable board made the list. Every Irish-relevant Workable account found (Legacy
  Communications, FINEOS, Lidl, Kerry Foods, Fenergo, Teamwork...) had zero jobs on the day, and an
  empty account proves nothing. The Workable adapter is still wired in, so add one when you find a
  live board.

The counts are a snapshot, and boards change daily. A company with no Irish roles on the day stays
on the list when it has an Irish office or Irish HQ, because roles come and go. Pursuit's
discovery run re-reads every board on each pass, and the dashboard's `/sources` page shows what each
board actually returned.

### Tags

| Tag | Meaning |
|---|---|
| `ie-office` | Has an office or HQ in the Republic of Ireland |
| `ni-office` | Has an office in Northern Ireland (UK right-to-work rules apply; Pursuit flags these) |
| `remote-ie` | Hires remote employees based in Ireland |
| `irish-hq` | Irish- or NI-founded / headquartered |
| `emea-hq-dublin` | Dublin is the company's EMEA or international HQ |
| `ie-jobs-now`, `ni-jobs-now` | Snapshot: postings in IE / NI on the verification day |
| `no-local-jobs-now` | Snapshot: no IE/NI postings that day (kept for the Irish office) |
| `mkt-jobs-now` | Snapshot: at least one marketing/comms-type title open anywhere |
| `mkt-jobs-local-now` | Snapshot: a marketing/comms-type title open in IE/NI |
| `early-career-local-now` | Snapshot: a graduate/intern/junior/assistant/coordinator title open in IE/NI |
| sector (`tech`, `fintech`, `martech`, `agency`, `media`, `consumer`, `retail`, `travel`, `gaming`, `events`, `ai`, ...) | Rough industry |

Snapshot tags are informational only. No module should filter on them; re-verify before relying on one.

### Republic of Ireland employers

| Company | ATS | Token | Sector | Ireland roles now | NI roles now | Open roles (all) | Marketing/comms roles in IE/NI now |
|---|---|---|---|---|---|---|---|
| MongoDB | greenhouse | `mongodb` | tech | yes (62) | no | 390 | Senior Manager, Event Operations; Senior Product Manager, Marketing AI (+1 more) |
| Grafana Labs | greenhouse | `grafanalabs` | tech | yes (10) | no | 140 | Principal Technical Marketing Engineer; Product Marketing Operations Manager (+1 more) |
| OpenAI | ashby | `openai` | ai | yes (17) | no | 839 | B2B Comms Lead, EMEA; Growth Marketing Lead, EMEA |
| Synthesia | ashby | `synthesia` | ai | yes (2) | no | 31 | Lead Brand Designer, Experiential; Senior Brand Designer, Web |
| Stripe | greenhouse | `stripe` | fintech | yes (90) | no | 786 | Public Affairs Campaigns Lead, EMEA |
| Primark | smartrecruiters | `Primark` | retail | yes (50) | yes (2) | 763 | VM Communications Coordinator & Stylist |
| Datadog | greenhouse | `datadog` | tech | yes (18) | no | 384 | Talent Engagement Marketing Manager |
| ElevenLabs | ashby | `elevenlabs` | ai | yes (14) | no | 128 | Product Marketing - Agents - Government |
| Fivetran | greenhouse | `fivetran` | tech | yes (9) | no | 197 | Enterprise Growth Marketing Lead, EMEA |
| CarTrawler | lever | `cartrawler` | travel | yes (8) | no | 8 | Head of Marketing & Communications - Fixed-Term Contract |
| Tines | greenhouse | `tines` | tech | yes (7) | no | 32 | Video Content Specialist |
| Oyster | ashby | `oyster` | tech | yes (4) | no | 21 | Content Marketing Lead |
| Squarespace | greenhouse | `squarespace` | tech | yes (4) | no | 17 | International Strategy and Marketing Lead |
| Flipdish | greenhouse | `flipdish` | tech | yes (3) | no | 12 | Performance Marketing Manager |
| GOAL | greenhouse | `goal` | nonprofit | yes (3) | no | 4 | Senior Fundraising Executive- Direct Marketing |
| Reddit | greenhouse | `reddit` | social | yes (3) | no | 145 | Community Manager, French Speaking |
| SolarWinds | greenhouse | `solarwinds` | tech | yes (3) | no | 92 | Marketing Internship |
| Typeform | greenhouse | `typeform` | tech | yes (3) | no | 6 | Senior Paid Marketing Strategist |
| Fever | greenhouse | `feverup` | events | yes (2) | no | 566 | Digital Marketing Associate |
| Sprout Social | greenhouse | `sproutsocial` | martech | yes (2) | no | 21 | Senior Field Marketing Strategist |
| Version 1 | smartrecruiters | `Version1` | tech | yes (46) | yes (41) | 148 | - |
| Intercom (Fin) | greenhouse | `intercom` | tech | yes (41) | no | 115 | - |
| HubSpot | greenhouse | `hubspotjobs` | martech | yes (40) | no | 147 | - |
| Notion | ashby | `notion` | tech | yes (36) | no | 166 | - |
| Toast | greenhouse | `toast` | tech | yes (26) | no | 355 | - |
| Elastic | greenhouse | `elastic` | tech | yes (22) | no | 400 | - |
| Harvey | ashby | `harvey` | ai | yes (19) | no | 388 | - |
| Okta | greenhouse | `okta` | tech | yes (19) | no | 362 | - |
| Ashby | ashby | `ashby` | tech | yes (16) | yes (2) | 76 | - |
| ServiceNow | smartrecruiters | `ServiceNow` | tech | yes (17) | no | 818 | - |
| PlayStation | greenhouse | `sonyinteractiveentertainmentglobal` | gaming | yes (16) | no | 228 | - |
| Gong | greenhouse | `gongio` | tech | yes (14) | no | 89 | - |
| SumUp | greenhouse | `sumup` | fintech | yes (12) | yes (2) | 328 | - |
| Web Summit | lever | `websummit` | events | yes (13) | no | 26 | - |
| Airbnb | greenhouse | `airbnb` | travel | yes (9) | no | 214 | - |
| H&M | smartrecruiters | `HMGroup` | retail | yes (8) | yes (1) | 2010 | - |
| Anthropic | greenhouse | `anthropic` | ai | yes (8) | no | 670 | - |
| Twilio | greenhouse | `twilio` | tech | yes (8) | no | 114 | - |
| Vanta | ashby | `vanta` | tech | yes (8) | no | 80 | - |
| GitLab | greenhouse | `gitlab` | tech | yes (7) | no | 251 | - |
| Coursera | greenhouse | `coursera` | edtech | yes (6) | no | 38 | - |
| Klaviyo | ashby | `klaviyo` | martech | yes (6) | no | 148 | - |
| Paddle | ashby | `paddle` | fintech | yes (6) | no | 13 | - |
| Pinterest | greenhouse | `pinterest` | social | yes (6) | no | 163 | - |
| ESW | greenhouse | `esw` | ecommerce | yes (5) | no | 6 | - |
| Kaseya | greenhouse | `kaseya` | tech | yes (5) | no | 95 | - |
| Qualtrics | greenhouse | `qualtrics` | tech | yes (5) | no | 149 | - |
| Attio | ashby | `attio` | tech | yes (4) | no | 22 | - |
| Coinbase | greenhouse | `coinbase` | fintech | yes (4) | no | 265 | - |
| HelloFresh | greenhouse | `hellofresh` | consumer | yes (4) | no | 380 | - |
| Monzo | greenhouse | `monzo` | fintech | yes (4) | no | 57 | - |
| Sitecore | ashby | `sitecore` | martech | yes (4) | no | 24 | - |
| Wayflyer | ashby | `wayflyer` | fintech | yes (4) | no | 14 | - |
| Databricks | greenhouse | `databricks` | tech | yes (3) | no | 896 | - |
| Dropbox | greenhouse | `dropbox` | tech | yes (3) | no | 44 | - |
| New Relic | greenhouse | `newrelic` | tech | yes (3) | no | 44 | - |
| Riot Games | greenhouse | `riotgames` | gaming | yes (3) | no | 195 | - |
| Ripple | greenhouse | `ripple` | fintech | yes (3) | no | 111 | - |
| Wrike | greenhouse | `wrike` | tech | yes (3) | no | 66 | - |
| Accor | smartrecruiters | `AccorHotel` | hospitality | yes (1) | yes (1) | 6178 | - |
| Asana | greenhouse | `asana` | tech | yes (2) | no | 109 | - |
| Deliveroo | greenhouse | `deliveroo` | consumer | yes (2) | no | 185 | - |
| LearnUpon | greenhouse | `learnupon` | edtech | yes (2) | no | 10 | - |
| Muck Rack | greenhouse | `muckrack` | martech | yes (2) | no | 10 | - |
| Perplexity | ashby | `perplexity` | ai | yes (2) | no | 141 | - |
| TrueLayer | greenhouse | `truelayer` | fintech | yes (2) | no | 4 | - |
| viagogo | greenhouse | `viagogo` | events | yes (2) | no | 7 | - |
| Workhuman | ashby | `workhuman` | tech | yes (2) | no | 8 | - |
| Circle (circle.so) | ashby | `circle` | martech | yes (1) | no | 5 | - |
| Contentful | greenhouse | `contentful` | martech | yes (1) | no | 46 | - |
| FREENOW | greenhouse | `freenow` | consumer | yes (1) | no | 16 | - |
| Payoneer | greenhouse | `payoneer` | fintech | yes (1) | no | 100 | - |
| Snowflake | ashby | `snowflake` | tech | yes (1) | no | 376 | - |
| Tenable | greenhouse | `tenableinc` | tech | yes (1) | no | 47 | - |
| Trading 212 | ashby | `trading212` | fintech | yes (1) | no | 62 | - |
| Tripadvisor | greenhouse | `tripadvisor` | travel | yes (1) | no | 14 | - |
| Wiz | greenhouse | `wizinc` | tech | yes (1) | no | 110 | - |
| Workato | greenhouse | `workato` | tech | yes (1) | no | 63 | - |
| ZoomInfo | greenhouse | `zoominfo` | tech | yes (1) | no | 92 | - |
| Evervault | ashby | `evervault` | tech | no | no | 6 | - |
| Keywords Studios | smartrecruiters | `KeywordsStudios` | gaming | no | no | 31 | - |
| Kitman Labs | lever | `kitmanlabs` | sportstech | no | no | 1 | - |
| Udemy | greenhouse | `udemy` | edtech | no | no | 2 | - |

### PR, communications and creative agencies

| Company | ATS | Token | Sector | Ireland roles now | NI roles now | Open roles (all) | Marketing/comms roles in IE/NI now |
|---|---|---|---|---|---|---|---|
| 150Bond | greenhouse | `150bond` | agency | yes (3) | no | 5 | - |
| Wilson Hartnell | greenhouse | `wilsonhartnell` | agency | yes (2) | no | 2 | - |
| Teneo | greenhouse | `teneo` | agency | yes (1) | no | 57 | - |
| Brunswick Group | greenhouse | `brunswickgroup` | agency | no | no | 42 | - |
| FleishmanHillard | greenhouse | `fleishmanhillard` | agency | no | no | 2 | - |
| Hanover Communications | greenhouse | `hanover` | agency | no | no | 2 | - |
| Weber Shandwick | greenhouse | `webershandwick` | agency | no | no | 19 | - |

### Northern Ireland employers

| Company | ATS | Token | Sector | Ireland roles now | NI roles now | Open roles (all) | Marketing/comms roles in IE/NI now |
|---|---|---|---|---|---|---|---|
| TRG Screen | greenhouse | `trgscreen` | fintech | no | yes (7) | 8 | - |
| Lightspeed | ashby | `lightspeedhq` | tech | no | yes (4) | 134 | - |
| Bazaarvoice | lever | `bazaarvoice` | martech | no | yes (1) | 11 | - |
| Everway | greenhouse | `everway` | tech | no | yes (1) | 11 | - |
| Instil | ashby | `instil` | tech | no | yes (1) | 1 | - |

"Open roles (all)" is the board's global count. For SmartRecruiters the IE/NI numbers come from the
API's own `country=ie` and `region=Northern Ireland` filters. Marketing/comms matching here is
a rough title regex used only for this report.

## Other sources in `sources.json`

### LinkedIn (public, logged-out pages only)

`linkedinGuest` drives the public `/jobs-guest/` search. SPEC §0.4 rules: no logged-in automation,
at most 1 request every 3 s (`minIntervalMs: 3000`), at most 50 results per query. 24 queries:

| Keywords | Location |
|---|---|
| marketing executive | Dublin, Ireland |
| communications executive | Dublin, Ireland |
| PR executive | Dublin, Ireland |
| social media executive | Dublin, Ireland |
| content creator | Dublin, Ireland |
| digital marketing | Dublin, Ireland |
| events coordinator | Dublin, Ireland |
| marketing assistant | Dublin, Ireland |
| marketing executive | Ireland |
| communications officer | Ireland |
| communications executive | Ireland |
| PR executive | Ireland |
| social media executive | Ireland |
| graduate marketing | Ireland |
| digital marketing | Ireland |
| content creator | Ireland |
| marketing executive | Dundalk, Ireland |
| communications officer | Dundalk, Ireland |
| digital marketing | Dundalk, Ireland |
| marketing assistant | Dundalk, Ireland |
| marketing executive | Belfast, United Kingdom |
| communications executive | Belfast, United Kingdom |
| social media executive | Belfast, United Kingdom |
| digital marketing | Belfast, United Kingdom |

Dublin and Ireland-wide queries overlap on purpose. LinkedIn caps how deep one query goes, so the
Dublin set adds depth where most roles are. Duplicates collapse on the job id.

### Adzuna

Off by default (`enabled: false`) because it needs `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` in `.env.local`.
The queries are ready: Dublin and Louth for `ie`, Belfast and Newry for `gb`. Turn it on in
`/settings` or by setting `enabled: true` once the keys are in.

### Gmail job alerts

`gmailAlerts.enabled: true`. The inbox module parses LinkedIn, Indeed, IrishJobs, Jobs.ie and
Glassdoor alert emails. Set up alerts on those sites (same keywords as above) to widen coverage
without scraping.

### Title pre-filter (`titleMustMatch`)

ATS boards like Stripe's carry hundreds of engineering and sales roles. Before a job is normalised
and scored, its lowercased title must contain one of the `titleMustMatch` substrings. Rules:

- Every rule is lowercase with no leading or trailing spaces, so trimming can't change its meaning.
- Ambiguous short words are spelled out: there's no bare `pr` (it would match "product"), no bare
  `media` ("intermediate"), `editor` ("creditor"), `writer` ("underwriter"), `press` ("WordPress")
  or `intern` ("international"). Instead the list has phrases like `pr executive`, `pr &`,
  `media relations`, `press office`, `copywrit`, `internship`.
- `graduate` and `digital` are kept broad on purpose. Scoring and hard filters (SPEC §5.3)
  discard what doesn't fit.

`tests/sourcesConfig.test.ts` checks a list of titles that must pass and titles that must not.

## Adding a company

1. **Find the board.** Open the company's careers page and click into one job. The apply URL shows the ATS and token:

   | ATS | Apply URL looks like | Token |
   |---|---|---|
   | Greenhouse | `boards.greenhouse.io/{token}/jobs/...`, `job-boards.greenhouse.io/{token}/...`, `job-boards.eu.greenhouse.io/{token}/...`, or `?gh_jid=` on the company site | `{token}` |
   | Lever | `jobs.lever.co/{token}/...` | `{token}` |
   | Ashby | `jobs.ashbyhq.com/{token}/...` | `{token}` |
   | SmartRecruiters | `jobs.smartrecruiters.com/{CompanyId}/...` | `{CompanyId}` (case as shown) |
   | Workable | `apply.workable.com/{token}/...` | `{token}` |

   The EU Greenhouse host (`job-boards.eu.greenhouse.io`) is served by the same
   `boards-api.greenhouse.io` API. Lever's EU host (`jobs.eu.lever.co`) is a separate API
   (`api.eu.lever.co`) and isn't supported by the Lever adapter yet. Workday, SuccessFactors,
   Taleo, iCIMS, Personio and in-house career sites aren't supported. Cover those employers
   through LinkedIn guest search or Gmail alerts.

2. **Verify it (GET only):**

   ```sh
   UA='Pursuit/1.0 (personal job search)'
   curl -sA "$UA" "https://boards-api.greenhouse.io/v1/boards/TOKEN/jobs" | head -c 300                    # 200 + {"jobs":[...]}
   curl -sA "$UA" "https://api.lever.co/v0/postings/TOKEN?mode=json" | head -c 300                         # 200 + [...]
   curl -sA "$UA" "https://api.ashbyhq.com/posting-api/job-board/TOKEN" | head -c 300                      # 200 + {"jobs":[...]}
   curl -sA "$UA" "https://api.smartrecruiters.com/v1/companies/TOKEN/postings?limit=5" | head -c 300      # 200 + totalFound > 0
   curl -sA "$UA" "https://apply.workable.com/api/v1/widget/accounts/TOKEN" | head -c 300                  # 200 + {"name":...,"jobs":[...]}
   ```

   Gotchas found while building this list:
   - **SmartRecruiters returns 200 and `totalFound: 0` for any id, real or not.** Only count it as
     verified when `totalFound > 0` and `content[0].company.name` is the right company.
   - **Workable returns 200 with an empty `jobs` array for many dormant or stub accounts.** Only add
     one when it has jobs, or you've confirmed the company links to it.
   - **Check the company name.** Greenhouse jobs carry `company_name`. Workable returns `name`.
     For Lever/Ashby, open one `hostedUrl`/`jobUrl`. Example: Greenhouse token `wise` is
     "Wise Worksite Field Sales", not Wise the fintech.
   - Don't hammer the APIs: leave at least 1 s between calls.

3. **Add it** to `config/sources.json` (or use the `/sources` page's add + test button):

   ```json
   { "name": "Example Co", "ats": "greenhouse", "token": "exampleco", "enabled": true,
     "tags": ["tech", "ie-office"], "verifiedAt": "YYYY-MM-DD" }
   ```

   Give every company at least one of `ie-office`, `ni-office` or `remote-ie` (the test enforces
   this), plus a sector tag. Set `enabled: false` to pause a board without losing it.

4. **Run** `node --test --import tsx tests/sourcesConfig.test.ts` to validate the file.

## Checked and left out

About 3,500 GET probes across roughly 590 candidate employers went into this list. What didn't make
it, and why, so nobody re-checks the same dead ends:

**No live board on any of the five supported ATSs.** These hire through Workday, SuccessFactors,
Taleo, iCIMS, Personio or their own site. Cover them with LinkedIn guest search and Gmail alerts:
Ryanair (careers.ryanair.com), Aer Lingus (Greenhouse token `aerlingus` exists but had 0 jobs, so it
couldn't be confirmed), Diageo, Kerry Group, Glanbia, Musgrave, Ornua, Bord Bia, RTÉ, The Irish
Times, Mediahuis, An Post, eir, Virgin Media, Flutter / Paddy Power, BoyleSports, Dalata, ESB,
Bord Gáis, Brown Thomas, Kainos, Allstate NI, Liberty IT, Rapid7, Randox, Almac, Ocean Outdoor,
LetsGetChecked, Fenergo, Teamwork, Glofox, Phorest, Hostelworld, Workvivo, Personio, Revolut,
Canva, Grammarly, Indeed, Zendesk, Etsy, Unity, Remitly, Mastercard, Fiserv, State Street,
Fidelity, Citi. Big in-house or Workday hirers (Google, Meta, Microsoft, Amazon, Apple,
Salesforce, Workday, TikTok, LinkedIn) aren't on these ATSs either. The few guesses tried
returned nothing usable.

**Irish PR / creative agencies without a public board:** Edelman, MKC, Murray, Drury, Hume Brophy,
Thinkhouse, Core, Wolfgang Digital, Legacy Communications (Workable account with no jobs), FINN
Partners, Red Flag, Wachsman, Javelin, Boys+Girls, Target McConnells, TBWA. The PRII jobs page
(prii.ie) and LinkedIn alerts are the best way to catch these. Pursuit has no adapter for PRII, so
check it by hand or set up an email alert.

**Token answered, but for a different company:** Greenhouse `wise` (Wise Worksite Field Sales),
`mercury` (Mercury the US fintech, not Mercury Engineering), `ramp` (an unrelated "RAMP"), `remote`
(General Assembly), Ashby `avoca` (a US AI company, not Avoca), Ashby `leap` (a US pharmacy-benefits
company, not LEAP Legal Software).

**Live board, but no Irish office and no IE/NI roles on the day:** Cloudflare, Figma, Samsara, Glean,
Spotify, Trustpilot, Brandwatch, Hootsuite, Cision, Braze, Later, Duolingo, Roblox, Epic Games, Adyen,
Plaid, Brex, N26, GoCardless, Golin, FGS Global, AKQA, R/GA, DMG Media, The Athletic, Patreon.
Airwallex had a single global role with Dublin as one of about ten cities, which is too thin to
watch. Greenhouse `doordashusa`: its only "Dublin" roles were Dublin, California. SmartRecruiters
`Experian`, `Sodexo` and `BoschGroup` are real boards but returned 0 postings for `country=ie`. Add
any of them back if they open an Irish role you want.

**Left out on purpose:**
- Jobgether (`jobs.lever.co/jobgether`) is a recruiter feed that reposts other companies' roles as
  "Remote, Ireland". Those roles come in through LinkedIn and Gmail anyway, and the duplicates
  would be noise.
- Workable's Viva.com board rate-limited the final check (HTTP 429) and had no IE roles earlier, so
  it stays out until it can be verified cleanly.
- `jobs.eu.lever.co` boards (e.g. Teckro) need `api.eu.lever.co`, which the Lever adapter doesn't
  call yet.
