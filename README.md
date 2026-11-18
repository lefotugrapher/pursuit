# Pursuit

Local job-search engine. Finds jobs, scores them, writes a truthful tailored CV, cover letter and
screening answers for each, queues them for one-click approval, submits through Chrome, watches Gmail
for replies, drafts follow-ups and builds interview prep. Everything runs on this Mac.

Full design and rules: [SPEC.md](SPEC.md).

## Start

```bash
pnpm install --ignore-scripts
cp .env.example .env.local   # then fill in the two keys below
pnpm doctor                  # checks Node, tectonic, Chrome, config, keys
pnpm dev                     # dashboard on http://localhost:7020
pnpm worker                  # the engine: discovery, tailoring, apply, inbox (separate terminal)
```

Try it without live data: `pnpm seed` loads demo jobs, `pnpm seed --clear` removes them.

## The two keys

Pursuit works without them (plain heuristics, no email), but you want both.

1. **OpenRouter key** → `OPENROUTER_API_KEY` in `.env.local` (openrouter.ai/keys). Default model is
   `deepseek/deepseek-v4-flash` with reasoning off.
2. **Gmail app password** → `GMAIL_USER` and `GMAIL_APP_PASSWORD`. Turn on 2-Step Verification, then
   create an app password at myaccount.google.com/apppasswords. Never use your real password.

## If your network blocks outbound email (SMTP)

Reading mail uses IMAP (port 993) and works on most networks. Some block sending (ports 465/587). When
Pursuit can't reach SMTP it saves each approved email to your Gmail **Drafts** instead, marks it
`in_gmail`, and you press Send in Gmail. Nothing is ever sent without you either way.

## How a job moves

discovered → scored → tailoring → **ready** → (you press Approve) → applying → applied → replied → interview → offer

- You approve in `/queue`: `A` approve, `S` skip, `E` edit, `J`/`K` move, `O` open posting.
- `needs_you` means Pursuit stopped for something only you can do: CAPTCHA, login, a question it can't
  answer from your answer bank. Use "Open handoff" on the job.
- `applied` is only set after the site shows a real success message and a screenshot is saved.

## Rules it will not break

- Nothing is claimed that isn't in `config/facts.json`. The truth guard rejects any CV bullet or letter
  line with a number, employer, tool or skill the cited facts don't back. Gaps are shown to you, never claimed.
- Nothing is submitted or sent without your approval. Autopilot exists but is off, and even then it only
  handles high-score Greenhouse/Lever/Ashby jobs where every answer comes from your confirmed bank. Emails are never auto-sent.
- CAPTCHAs, logins and legal/EEO questions are handed to you. No bypassing.
- No logged-in LinkedIn automation. LinkedIn jobs come from public pages and your Gmail job alerts, and
  LinkedIn messages are drafted for you to send yourself.
- Visa status stays off the CV and is only answered in forms. Caps: 20 applications and 15 emails a day.
- The Pause button in the sidebar stops everything outbound immediately.

## Before you trust it

Open **Settings → Answer bank** and confirm the entries marked unconfirmed (start date, salary wording,
sponsorship, driving licence). Autopilot never uses an unconfirmed answer.

## Tests

`pnpm test` runs 521 tests. They use local fixture pages and never touch a real employer.

## Run the worker on login (optional)

`scripts/launchd.sh install` sets up a LaunchAgent. It is not installed for you.
