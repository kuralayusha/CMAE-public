# CMAE — Cold Mail AI Engine

Local-first cold mail agent.

## Release & deploy (ne ne zaman olur?)

Installer’lar **public** [`kuralayusha/cmae-releases`](https://github.com/kuralayusha/cmae-releases) reposunda yaşar. Kaynak kod private kalabilir.

### 1) Normal `git push` (main’e kod)

- **Vercel** siteyi yeniler (landing / API).
- Paket üretilmez; landing linkleri `version-policy.json` / release `policy.json` neyse odur.
- Not: `Desktop Mac` / `Desktop Win` job’ları bazen push’ta açılır — sadece Actions artefact, public release’e basmaz.

### 2) Yeni sürüm (paket + link + auto-update)

Sıra:

1. `package.json` version’ı yükselt (örn. `0.1.0` → `0.2.0`)
2. `node scripts/bump-version-policy.mjs`
3. Commit + push
4. Lokal (Actions dakikası yokken):  
   `npm run desktop:publish:mac` / `desktop:publish:win`  
   (**veya** build + `npm run desktop:upload:github -- --platform mac`)  
5. Actions açıksa: **Desktop Release** → `main` → tag `v0.2.0`  
   Secret: `RELEASES_GITHUB_TOKEN` (PAT → `cmae-releases` üzerinde `contents:write`)

Upload, `cmae-releases` üzerinde `vX.Y.Z` Release + asset’leri yazar; landing URL’leri otomatik o tag’e bakar.

### 3) Lokal upload (Actions yokken)

```bash
npm run desktop:build:mac          # imzalı/notarized mümkünse
npm run desktop:upload:github -- --platform mac
# Win için Windows makinede: --platform win
```

`gh auth login` yeterli (repo write).

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
- Behind `latest` only → dismissible banner; `electron-updater` reads public `cmae-releases`
- Reinstalling a newer DMG/NSIS **keeps** userData (do not use Settings → Uninstall)

### Release (public GitHub Releases repo)

See **Release & deploy** at the top. Artefacts → [`kuralayusha/cmae-releases`](https://github.com/kuralayusha/cmae-releases).

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
| `RELEASES_GITHUB_TOKEN` | Both | PAT with `contents:write` on `cmae-releases` |

Without signing secrets, release builds still upload **unsigned** artefacts (Gatekeeper / SmartScreen warnings remain). Without `RELEASES_GITHUB_TOKEN`, CI cannot publish to the public releases repo.

Encode a cert: `base64 -i cert.p12 | pbcopy` (macOS) / `certutil -encode cert.pfx -` (Windows).

Local Mac builds keep `mac.identity: null` in `electron-builder.yml` so keychain “Apple Development” certs are never auto-picked. CI runs `scripts/ci-enable-mac-signing.mjs` to strip that line before build, then signs only when `MAC_CSC_LINK` is set.

### CI (artefacts only)

- Mac: [`.github/workflows/desktop-mac.yml`](.github/workflows/desktop-mac.yml) → artefact **CMAE-mac-dmg**
- Windows: [`.github/workflows/desktop-win.yml`](.github/workflows/desktop-win.yml) → artefact **CMAE-win-nsis**
- Release: [`.github/workflows/desktop-release.yml`](.github/workflows/desktop-release.yml) workflow_dispatch → public `cmae-releases`

### First open (unsigned)

**Mac (Gatekeeper):** Open the `.dmg`, drag **CMAE** to Applications. Right-click **CMAE** → **Open** → confirm **Open**. After that, normal double-click works.

**Windows (SmartScreen):** Run the `.exe` installer. If SmartScreen warns, choose **More info** → **Run anyway**, then finish the NSIS wizard.
