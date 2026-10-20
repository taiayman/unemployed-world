# unemployed.world backend

Daily collection → SQLite, plus weekly manual figures in `data/weekly/` → occupation metrics → `site/jobs.json`. No LLM runs anywhere. Cloudflare serves static files. Visitors never call an API.

The frontend in `site/index.html` uses a white, typography-led layout, colorful occupation previews, search, exposure filters, sorting, device-local bookmarks, and accessible occupation detail dialogs. Styling is in `site/styles.css`; Inter is self-hosted under its bundled SIL Open Font License in `site/fonts/`. All occupation scores, posting counts, history, and source updates come from `site/jobs.json`. Missing demand history remains “Collecting”; no sample figures are substituted.

## Current deployment

- Public source: <https://github.com/taiayman/unemployed-world>
- Automatic Pages deployment: <https://unemployed-world-live.pages.dev>
- `CLOUDFLARE_GIT_DEPLOY=true` publishes only aggregate `site/jobs.json` to `main`. Cloudflare's Git integration deploys that branch without an API token.
- Database snapshots on `pipeline-state` are encrypted. The earlier `taiayman/unemployed.world` repo remains private with its historical unencrypted snapshot; its daily workflow is disabled. Do not make that backup repo public.
- Occupation demand comes only from weekly manual entries (see "Weekly manual data"). The daily job collectors still run and feed source health, news and sentiment.
- Manual workflow runs can set `max_new_jobs` to a smaller verification limit. The input cannot raise the configured daily cap; scheduled runs use the normal limit.

## Run locally

Requires Node 24 and Git. Python and a database server are not needed.

```powershell
cd C:\Projects\personal\unemployed.world
npm ci
npm test
npm run pipeline
npm run preview
```

Open <http://127.0.0.1:8788>. The preview serves the HTML, CSS, bundled font, and daily JSON export. The board only shows occupations that have rows in the latest `data/weekly/*.jsonl` file. No sample numbers are substituted.

`npm run export` rebuilds JSON from existing SQLite without network calls. `npm run ui -- "path/to/unemployed.world.html"` is the legacy split-flap template importer; running it replaces the current frontend.

## GitHub and Cloudflare setup

1. Create a GitHub repository from this directory and push it to the default branch. A public repository has free standard GitHub-hosted Actions minutes; private repository usage counts against your included allowance. Set Actions workflow permissions to allow repository writes.
2. Set `PIPELINE_USER_AGENT` as a repository variable, with a working contact address. Review `config/pipeline.json` and the source rules below. Add employer board slugs; there is no public global directory of Greenhouse/Lever/Ashby boards.
3. Add a random 32-byte base64 `STATE_ENCRYPTION_KEY` Actions secret and keep a secure backup; losing it loses access to the database.
4. For token-free deployment, create a Cloudflare Pages **Git integration** project connected to `main`, with no build command and output directory `site`, then set repository variable `CLOUDFLARE_GIT_DEPLOY=true`. The pipeline commits the public aggregate JSON and Cloudflare deploys it. Alternatively, create a Pages **Direct Upload** project and set `CLOUDFLARE_PAGES_PROJECT`, `CLOUDFLARE_ACCOUNT_ID` and a scoped `CLOUDFLARE_API_TOKEN`. Leave deployment variables empty for artifact-only runs. A custom domain requires separately owning and registering that domain; the `pages.dev` hostname is free.
5. Run **Daily departures board** manually once. The workflow creates `pipeline-state`, imports pinned reference datasets, collects the enabled sources and exports the latest weekly data. Following runs use the same database. The daily schedule is `05:23 UTC`; GitHub cron can be delayed and public-repository schedules can be disabled after prolonged inactivity.

The application does not purchase domains, create API keys, or change billing. Repository and Cloudflare project setup is separate from the daily pipeline.

## Sources and permissions

All requests are sequential per pipeline, at least 3.5 seconds apart per host. A 429/503 stops that host for the run. API errors, rate limits and missing credentials appear in `jobs.json.sources`. No proxy rotation, access-control bypass, LinkedIn or X scraping is implemented.

Public accessibility does not grant unrestricted redistribution. Approval flags record **your review**, not legal clearance. Review terms again before commercial use and whenever they change. This project exports occupation aggregates, never full listings, application URLs or social posts. Do not add listing redistribution without implementing each source's attribution and linking rules first.

