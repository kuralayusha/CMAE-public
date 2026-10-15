# CMAE — Cold Mail AI Engine

Local-first cold mail agent.

## Active surfaces

- **Tracker** (`/` → `/tracker`) — Gmail sync (last 30 days) + search outputs; application status list; Gmail Drafts (you send)
- **Search** (`/search`) — URL list → parallel agents + live terminals → `workspace/`
- **Folders** (`/folders`) — workspace file browser
- **Settings** (`/settings`) — profile, CVs, Gmail App Password, Cursor API key, follow-up days, preferred language

## Tracker statuses (priority order)

1. Ready to send (`ready_to_send`)
2. Reply needed (`needs_reply`, positive → negative)
3. Follow-up due (`follow_up_due`, max 2)
4. Active conversations (`in_progress`)
5. Rejected (`rejected`)
6. Closed (`closed`)
7. Ignored (`ignored`, after 2 follow-ups)

Sync: **Gmail sync** = incremental (UID cursor); **Hard Sync** = re-fetch last 30 days. Both upsert by `messageId` — mail outside the window is not deleted, no duplicates. Search `done` → light merge (no IMAP/AI). Set `CMAE_DISABLE_SYNC=1` to disable IMAP.

## Search architecture

**Conductor** + specialist agents (parallel URLs, each URL has its own conductor):

`scout → jobfit → contact → research → writer → reviewer`

Reviewer scores (threshold ~72). If it dislikes the pack it rewinds to `rewindTo` and re-runs from that step through writer, then reviews again.

Terminals: lines tagged `[scout]`, `[writer]`, `[reviewer]`, …

## Run (web / local Next)

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

## Desktop

Electron shell + Next standalone. Data lives under the app userData folder (not the project directory). First launch creates `CMAE_MASTER_KEY` automatically; friends configure Gmail (and API keys) in onboarding.

Native modules (`better-sqlite3`, `@napi-rs/canvas`) must be built on the target OS — Mac build on macOS, Windows build on Windows (or CI).

### Local

```bash
npm run desktop:dev          # Next + Electron window
npm run desktop:build:mac    # macOS only → dist-desktop/*.dmg
npm run desktop:build:win    # Windows only → dist-desktop/*.exe
```

### CI

- Mac: [`.github/workflows/desktop-mac.yml`](.github/workflows/desktop-mac.yml) on `macos-latest` → artefact **CMAE-mac-dmg**
- Windows: [`.github/workflows/desktop-win.yml`](.github/workflows/desktop-win.yml) on `windows-latest` → artefact **CMAE-win-nsis**

Push to `main` (desktop-related paths) or **Actions → Desktop Mac / Desktop Win → Run workflow**.

### First open (unsigned)

**Mac (Gatekeeper):** Open the `.dmg`, drag **CMAE** to Applications. Right-click **CMAE** → **Open** → confirm **Open**. After that, normal double-click works.

**Windows (SmartScreen):** Run the `.exe` installer. If SmartScreen warns, choose **More info** → **Run anyway**, then finish the NSIS wizard.
