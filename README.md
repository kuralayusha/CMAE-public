# CMAE — Cold Mail AI Engine

CMAE is a **local-first desktop app** that researches a company from a job URL,
drafts a cold / application mail, saves it to your Gmail Drafts, and then tracks
the resulting Gmail conversations. You always send the mail yourself.

It is an Electron shell around a Next.js (standalone) server with a local
SQLite database. Your data (mails, drafts, CVs, API keys) stays on your machine;
the only network calls are to Gmail (IMAP) and to OpenRouter for model calls.

## Live version and download

- **Website:** [cmae.yusha.dev](https://cmae.yusha.dev) — product page with the
  latest desktop installers.
- **Installers:** macOS (Apple Silicon `.dmg`) and Windows (`.exe`) builds are
  published on the
  [releases page](https://github.com/kuralayusha/cmae-releases/releases/latest).
  Download, install and run — no build step needed.

Prefer to build it yourself? See [Setup](#setup) below.

## Why

Applying to jobs with personalised mails means repeating the same loop:
research the company, find a contact, write the mail, then remember to follow
up and keep track of replies. CMAE automates the research and drafting steps
and keeps the Gmail conversation state in one place, without a hosted backend
holding your mailbox.

## Features

- **Research** (`/research`): paste job URLs; a pipeline of specialist agents
  (`scout → jobfit → contact → research → writer`, checked by a `reviewer` that
  can send work back a step) runs per job with a live terminal view. Output is
  written as files into a `workspace/` folder structure.
- **Gmail Drafts**: generated mails are saved as drafts; CMAE never sends mail.
- **Tracker** (`/tracker`): syncs Gmail over IMAP (last 30 days), assembles
  conversations, and derives application items and statuses (ready to send,
  reply needed, follow-up due, in progress, rejected, closed, ignored). Status
  is computed on read, so follow-up timing is always current.
- **Folders** (`/folders`): browser for the workspace files.
- **Settings** (`/settings`): profile, CVs, Gmail App Password, OpenRouter API
  key, fast / smart model selection, follow-up days, preferred language.
- **Model choice and usage metering**: every model call goes through OpenRouter,
  uses a "fast" or "smart" model slot you can configure, and is metered locally
  (tokens, cost, model). Anonymous counters are uploaded only if telemetry is on.
- **i18n**: English ships as the source; other languages are machine-translated
  at runtime and cached.
- **Desktop updates**: a version gate and `electron-updater` for packaged builds.

## Tech stack

- Next.js 16 (App Router, `output: "standalone"`), React 19, Tailwind CSS 4
- Electron (desktop shell)
- SQLite via `better-sqlite3` + Drizzle ORM (hand-written migrations)
- `imapflow` / `nodemailer` for Gmail, `cheerio` / `pdf-parse` for page and CV parsing
- OpenRouter `chat/completions` for all LLM calls
- TypeScript, `node:test` via `tsx` for tests

## Architecture overview

- `desktop/main.cjs` spawns the Next standalone server as a child process and
  loads it in a window. The UI talks to the local server through `app/api/**`.
- **Research pipeline** (`lib/research`): a conductor runs the agents per job
  and streams progress to the UI over SSE.
- **Tracker** (`lib/sync`, `lib/mail`, `lib/tracker`): Gmail is the source of
  truth, SQLite is a committed mirror, and everything else is derived through a
  staged pipeline (conversation assembly → AI triage → identity resolution →
  event extraction → state machine).
- **LLM access** (`lib/ai-usage`, `lib/llm`): a single entry point
  (`promptWithUsage`) for every model call, handling metering, caching and
  timeouts.
- A small hosted part (a Vercel deployment) serves the download page, the
  translation proxy, the version policy and usage ingest; user data is never
  sent there.

More detail:

- [`CLAUDE.md`](CLAUDE.md) — architecture notes (also useful for AI coding assistants)
- [`docs/tracker-sync-architecture.md`](docs/tracker-sync-architecture.md) — full sync / derive design and edge cases
- [`docs/ai-usage.md`](docs/ai-usage.md) — LLM usage metering, model slots, translate endpoint limits
- [`docs/releasing.md`](docs/releasing.md) — building, packaging and publishing releases (maintainers)

## Prerequisites

- Node.js 22 (the desktop build bundles Node 22.x) and npm
- A C/C++ toolchain for native modules (`better-sqlite3`, `@napi-rs/canvas`):
  Xcode command line tools on macOS, Python + Visual Studio Build Tools on Windows
- An [OpenRouter](https://openrouter.ai/) API key
- A Gmail account with an App Password (for IMAP sync and drafts)

## Setup

```bash
git clone https://github.com/kuralayusha/CMAE.git
cd CMAE
npm install
cp .env.example .env     # then edit .env, see Configuration below
npm run db:migrate       # optional: migrations also run on first database access
```

### Run in the browser (Next only)

```bash
npm run dev
```

### Run the desktop app (Next + Electron)

```bash
npm run desktop:dev
```

Data is stored in `.desktop-data/` during development. A master key file is
created for you there.

### Tests and checks

```bash
npm run test:ai-usage       # usage metering, OpenRouter transport (mocked fetch), migrations
npm run test:tracker-state  # tracker state machine
npm run test:i18n-guard     # translate endpoint validation / rate limit helpers
npm run lint
npx tsc --noEmit            # there is no typecheck script
```

Tests need `--conditions=react-server` (the npm scripts set it) because library
code imports `server-only`. To run a single file:

```bash
node --conditions=react-server --import tsx --test test/tracker-state/effective.test.ts
```

## Configuration

Copy `.env.example` to `.env`. All variables are optional unless noted.

| Variable | Purpose |
|----------|---------|
| `CMAE_MASTER_KEY` | AES-256 key (≥ 16 chars) for encrypting stored secrets. Needed for encryption; a `master.key` file in the app data folder takes precedence when present. Losing it makes stored secrets (OpenRouter key, IMAP credentials) unreadable. |
| `OPENROUTER_API_KEY` | OpenRouter key. Can instead be set in Settings (stored encrypted). On a translation host it is the key that pays for language packs. |
| `CMAE_I18N_MODEL` | Translation host only: pin the translation model. |
| `CMAE_LLM_MODEL_FAST` / `CMAE_LLM_MODEL_SMART` | Translation host only: pin the fast / smart models (defaults in `lib/llm/slots.ts`). |
| `CMAE_I18N_URL` | Host that serves language packs (the desktop app proxies translation there so the API key stays on the server). Set to `local` to translate locally. |
| `CMAE_VERSION_URL` | Version-policy endpoint the desktop app compares against. Set to `local` to use only the bundled `version-policy.json`. |
| `CMAE_GH_TOKEN` | GitHub token for `electron-updater` checks against a private releases repo. |
| `CMAE_DISABLE_SYNC` | Set to `1` to disable IMAP sync. |
| `CMAE_USAGE_INGEST_URL` / `CMAE_USAGE_PRICES_URL` / `CMAE_USAGE_REPORT_URL` | Optional telemetry Edge Function URLs. Unset = telemetry, remote price refresh and remote report are disabled. |
| `CMAE_USAGE_ANON_KEY` | Optional publishable key sent with telemetry requests. |
| `CMAE_USAGE_REPORT_SECRET` | Optional admin usage report secret (`/usage` page). |

Telemetry is off unless you deploy the Edge Functions in `supabase/functions` to your own Supabase project and set these variables. The Edge Functions must enforce their own rate limits and payload caps.

Note: the defaults for `CMAE_I18N_URL` / `CMAE_VERSION_URL` point at the
maintainer's hosted deployment. If you fork the project, point them at your own
host or set them to `local`.

## Project structure

```
app/            Next.js routes: pages (app/(app)), onboarding, and API route handlers (app/api)
components/     React UI components
desktop/        Electron main process
docs/           Design and operations docs
lib/            Server logic: db, research, sync, tracker, mail, llm, ai-usage, i18n, ...
locales/        English source strings, translator hints and overrides
public/         Static assets
scripts/        Migration, desktop build and release scripts
supabase/       Edge functions and SQL for the optional usage ingest/report backend
test/           node:test suites (ai-usage, i18n, tracker-state)
```

## Screenshots

<!-- TODO: add screenshots (tracker, research terminal, settings) to docs/images/ and reference them here. -->

_Screenshots are not available yet._

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Never commit `.env` files or any secrets; `.gitignore` already excludes them.
To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Releasing

Maintainers: see [docs/releasing.md](docs/releasing.md).

## License

[MIT](LICENSE)
