# CMAE — Cold Mail AI Engine

Local-first cold mail agent.

## Manuel release (Actions dakikası yokken)

Installer’lar **public** [`kuralayusha/cmae-releases`](https://github.com/kuralayusha/cmae-releases) üzerinde yaşar. Kaynak repo (`CMAE`) private kalır. CI publish çalışmıyorsa (Actions dakikası bitti, secret yok, vs.) aşağıdaki yollardan biriyle asset yükle.

**Önkoşul:** [GitHub CLI](https://cli.github.com/) kurulu ve giriş yapılmış olmalı.

```bash
gh auth status
# Gerekirse:
gh auth login
# Token’ın cmae-releases üzerinde contents:write yetkisi olmalı
# (personal account + o repo’ya write, veya dedicated PAT)
```

Hedef tag = `package.json` version’ı: `0.1.0` → release `v0.1.0`.

Landing / auto-update bu URL’leri kullanır:

- Mac DMG: `…/download/vX.Y.Z/CMAE-X.Y.Z-mac-arm64.dmg`
- Win EXE: `…/download/vX.Y.Z/CMAE-X.Y.Z-win-x64.exe`
- Policy: `…/download/vX.Y.Z/policy.json` (+ site `version-policy.json`)

---

### Yol A — Lokal build + upload script (tercih)

Mac paketi **macOS**’te, Windows paketi **Windows**’ta üretilir (native modüller).

```bash
# 1) Sürüm (yeni release ise)
# package.json → "version": "0.2.0"
node scripts/bump-version-policy.mjs
git add package.json version-policy.json && git commit -m "chore: bump to 0.2.0" && git push

# 2) Build + public release’e yükle (Mac — sadece macOS)
npm run desktop:publish:mac           # imzasız (varsayılan)
npm run desktop:publish:mac:signed    # Developer ID + notarize (APPLE_* lazım)
# veya adım adım:
npm run desktop:build:mac             # imzasız
npm run desktop:build:mac:signed      # imzalı
# eşdeğer: npm run desktop:build:mac -- --sign
npm run desktop:upload:github -- --platform mac

# Windows makinede (imza yok — SmartScreen uyarısı normal):
npm run desktop:publish:win
# veya:
npm run desktop:build:win
npm run desktop:upload:github -- --platform win
```

**Mac imza (lokal):** Varsayılan unsigned. `--sign` / `desktop:build:mac:signed` keychain’de **Developer ID Application** arar; `electron-builder.yml`’daki `identity: null`’ı geçici config ile kaldırır (dosyayı kirletmez). Notarize için `.env` / `.env.local` içinde `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` olmalı — yoksa imzalar, notarize atlar.

Script (`scripts/upload-desktop-github.mjs`) şunları yapar:

1. `cmae-releases` üzerinde `vX.Y.Z` release yoksa oluşturur
2. `dist-desktop/` içinden ilgili asset’leri `--clobber` ile yükler
3. `version-policy.json` günceller + release’e `policy.json` olarak da ekler

**Mac’te `dist-desktop/`’ta beklenenler:**

| Dosya | Zorunlu |
|-------|---------|
| `CMAE-{ver}-mac-arm64.dmg` | evet |
| `CMAE-{ver}-arm64-mac.zip` | evet |
| `latest-mac.yml` | evet |
| `*.blockmap` | isteğe bağlı (differential update) |

**Win’de `dist-desktop/`’ta beklenenler:**

| Dosya | Zorunlu |
|-------|---------|
| `CMAE-{ver}-win-x64.exe` | evet |
| `latest.yml` | evet |
| `*.exe.blockmap` | isteğe bağlı |

---

### Yol B — Actions artefact’ten indirip elle yükle

Mac/Win job’ları (veya daha önce koşmuş bir run) artefact üretmişse, dakikasız publish için artefact’i indirip `gh release upload` yeter.

#### 1) Artefact ID bul

```bash
# Private kaynak repo
gh run list --repo kuralayusha/CMAE --workflow "Desktop Win" --limit 5
gh run list --repo kuralayusha/CMAE --workflow "Desktop Mac" --limit 5

# Belirli run’ın artefact’leri
gh api repos/kuralayusha/CMAE/actions/runs/<RUN_ID>/artifacts --jq '.artifacts[] | {id, name, size_in_bytes, expired}'
```

İsimler: **CMAE-mac-dmg**, **CMAE-win-nsis**. `expired: true` ise indirmez — yeniden build gerekir.

#### 2) İndir + aç

```bash
# Win örneği (artefact id = ACTIONS’tan)
mkdir -p /tmp/cmae-win-art/extracted
gh api repos/kuralayusha/CMAE/actions/artifacts/<ARTIFACT_ID>/zip > /tmp/cmae-win-art/win-art.zip
unzip -o /tmp/cmae-win-art/win-art.zip -d /tmp/cmae-win-art/extracted
ls -lah /tmp/cmae-win-art/extracted
```

Mac için aynı mantık; artefact adı `CMAE-mac-dmg`, çıktı genelde `CMAE-{ver}-mac-arm64.dmg`.

> **Not:** `Desktop Win` / `Desktop Mac` workflow’ları çoğu zaman **sadece** `.exe` / `.dmg` yükler — `latest.yml`, zip, blockmap gelmeyebilir. Manuel indirme için exe/dmg yeter; auto-update için `latest.yml` / `latest-mac.yml` ayrıca gerekir (aşağıda).

#### 3) Release yoksa oluştur

```bash
gh release view v0.1.0 --repo kuralayusha/cmae-releases \
  || gh release create v0.1.0 --repo kuralayusha/cmae-releases \
       --title "CMAE 0.1.0" --notes "Desktop release v0.1.0"
```

#### 4) Asset yükle

```bash
# Windows — en az exe
gh release upload v0.1.0 --repo kuralayusha/cmae-releases --clobber \
  /tmp/cmae-win-art/extracted/CMAE-0.1.0-win-x64.exe

# Mac — en az dmg (zip + yml varsa onları da ekle)
gh release upload v0.1.0 --repo kuralayusha/cmae-releases --clobber \
  /tmp/cmae-mac-art/extracted/CMAE-0.1.0-mac-arm64.dmg
```

#### 5) Artefact’te `latest.yml` yoksa (Win updater)

```bash
EXE=/tmp/cmae-win-art/extracted/CMAE-0.1.0-win-x64.exe
SIZE=$(stat -f%z "$EXE")   # Linux: stat -c%s
SHA=$(shasum -a 512 "$EXE" | awk '{print $1}' | xxd -r -p | base64)
DATE=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

cat > /tmp/cmae-win-art/extracted/latest.yml <<EOF
version: 0.1.0
files:
  - url: CMAE-0.1.0-win-x64.exe
    sha512: ${SHA}
    size: ${SIZE}
path: CMAE-0.1.0-win-x64.exe
sha512: ${SHA}
releaseDate: '${DATE}'
EOF

gh release upload v0.1.0 --repo kuralayusha/cmae-releases --clobber \
  /tmp/cmae-win-art/extracted/latest.yml
```

Mac için electron-builder’ın ürettiği `latest-mac.yml` tercih edilir; yoksa aynı şablonla `url`/`path`’i `.dmg` / `.zip` yap.

#### 6) `policy.json` güncelle ve release’e koy

Repodaki [`version-policy.json`](version-policy.json) içinde `latest`, `downloads.darwin-arm64`, `downloads.win32-x64` doğru tag/URL’leri göstermeli. Örnek:

```json
{
  "latest": "0.1.0",
  "minSupported": "0.1.0",
  "force": false,
  "cdnBase": "https://github.com/kuralayusha/cmae-releases/releases/download",
  "releaseUrl": "https://github.com/kuralayusha/cmae-releases/releases/latest",
  "updateFeedUrl": "https://github.com/kuralayusha/cmae-releases/releases/latest",
  "releasesRepo": "kuralayusha/cmae-releases",
  "downloads": {
    "darwin-arm64": "https://github.com/kuralayusha/cmae-releases/releases/download/v0.1.0/CMAE-0.1.0-mac-arm64.dmg",
    "win32-x64": "https://github.com/kuralayusha/cmae-releases/releases/download/v0.1.0/CMAE-0.1.0-win-x64.exe"
  },
  "notes": ""
}
```

```bash
# Kaynak repoda version-policy.json’ı düzenle / commit et (Vercel deploy için)
# Release asset olarak da kopyala (landing deploy beklemeden okusun):
cp version-policy.json /tmp/policy.json
gh release upload v0.1.0 --repo kuralayusha/cmae-releases --clobber /tmp/policy.json
```

#### 7) Doğrula

```bash
gh api repos/kuralayusha/cmae-releases/releases/tags/v0.1.0 \
  --jq '[.assets[].name]'

curl -sI "https://github.com/kuralayusha/cmae-releases/releases/download/v0.1.0/CMAE-0.1.0-win-x64.exe" | head -5
curl -sL "https://github.com/kuralayusha/cmae-releases/releases/download/v0.1.0/latest.yml"
```

Release sayfası: https://github.com/kuralayusha/cmae-releases/releases/tag/v0.1.0

---

### Hızlı kontrol listesi

- [ ] `gh auth` çalışıyor, `cmae-releases`’a yazabiliyorsun
- [ ] Tag `v{package.json version}` ile uyumlu
- [ ] Mac: en az `.dmg` (updater için `latest-mac.yml` + zip)
- [ ] Win: en az `.exe` (updater için `latest.yml`)
- [ ] `policy.json` / `version-policy.json` download URL’leri yeni asset’leri gösteriyor
- [ ] Landing’de Mac + Win butonları 302 → dosya indiriyor

## Release & deploy (ne ne zaman olur?)

### 1) Normal `git push` (main’e kod)

- **Vercel** siteyi yeniler (landing / API).
- Paket üretilmez; landing linkleri `version-policy.json` / release `policy.json` neyse odur.
- Not: `Desktop Mac` / `Desktop Win` job’ları bazen push’ta açılır — sadece Actions artefact, public release’e basmaz.

### 2) Yeni sürüm (paket + link + auto-update)

1. `package.json` version yükselt → `node scripts/bump-version-policy.mjs` → commit + push
2. **Actions açıksa:** Actions → **Desktop Release** → branch `main` → tag `vX.Y.Z`  
   Secret: `RELEASES_GITHUB_TOKEN` (`cmae-releases` için `contents:write` PAT)
3. **Actions yoksa:** yukarıdaki **Manuel release** (Yol A veya B)

## Active surfaces

- **Tracker** (`/` → `/tracker`) — Gmail sync (last 30 days) + research outputs; application status list; Gmail Drafts (you send)
- **Research** (`/research`) — URL list → parallel agents + live terminals → `workspace/`
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

Sync: **Gmail sync** = incremental (UID cursor); **Full sync** = re-fetch last 30 days. Both upsert by `messageId` — mail outside the window is not deleted, no duplicates. Research `done` → light merge (no IMAP/AI). Set `CMAE_DISABLE_SYNC=1` to disable IMAP.

## Research architecture

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
npm run desktop:dev               # Next + Electron window (uses project .env)
npm run desktop:build:mac         # macOS — unsigned DMG/ZIP
npm run desktop:build:mac:signed  # macOS — Developer ID + notarize if APPLE_* set
npm run desktop:build:win         # Windows only → dist-desktop/*.exe (unsigned)
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

Default local Mac builds keep `mac.identity: null` (unsigned). Opt in with `npm run desktop:build:mac:signed` / `--sign` — uses a temp config so the committed yml stays clean. CI runs `scripts/ci-enable-mac-signing.mjs` when `MAC_CSC_LINK` is set.

### CI (artefacts only)

- Mac: [`.github/workflows/desktop-mac.yml`](.github/workflows/desktop-mac.yml) → artefact **CMAE-mac-dmg**
- Windows: [`.github/workflows/desktop-win.yml`](.github/workflows/desktop-win.yml) → artefact **CMAE-win-nsis**
- Release: [`.github/workflows/desktop-release.yml`](.github/workflows/desktop-release.yml) workflow_dispatch → public `cmae-releases`

### First open (unsigned)

**Mac (Gatekeeper):** Open the `.dmg`, drag **CMAE** to Applications. Right-click **CMAE** → **Open** → confirm **Open**. After that, normal double-click works.

**Windows (SmartScreen):** Run the `.exe` installer. If SmartScreen warns, choose **More info** → **Run anyway**, then finish the NSIS wizard.
