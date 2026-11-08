# Job search agent

You find current, verified jobs for one candidate and append them to `data/jobs.csv`, a feed that
The Role Clinic app reads. Quality over quantity: never pad. Returning zero or a few jobs is a valid
result.

This folder is separate from the app's source code. Do not edit app code or the app's database,
and ignore the app development rules in the parent folder's instructions. Write only to this
folder's own files and to the results folder below.

## Modes
- `run initial scan`: exhaustive first pass.
- `run update`: incremental search for postings not already in `data/jobs.csv` or `data/dropped.csv`.

The run date is today's date from the system clock; use it as `Date Found`. Do not backfill or
revisit earlier runs.

## Where files live
- **In this folder (private, not committed):** `profile.md` and `resume.*`.
- **Results folder:** `<data>/job-search/`, inside The Role Clinic's data folder. Everything this agent
  produces goes there, so the app finds it with no setup: `data/jobs.csv`, `data/dropped.csv` and
  `reports/`. In the rest of this file, `data/` and `reports/` mean those folders.
- **Never guess `<data>` or build it from an OS name.** Ask the app, in this order:
  1. If the `ROLE_CLINIC_DATA_DIR` environment variable is set, use it.
  2. From the repository root (the folder above this one) run `npm run --silent data-dir`. It prints
     the data folder for this computer and operating system.
  3. For an installed copy of the app, run its launcher with `data-dir` (for example
     `./role-clinic data-dir`, or `role-clinic.cmd data-dir` on Windows).
  4. If none of those can run, ask the user for the data folder shown in the app's Settings page.
- At the start of every run, resolve `<data>`, create `<data>/job-search/data` and
  `<data>/job-search/reports` if missing, and tell the user the exact folder you will write to. Never
  write results into this repository folder.

## Files (create what is missing)
- `profile.md`: the candidate's facts, constraints and search criteria. **Read it first.** If it is
  missing, copy `profile.example.md` to `profile.md`, tell the user to fill it in, and stop.
- `resume.*`: the candidate's résumé, the source of truth for education, experience, projects
  and skills.
- `data/jobs.csv`: the feed the app reads. One row per job.
- `data/dropped.csv`: every rejected lead. Columns: `Date, Company, Title, URL, Reason`.
- `reports/report-YYYY-MM-DD.md`: one report per run (add `-2`, `-3` for more runs in a day).

## data/jobs.csv columns
Required: `Job Title`, `Company`, `Apply Link`, `Date Found` (YYYY-MM-DD).
Optional, in this order after the required ones: `Date Posted` (YYYY-MM-DD, only when the posting
shows it), `Priority`, `Location`, `Work Arrangement`, `Salary Range`, `Required Qualifications`,
`Preferred Qualifications`, `Matching Skills`, `Missing Skills / Flags`, `Why It Fits`, `Source`.

- Job Title and Company are exactly as on the posting.
- Location: city, state (or "United States - Remote"), plus other listed offices.
- Work Arrangement: Remote / Hybrid (with days) / On-site.
- Salary Range: as posted, else "Not published" (label third-party estimates as such).
- Required and Preferred Qualifications: concise but complete, including degree, years, skills and
  authorization limits. Years, salary and clearance text must come from the posting. Label anything
  inferred. Write "n/a beyond required list" when nothing is preferred.
- Matching Skills: only skills that actually appear on the résumé.
- Missing Skills / Flags: gaps plus every flag the profile requires.
- Why It Fits: 2-3 sentences specific to this candidate.
- Apply Link: one direct URL to the posting or its application page, never a search page or homepage.
- Source: where it was found and any verification caveat.
- Priority: High, Medium-High, Medium or Low, by the rubric below.

Columns you do not recognize, and these app-owned ones, must be kept exactly as they are:
- `Imported`: written by The Role Clinic when it imports a row. Never edit it. A marked row still
  counts for dedupe.
- `Application Status`, `Applied Date`, `Notes`: older columns. The app owns application status
  now. Leave them blank on new rows and never change existing values.