| Source | Adapter and setup | Default |
| --- | --- | --- |
| Greenhouse | Public `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | Empty employer allowlist |
| Lever | Public `api.lever.co/v0/postings/{slug}?mode=json`; `region:"eu"` supported | Empty employer allowlist |
| Ashby | Public `api.ashbyhq.com/posting-api/job-board/{slug}` | Empty employer allowlist |
| Workable | Public `apply.workable.com/api/v1/widget/accounts/{slug}`; does not need private account API access | Empty employer allowlist |
| SmartRecruiters | Public company postings endpoint, bounded offset pagination | Empty employer allowlist |
| Adzuna | `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`, country and query; review aggregation, AI processing and attribution terms | Off |
| USAJobs | `USAJOBS_API_KEY` / `USAJOBS_EMAIL` from its developer registration | Off |
| Arbeitnow | Public job-board API, two pages/day | On |
| Himalayas | Cursor pagination, max 20/page; optional `HIMALAYAS_API_KEY` | Approval required, off |
| Remotive | Public remote jobs API, one fetch/day; postings have a source-imposed delay | Approval required, off |
| RemoteOK | Public API with metadata row excluded | Approval required, off |
| HN Who's Hiring | Algolia, latest `whoishiring` thread, top-level offers only, two pages/day | On |
| OpenAI / DeepMind | Verified public RSS URLs | On |
| Anthropic / Meta AI / DeepSeek | Configurable RSS/Atom adapter; unverified feeds stay disabled, not scraped | Off |
| Hugging Face | Public models API sorted by `trendingScore`, max 30 | On |
| arXiv | Public Atom API, latest `cs.AI`, `cs.CL`, `cs.LG`, 3.5-second host interval | On |
| Bluesky | Public Jetstream (JSON derivative of the firehose), max 30 seconds or 1,500 messages | On |
| HN sentiment | Algolia comments query `AI jobs`, max 100/day | On |
| Reddit | Approved Data API application, OAuth client credentials, 10-second interval | Approval required, off |

Example employer configuration:

```json
{
  "greenhouse": [{ "slug": "your-employer-slug", "company": "Employer name", "approved": true }],
  "lever": [{ "slug": "your-employer-slug", "company": "Employer name", "region": "us", "approved": true }],
  "ashby": [],
  "workable": [],
  "smartrecruiters": [{ "slug": "your-employer-slug", "company": "Employer name", "approved": true, "maxPages": 3 }]
}
```

Set `enabled:true` plus `approved:true` only after reviewing the relevant gated source. Credentials alone do not enable it. Reddit must have granted access for the intended use; no anonymous `.json` scraping fallback exists. Himalayas and Remotive have restrictions on redistribution to other boards/aggregators; leave them off unless the intended analytics use is permitted or you have written permission. Source documentation: [Himalayas](https://himalayas.app/api), [Remotive](https://remotive.com/remote-jobs/api), [RemoteOK](https://remoteok.com/api), [Reddit](https://redditinc.com/policies/data-api-terms), [Adzuna](https://developer.adzuna.com/), [USAJobs](https://developer.usajobs.gov/).

The guessed Anthropic `/news/rss.xml`, Meta AI `/blog/rss/` and DeepSeek `/rss.xml` URLs returned 404 during implementation. Add a permitted, working feed under `news.feeds` when one becomes available. Unofficial mirrors need their own permission review. RSS items are news context, not automatically verified product releases.

## Deduplication

- SHA-256 identity uses canonical URL, source-native ID and normalized employer/title/location. Syndicated matches share one posting. The first captured description is stable. This can merge distinct identical-title requisitions at one employer/location, so counts are a conservative sample rather than vacancy totals.

## Weekly manual data

Each week, save the gathered figures as `data/weekly/YYYY-MM-DD.jsonl` (the Monday of that week), one JSON object per line:

```json
{"onet":"43-4051.00","source":"Indeed Hiring Lab","url":"https://...","metric":"job postings index","value":80.1,"asOf":"2026-10-17","baselineValue":95.3,"baselineAsOf":"2026-07-19"}
```

`onet` must be a code from `data/occupations.tsv`. `asOf` must be within 14 days of the file date. `baselineValue`/`baselineAsOf` are optional; when given, the baseline must be 76–106 days before `asOf`. Without one, the row is compared with the same `onet`+`source`+`metric` from a file about 13 weeks earlier. Any invalid row stops the run with `file:line`, so nothing bad is published. Commit the file to `main`; the next daily run exports it.

## What the board measures

Rows are **O*NET occupations** that have figures in the latest weekly file. Per source, change = latest value vs the value about 90 days earlier; an occupation's change is the mean across its sources. Each figure links to where it was read. Missing baselines show as "Collecting", never as zero.

No 90-day trend can exist on day one. `chg` and `status` remain `null`, and the UI says `COLLECTING`. The first comparison normally becomes possible around day 96, when six baseline days exist. If the baseline is too small, a query changes, or coverage drifts, the metric remains unavailable. Page caps deliberately keep collection cheap but can bias observations. The matched-source panel does not make this a representative global labor-market survey.

Status thresholds preserve the preview's rules:

| Demand change | Status |
| --- | --- |
| ≥ +8% | BOARDING |
| -7% to +7% | ON TIME |
| -17% to -8% | DELAYED |
| -29% to -18% | FINAL CALL |
| ≤ -30% | CANCELLED |

These are display labels for measured posting trends. `CANCELLED` does not mean an occupation disappeared or that AI caused the decline. Risk does not alter demand status.

## Exposure reference data

On first collection, `src/reference.js` downloads official O*NET 31.0 occupation/task CSVs and the Anthropic Economic Index `labor_market_impacts` job-exposure and task-penetration CSVs at a pinned Hugging Face revision. It checks schema and [0,1] ranges, matches normalized task statements, records source hashes/licenses and replaces the reference tables in one transaction. Later daily runs reuse that snapshot; update the pinned revision/version explicitly after reviewing changes. No LLM is used for reference imports.

For exact six-digit SOC occupations ending in `.00`, `ai` is published Anthropic **observed exposure × 100**, preserving its task-time weighting. Detailed O*NET occupations without that exact SOC match use an equal-weight mean of matched task-penetration values, only with at least 50% task coverage. Those methods are distinguished in each row's `exposure.method`. Unmatched new O*NET tasks are unknown, not zero. Coverage is exported separately, even when the published occupation estimate is available.

Observed exposure combines task capability and actual professional Claude usage. It is **not** a probability of replacement and **not** the share of all work any AI system can already perform. See [Massenkoff and McCrory (2026)](https://www.anthropic.com/research/labor-market-impacts). The UI now uses that narrower description.

Optional manual reference import is also available. Turn off automatic reference replacement before maintaining custom data:

```text
npm run import -- onet "Occupation Data.txt" "Task Statements.txt" onet-provenance.json
npm run import -- economic-index normalized.csv economic-provenance.json
```

O*NET manual input is tab-separated. A normalized custom Economic Index CSV must have `onet_code,task_id,automation_share,augmentation_share,usage_share`. Shares are disjoint fractions in [0,1], never percentages; unknown task foreign keys are rejected. Custom exposure is the task-weighted `automation + 0.5 × augmentation` proxy, not the published observed-exposure estimate. Provenance JSON requires `url`, `version`, and (for Economic Index) `definition`. These commands change the local database; use the persistent-state pipeline to publish managed snapshots, not an untracked local copy.

O*NET data is CC BY 4.0; O*NET® is a USDOL/ETA trademark. Anthropic data attribution and the dataset's CC-BY license are recorded in the export. No endorsement is implied.

## Sentiment and privacy

Sentiment uses an English keyword lexicon with local negation. Raw comments/Bluesky records exist only during collection and are never stored in SQLite. Only hashed dedupe IDs and per-source/day counts and score sums persist. The public export contains aggregates. The daily Jetstream capture is a **bounded live sample**, not a complete day's firehose and not resumable historical coverage. HN and Reddit are bounded samples too. Sarcasm, language, search selection and platform bias limit these scores. They do not change demand, AI risk or status.

## Persistence and operations

- `pipeline-state` stores an AES-256-GCM encrypted, gzipped database plus a checksum manifest. Encryption uses a fresh nonce for each snapshot and the `STATE_ENCRYPTION_KEY` Actions secret. Restores reject missing keys, tampering and unencrypted legacy archives. Only `site/` is deployed. A local state checkout can keep its key in ignored `.state/encryption.key`; never commit or publish that file. Encryption protects snapshots in public repos, but the application source remains public. Never publish a repo that previously held unencrypted database history; migrate the code to a fresh repo instead.
- Posting/observation/news/social-dedupe retention is 210 days. Git history retains old snapshots; a production operator must manage repository growth and any contractual deletion duties. Current rows expiring does not erase Git history.
- A failed source does not fail the whole run. If every job source fails, state is saved but the previous public deployment is retained. The UI flags exports older than 48 hours. A failed Cloudflare deployment also leaves the preceding deployment in place.
- Local runs hold an exclusive `.sqlite.lock`. Remove a stale lock only after confirming no process is running. Never remove the DB to fix a lock.
- One HTTP response is capped at 12 MB; retained state decompression is capped at 512 MB. Review limits and database growth before expanding to thousands of employer boards. A long-lived SQLite Git archive eventually needs a planned storage migration; this is the low-volume daily design.
- Back up `pipeline-state` separately. Do not rewind it or restore an older snapshot.

Tests run offline with fixture sources and a temporary local Git remote. They cover dedupe, weekly-data validation and change math, source failures, exposure matching, sentiment privacy, API normalization, RSS safety and connected UI compilation. Live endpoints can still change independently of these tests.
