# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

CMAE ("Cold Mail AI Engine") is a **local-first desktop app** (Electron shell around a Next.js standalone server + SQLite) that researches companies from a job URL, drafts cold/application mails, saves them to Gmail Drafts, and tracks the resulting Gmail conversations.

`AGENTS.md` says this Next.js (16.x, React 19) has breaking changes from what you know: read the relevant guide in `node_modules/next/dist/docs/` before writing Next-specific code (routing, middleware, config, caching).

## Commands

```bash
npm run dev                  # next dev only (browser, no Electron)
npm run desktop:dev          # Next on 127.0.0.1:3000 + Electron window; data in .desktop-data/
npm run lint                 # eslint (no typecheck script: use `npx tsc --noEmit`)
npm run db:migrate           # tsx scripts/migrate.ts (migrations also auto-run on first getDb())

npm run test:ai-usage        # node:test via tsx (usage metering, OpenRouter transport via mocked fetch, migrations)
npm run test:tracker-state   # test/tracker-state/*.test.ts
# single test file:
node --conditions=react-server --import tsx --test test/tracker-state/effective.test.ts
```

`--conditions=react-server` is required for tests because lib code imports `server-only`. Tests must use explicit temp dirs/DB handles and never call `getAppRoot()` (it rewrites the user's `~/.cmae-app-root`).

Release/packaging (`desktop:build:mac[:signed]`, `desktop:build:win`, `desktop:publish:*`, `version:sync-policy`) is documented step by step in `README.md` (Turkish). Key facts: installers are published to the separate public repo `kuralayusha/cmae-releases`; the tag is `v<package.json version>`; bumping the version means editing `package.json` then running `node scripts/bump-version-policy.mjs` (updates `version-policy.json`) and committing both. Mac builds only on macOS, Windows builds only on Windows (native modules, win-x64 always).

Env: copy `.env.example`. `CMAE_MASTER_KEY` (≥16 chars) is needed for encryption; `OPENROUTER_API_KEY` can alternatively be set in the Settings UI (stored encrypted); on the Vercel translation host it is the maintainer's admin key. `CMAE_DISABLE_SYNC=1` turns off IMAP sync. Do not read or print `.env*` files.

## Architecture

### Runtime topology
- `desktop/main.cjs` (Electron main) spawns the Next **standalone** server as a separate bundled-Node child process and loads it in a window. `desktop/` is obfuscated into `desktop-pack/` and the server into `desktop-resources/` at build time (both gitignored, as are `dist-desktop/`, `.desktop-data/`, `data/`, `workspace/`).
- All UI talks to the local server through `app/api/**` route handlers; there is no remote backend for user data. The only hosted piece is the Vercel deployment, where `middleware.ts` restricts the site to the download landing page + `/api` (i18n translate proxy, `/api/version`, usage ingest). Code that must behave differently on Vercel checks `process.env.VERCEL`.
- `instrumentation.ts` → `instrumentation.node.ts` runs once per server process: restores `CMAE_USER_DATA` from the sticky file, then starts the sync scheduler (`lib/sync/scheduler.ts`) and the AI-usage uploader, both non-blocking. State that must survive HMR/duplicate module instances lives on `globalThis` (e.g. `__cmaeSyncScheduler`).

### App data location is subtle (`lib/paths.ts`)
`getAppRoot()` resolves, in order: `CMAE_USER_DATA` env → sticky file `~/.cmae-app-root` → Vercel `/tmp/cmae` → OS user-data dir if packaged → `process.cwd()`. The result is cached for the process. The sticky file exists because Next workers/RSC children sometimes lose the env and would otherwise open a different SQLite (causing onboarding bounce loops). SQLite is at `<root>/data/cmae.db`, user files under `<root>/workspace/`.
`lib/crypto/encryption.ts` (AES-256-GCM) prefers `<root>/master.key` over `CMAE_MASTER_KEY` so `next dev` and the desktop app can open the same DB. `desktop:dev` creates that key file. Losing/changing the key makes stored secrets (OpenRouter API key, IMAP credentials) undecryptable.

### Database (`lib/db`)
better-sqlite3 + drizzle (`schema.ts`), WAL, `busy_timeout=5000`. **Schema changes are hand-written migrations** in `lib/db/migrations/NNN_name.ts`, registered in order in `migrations/index.ts` (drizzle-kit/`drizzle.config.ts` is not the source of truth). `getDb()` reopens the handle if the data path flips or the file inode changes (wipe/replace), so never cache the returned instance across `await`s.

### Research pipeline (`lib/research`)
`conductor.ts` runs a fixed specialist pipeline per job: `scout → jobfit → contact → research → writer`, with a `reviewer` that can rewind (`MAX_REWINDS`, `MAX_PER_AGENT`). Agents live in `lib/research/agents/`, narrate progress via `speak()` into a per-job event stream (`events.ts`) consumed by the live terminal UI over SSE (`app/api/research/[id]/stream`). Jobs are cancellable via `cancel.ts`/`abort.ts`; the LLM SDK has no abort API, so calls are raced against the job's abort promise. Output is written as files into the workspace folder structure (`workspace.ts`, `lib/workspace/filenames.ts`); folder name suffixes encode status (`folder-status.ts`).

### Tracker (`lib/tracker`, `lib/sync`, `lib/mail`)
The most complex area. Gmail (IMAP) is the source of truth; SQLite is a committed mirror; everything else is derived.
- **Sync engine** (`lib/sync/engine.ts`) runs persistent DB-backed jobs with lease/heartbeat (needed because two server processes can exist on macOS), driven by the scheduler, UI nudges, and Electron wake events (`POST /api/internal/wake`). `lib/mail/source.ts` abstracts the mail provider (`gmail-imap-source.ts`, `fake-source.ts` for smoke tests).
- **Derivation** (`lib/tracker/derive/`) turns mails into tracker items through stages: 0 conversation assembly → 1 AI triage → 2 identity resolution (which employer) → 3 event extraction → 4 state machine (`effective.ts`). Mail→item assignments are persisted; a dirty `derive_state` queue is processed in chunks. "Regroup" (`regroup.ts`) is only for explicit user-requested AI regrouping.
- **Status is computed on read** (time-dependent, e.g. follow-up days), not stored.
- **Column ownership**: sync writes only derived columns; user actions write only user columns. Every write bumps `tracker_revision`; the client store (`lib/tracker/client-store.ts`) only accepts newer revisions, and changes reach the UI via the SSE bus (`events-bus.ts`, `/api/tracker/events`) + ETag. `GET` handlers must be pure reads (no network, no DB writes).
- Gmail drafts are identified by Message-ID/X-GM-MSGID, not subject; reconcile logic is in `drafts-reconcile.ts`/`gmail-drafts-store.ts`.
- Product decisions encoded in the design: mails deleted in Gmail stay in fact computation (marked "deleted in Gmail"); switching Gmail accounts deletes the old account's data after user confirmation; merge conflicts are asked of the user, never silently resolved.
- `docs/tracker-sync-architecture.md` (English, ~1230 lines) is the full design + edge-case catalog; read the relevant section before changing sync/derive/draft logic. File:line references in it can be stale.

### LLM access (`lib/ai-usage`)
**Every model call must go through `promptWithUsage`** (`lib/ai-usage/call.ts`), the only place that talks to the model API: one OpenRouter `chat/completions` `fetch` via `lib/llm/openrouter.ts` (a test fails on `@cursor/sdk` or direct OpenRouter calls elsewhere). Each call passes a `feature` label from `features.ts` and an explicit `model`; callers get model **and reasoning effort** from `llmForFeature(feature)` (`lib/llm/config.ts`) and pass both to `promptWithUsage` (`model`, `reasoningEffort`). A feature maps to one of two user-configurable slots, **fast** or **smart** (`lib/llm/slots.ts`; Settings → AI), unless "detailed mode" pinned it to its own model+effort (`settings.llm_overrides_json`, only features in `TUNABLE_FEATURES`). The picker UI (`components/ModelPicker.tsx`: company → model line → version → effort) is fed by the filtered live catalog (`isTextChatModel`: text→text chat only) and `lib/llm/catalog.ts`, which also holds our per-company `RECOMMENDED` fast/smart picks — refresh those when the catalog moves on. Add new features to the right slot there. Cost is the `cost` OpenRouter reports (+ upstream cost for BYOK); unknown models are never given a guessed price. It meters tokens/cost/model into `ai_usage_events`, applies the response cache for cacheable features only (keyed incl. model and `prompt_version`, so bump prompt versions like `INTENT_PROMPT_VERSION` when changing prompts), and anonymous counters are uploaded if telemetry is on. Timeout/cancel really abort the request. Importing `lib/ai-usage` (index) registers the SQLite backend; DB-free code (eval harness) imports `./call` directly, as `lib/tracker/llm-core.ts` does. Users who want Gemini etc. add their own provider key inside their OpenRouter account (BYOK); CMAE only ever holds the OpenRouter key. See `docs/ai-usage.md`.

### i18n (`lib/i18n`, `locales/`)
Only English (`locales/en.json`) is shipped as source; other languages are machine-translated at runtime through the `/api/i18n/translate` proxy and cached as a user pack, invalidated when the English pack hash changes. Add every user-visible string as a key in `en.json` and use `t()` (server, `server-only`) or the provider/hooks on the client. `locales/i18n-hints.json` gives translators per-key context (e.g. a label is a status noun, not an imperative) — add a hint for ambiguous keys; `locales/overrides/*.json` hard-overrides specific translations.

## Repo notes
- Path alias `@/*` → repo root. `next.config.ts` sets `output: "standalone"` and lists native packages in `serverExternalPackages`; new native/heavy deps need adding there (and to `outputFileTracingIncludes` if used on Vercel routes).
- `/*turbopackIgnore: true*/` comments on `fs`/`path` calls with dynamic paths are intentional (stop Turbopack from tracing the whole project); keep them when editing such code.
- `zzz-my-notes.md` and `zzz-cover-letter-rules.md` are the owner's personal scratch notes (feature ideas, cover-letter writing rules), not specs; the latter is useful context only when working on the writer agent's prompts.
- README, docs, and many comments are in Turkish; code identifiers and UI strings are English.