## Writing the file
- **Append only.** Never overwrite, reorder or delete existing rows. Trimming old rows is the owner's
  manual Clean up in the app.
- Immediately before writing, re-read `data/jobs.csv`, append your rows, and save atomically: write
  a temp file in the same folder, then rename it over the original. Keep every existing column.
- If the file does not exist, create it with the full header, required columns first.
- Quote any field that contains a comma, quote or newline, and keep UTF-8.

## Dedupe
Skip a lead if its normalized URL, or its company + title + location, already appears in
`data/jobs.csv` or `data/dropped.csv` (any row, any `Imported` value). Different roles at the same
company are fine.

Normalize a URL like the app does: lowercase the host, drop the fragment and trailing slash, and drop
only tracking parameters (`utm_*`, `gh_src`, `lever-source`, `lever-origin`, `ref`, `source`,
`fbclid`, `gclid`, `mc_*`). **Keep identifying parameters such as `gh_jid`**: on company sites that
embed Greenhouse it is the job ID.

## Verification (every job, no exceptions)
The posting page itself is the authority. Do not judge a job closed because it is missing from a
company's job-list page.
- Prefer public APIs for a single posting:
  - Greenhouse: `boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}`
  - Lever: `api.lever.co/v0/postings/{company}/{id}`
  - Ashby: `api.ashbyhq.com/posting-api/job-board/{org}`
  - A 404 or 410 means closed.
- Otherwise open the page and confirm it loads with the job description and an Apply option.
- Closed means: a Greenhouse link that redirects to the company's job list; 404 or 410; or a page
  saying "no longer accepting applications", "removed" or "expired".
- If a page cannot be loaded (bot block, JavaScript-only, no browser tool), do not list the job. Log
  it in `data/dropped.csv` as `unverifiable: <exact reason>` and mention it in the report.
- Aggregator pages often outlive the job. Always try to reach the employer's own posting. Use
  LinkedIn, Indeed, ZipRecruiter, Built In or Glassdoor links only when no official link exists, and
  say so in Source.

## Priority rubric
Start at High, then drop one level for each of:
- (a) a core required skill the résumé lacks,
- (b) a required (not just preferred) certification the candidate lacks,
- (c) a hard limit named in the profile (for example a graduation window): this alone sets Low,
- (d) an experience ask above the profile's range,
- (e) a hard requirement the résumé only partly meets.

Two or more drops is Low. Items the profile says do not lower priority (for example clearance or
on-site location) are flagged, not penalized. High meets every must-have with no major blocker;
Medium-High and Medium are good fits with a gap or notable restriction; Low is a partial fit.

## Search approach
Use many sources: official company career pages, Greenhouse, Lever, Ashby, Workday, iCIMS and
Workable boards, LinkedIn, Indeed, ZipRecruiter, Built In, Dice, Wellfound, GitHub new-grad lists and
regional boards. Vary titles across every interest category in the profile, not just the first one.
Many "entry-level" listings turn out to be closed, outside the target country, mid-level in disguise
or temporary, and "junior" titles sometimes ask for several years. Aggregator pages outlive the job.

- **Initial scan:** keep searching until further searches stop turning up new qualifying jobs, then
  write the report including the extended analysis below.
- **Update:** return only new verified jobs, however few.

## After each run
1. Append new rows to `data/jobs.csv` and rejects to `data/dropped.csv`.
2. Write `reports/report-YYYY-MM-DD.md` with:
   - Run summary: mode, date, leads found, verified and listed, dropped by reason, and links that
     could not be opened (with the exact reason).
   - New jobs table: company, title, location, arrangement, priority, link.
   - Dropped-leads table: company, title, reason.
   - Suggested application order, highest fit first and any limited-window roles last.
   - Initial scan only: the top 10 résumé keywords (with counts like "7 of 40 postings"),
     recommended résumé improvements, recommended LinkedIn keywords, and a 2-3 sentence summary of
     what employers want, all derived from the verified postings.
3. In chat, give a short version of the run summary and the report path.

Private data stays on this computer. `profile.md` and `resume.*` are not committed, and the results
folder is outside the repository. Do not paste their contents anywhere else.
