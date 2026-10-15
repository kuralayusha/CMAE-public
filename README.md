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
npm run desktop:dev          # Next + Electron window (uses project .env)
npm run desktop:build:mac    # macOS only → dist-desktop/*.dmg
npm run desktop:build:win    # Windows only → dist-desktop/*.exe
```

Packaged builds (DMG/EXE) do **not** inherit your project `.env` or shell secrets
(`CURSOR_API_KEY`, etc.). Testers always configure Gmail / Cursor in onboarding —
same clean path every time. `desktop:dev` still loads `.env` for convenience.

### Updates (version gate)

Desktop compares `package.json` version against the remote policy at
`https://cmae.vercel.app/api/version` (from [`version-policy.json`](version-policy.json)).

- Below `minSupported` (or `force: true`) → full-screen lock + download / install CTA
- Behind `latest` only → dismissible banner; `electron-updater` also checks GitHub Releases
- Reinstalling a newer DMG/NSIS **keeps** userData (do not use Settings → Uninstall)

### Release (GitHub Releases)

1. Bump `version` in `package.json` and mirror fields in `version-policy.json` (`latest`, download URLs, notes).
2. Commit, tag `vX.Y.Z`, push the tag.
3. [`.github/workflows/desktop-release.yml`](.github/workflows/desktop-release.yml) builds Mac + Win with `CMAE_OBFUSCATE=1` and publishes to the GitHub Release.
4. Deploy the same commit to Vercel so `/api/version` serves the new policy.

### Code signing secrets (GitHub Actions)

| Secret | Platform | Purpose |
|--------|----------|---------|
| `MAC_CSC_LINK` | Mac | Base64 Developer ID Application `.p12` |
| `MAC_CSC_KEY_PASSWORD` | Mac | p12 password |
| `APPLE_ID` | Mac | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | Mac | App-specific password |
| `APPLE_TEAM_ID` | Mac | Team ID |
| `WIN_CSC_LINK` | Win | Base64 Authenticode `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | Win | pfx password |

Without these, release builds still publish **unsigned** artefacts (Gatekeeper / SmartScreen warnings remain).

Encode a cert: `base64 -i cert.p12 | pbcopy` (macOS) / `certutil -encode cert.pfx -` (Windows).

Local Mac builds keep `mac.identity: null` in `electron-builder.yml` so keychain “Apple Development” certs are never auto-picked. CI runs `scripts/ci-enable-mac-signing.mjs` to strip that line before build, then signs only when `MAC_CSC_LINK` is set.

### CI (artefacts only)

- Mac: [`.github/workflows/desktop-mac.yml`](.github/workflows/desktop-mac.yml) → artefact **CMAE-mac-dmg**
- Windows: [`.github/workflows/desktop-win.yml`](.github/workflows/desktop-win.yml) → artefact **CMAE-win-nsis**
- Release: [`.github/workflows/desktop-release.yml`](.github/workflows/desktop-release.yml) on `v*` tags → GitHub Releases

### First open (unsigned)

**Mac (Gatekeeper):** Open the `.dmg`, drag **CMAE** to Applications. Right-click **CMAE** → **Open** → confirm **Open**. After that, normal double-click works.

**Windows (SmartScreen):** Run the `.exe` installer. If SmartScreen warns, choose **More info** → **Run anyway**, then finish the NSIS wizard.
