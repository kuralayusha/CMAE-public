# Releasing CMAE

This is the maintainer manual for building, packaging and publishing the CMAE
desktop app. Contributors do not need any of this to work on the code.

Installers are published to the separate **public** repository
[`kuralayusha/cmae-releases`](https://github.com/kuralayusha/cmae-releases).
The source repository does not host installers. If CI publishing is unavailable
(no Actions minutes, missing secrets, etc.), upload the assets manually using
one of the paths below.

**Prerequisite:** the [GitHub CLI](https://cli.github.com/) is installed and
signed in.

```bash
gh auth status
# If needed:
gh auth login
# The token needs contents:write on cmae-releases
# (a personal account with write access to that repo, or a dedicated PAT)
```

The target tag is the `package.json` version: `0.1.0` → release `v0.1.0`.

The landing page and the auto-updater use these URLs:

- Mac DMG: `…/download/vX.Y.Z/CMAE-X.Y.Z-mac-arm64.dmg`
- Win EXE: `…/download/vX.Y.Z/CMAE-X.Y.Z-win-x64.exe`
- Policy: `…/download/vX.Y.Z/policy.json` (plus the site's `version-policy.json`)

---

## Path A — local build + upload script (preferred)

The Mac package is built on **macOS** and the Windows package on **Windows**
(native modules; the Windows build is always win-x64).

```bash
# 1) Version (for a new release)
# package.json → "version": "0.2.0"
node scripts/bump-version-policy.mjs
git add package.json version-policy.json && git commit -m "chore: bump to 0.2.0" && git push

# 2) Build + upload to the public release (Mac — macOS only)
npm run desktop:publish:mac           # unsigned (default)
npm run desktop:publish:mac:signed    # Developer ID + notarize (needs APPLE_*)
# or step by step:
npm run desktop:build:mac             # unsigned
npm run desktop:build:mac:signed      # signed
# equivalent: npm run desktop:build:mac -- --sign
npm run desktop:upload:github -- --platform mac

# On a Windows machine (no signing — a SmartScreen warning is expected):
# One command: win-x64 build + upload to cmae-releases
npm run desktop:publish:win
# or step by step:
npm run desktop:build:win
npm run desktop:upload:github -- --platform win
# equivalent:
# node scripts/desktop-build-win.mjs
# node scripts/desktop-build-win.mjs --upload
```

**Windows ARM64 host:** the release package is always **win-x64**. If the
system Node is arm64, `scripts/desktop-build-win.mjs` downloads a portable x64
Node to the path below and re-runs itself under it:

`%LOCALAPPDATA%\node-win-x64\node-v22.23.2-win-x64\`
(e.g. `C:\Users\<you>\AppData\Local\node-win-x64\node-v22.23.2-win-x64\node.exe`)

The version can be changed with `CMAE_WIN_NODE_VERSION` or
`CMAE_BUNDLE_NODE_VERSION` (default `22.23.2`). Prerequisites: Python and VS
Build Tools (MSVC v143; on an ARM64 host also `VC.Tools.ARM64` plus the x64
toolset), and `gh auth login`.

**Mac signing (local):** unsigned by default. `--sign` /
`desktop:build:mac:signed` looks for a **Developer ID Application** identity in
the keychain and removes `identity: null` from `electron-builder.yml` through a
temporary config (the committed file is not modified). For notarization,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` must be set in
`.env` / `.env.local`; without them the build is signed but notarization is
skipped.

The script (`scripts/upload-desktop-github.mjs`):

1. Creates the `vX.Y.Z` release on `cmae-releases` if it does not exist.
2. Uploads the relevant assets from `dist-desktop/` with `--clobber`.
3. Updates `version-policy.json` and also attaches it to the release as
   `policy.json`.

**Expected in `dist-desktop/` on Mac:**

| File | Required |
|------|----------|
| `CMAE-{ver}-mac-arm64.dmg` | yes |
| `CMAE-{ver}-arm64-mac.zip` | yes |
| `latest-mac.yml` | yes |
| `*.blockmap` | optional (differential updates) |

**Expected in `dist-desktop/` on Windows:**

| File | Required |
|------|----------|
| `CMAE-{ver}-win-x64.exe` | yes |
| `latest.yml` | yes |
| `*.exe.blockmap` | optional |

---

## Path B — download from an Actions artifact and upload by hand

If the Mac/Win jobs (or an earlier run) produced artifacts, you can publish
without spending Actions minutes: download the artifact and use
`gh release upload`.

### 1) Find the artifact ID

```bash
# Source repo
gh run list --repo kuralayusha/CMAE --workflow "Desktop Win" --limit 5
gh run list --repo kuralayusha/CMAE --workflow "Desktop Mac" --limit 5

# Artifacts of a specific run
gh api repos/kuralayusha/CMAE/actions/runs/<RUN_ID>/artifacts --jq '.artifacts[] | {id, name, size_in_bytes, expired}'
```

Artifact names: **CMAE-mac-dmg**, **CMAE-win-nsis**. If `expired: true` it
cannot be downloaded and you must rebuild.

### 2) Download and extract

```bash
# Windows example (artifact id comes from the Actions output above)
mkdir -p /tmp/cmae-win-art/extracted
gh api repos/kuralayusha/CMAE/actions/artifacts/<ARTIFACT_ID>/zip > /tmp/cmae-win-art/win-art.zip
unzip -o /tmp/cmae-win-art/win-art.zip -d /tmp/cmae-win-art/extracted
ls -lah /tmp/cmae-win-art/extracted
```

Mac works the same way; the artifact is called `CMAE-mac-dmg` and usually
contains `CMAE-{ver}-mac-arm64.dmg`.

> **Note:** the `Desktop Win` / `Desktop Mac` workflows often upload **only**
> the `.exe` / `.dmg` — `latest.yml`, the zip and blockmaps may be missing. The
> exe/dmg is enough for manual downloads; auto-update additionally needs
> `latest.yml` / `latest-mac.yml` (see step 5).

### 3) Create the release if it does not exist

```bash
gh release view v0.1.0 --repo kuralayusha/cmae-releases \
  || gh release create v0.1.0 --repo kuralayusha/cmae-releases \
       --title "CMAE 0.1.0" --notes "Desktop release v0.1.0"
```

### 4) Upload assets

```bash
# Windows — at least the exe
gh release upload v0.1.0 --repo kuralayusha/cmae-releases --clobber \
  /tmp/cmae-win-art/extracted/CMAE-0.1.0-win-x64.exe

# Mac — at least the dmg (add the zip and yml too if you have them)
gh release upload v0.1.0 --repo kuralayusha/cmae-releases --clobber \
  /tmp/cmae-mac-art/extracted/CMAE-0.1.0-mac-arm64.dmg
```

### 5) If the artifact has no `latest.yml` (Windows updater)

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

For Mac, prefer the `latest-mac.yml` generated by electron-builder; if it is
missing, use the same template with `url` / `path` pointing at the `.dmg` /
`.zip`.

### 6) Update `policy.json` and attach it to the release

In the repo's [`version-policy.json`](../version-policy.json), `latest`,
`downloads.darwin-arm64` and `downloads.win32-x64` must point at the right
tag/URLs. Example:

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
# Edit / commit version-policy.json in the source repo (for the Vercel deploy),
# and also copy it to the release so clients can read it without waiting for a
# landing-page deploy:
cp version-policy.json /tmp/policy.json
gh release upload v0.1.0 --repo kuralayusha/cmae-releases --clobber /tmp/policy.json
```

### 7) Verify

```bash
gh api repos/kuralayusha/cmae-releases/releases/tags/v0.1.0 \
  --jq '[.assets[].name]'

curl -sI "https://github.com/kuralayusha/cmae-releases/releases/download/v0.1.0/CMAE-0.1.0-win-x64.exe" | head -5
curl -sL "https://github.com/kuralayusha/cmae-releases/releases/download/v0.1.0/latest.yml"
```

Release page: https://github.com/kuralayusha/cmae-releases/releases/tag/v0.1.0

---

## Quick checklist

- [ ] `gh auth` works and you can write to `cmae-releases`
- [ ] The tag matches `v{package.json version}`
- [ ] Mac: at least the `.dmg` (for the updater also `latest-mac.yml` + zip)
- [ ] Win: at least the `.exe` (for the updater also `latest.yml`)
- [ ] `policy.json` / `version-policy.json` download URLs point at the new assets
- [ ] On the landing page, the Mac and Win buttons 302 to the file download

## Release & deploy: what happens when?

### 1) A normal `git push` (code to main)

- **Vercel** redeploys the site (landing page / API).
- No packages are built; the landing links follow whatever
  `version-policy.json` / the release's `policy.json` says.
- Note: the `Desktop Mac` / `Desktop Win` jobs may run on push — they only
  produce Actions artifacts and do not publish to the public release.

### 2) A new version (package + link + auto-update)

1. Bump the `package.json` version → `node scripts/bump-version-policy.mjs` →
   commit + push.
2. **If Actions is available:** Actions → **Desktop Release** → branch `main` →
   tag `vX.Y.Z`. Secret: `RELEASES_GITHUB_TOKEN` (a PAT with `contents:write`
   on `cmae-releases`).
3. **If Actions is not available:** use the manual paths above (A or B).

## Desktop notes

Electron shell + Next standalone server. Data lives under the app's userData
folder, not the project directory. The first launch creates the master key
automatically; users configure Gmail and API keys during onboarding.

Native modules (`better-sqlite3`, `@napi-rs/canvas`) must be built on the
target OS — Mac build on macOS, Windows build on Windows (or CI).

Packaged builds (DMG/EXE) do **not** inherit your project `.env` or shell
secrets (`OPENROUTER_API_KEY`, etc.). Testers always configure Gmail /
OpenRouter in onboarding, so every install follows the same clean path.
`desktop:dev` still loads `.env` for convenience.

### Updates (version gate)

The desktop app compares the `package.json` version against the remote policy
at `https://cmae.vercel.app/api/version` (served from
[`version-policy.json`](../version-policy.json)).

- Below `minSupported` (or `force: true`) → full-screen lock + download /
  install call to action.
- Behind `latest` only → dismissible banner; `electron-updater` reads the
  public `cmae-releases` repo.
- Reinstalling a newer DMG/NSIS **keeps** userData (do not use Settings →
  Uninstall).

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

Without signing secrets, release builds still upload **unsigned** artifacts
(Gatekeeper / SmartScreen warnings remain). Without `RELEASES_GITHUB_TOKEN`, CI
cannot publish to the public releases repo.

Encode a cert: `base64 -i cert.p12 | pbcopy` (macOS) /
`certutil -encode cert.pfx -` (Windows).

Default local Mac builds keep `mac.identity: null` (unsigned). Opt in with
`npm run desktop:build:mac:signed` / `--sign`, which uses a temp config so the
committed yml stays clean. CI runs `scripts/ci-enable-mac-signing.mjs` when
`MAC_CSC_LINK` is set.

### CI (artifacts only)

- Mac: [`.github/workflows/desktop-mac.yml`](../.github/workflows/desktop-mac.yml) → artifact **CMAE-mac-dmg**
- Windows: [`.github/workflows/desktop-win.yml`](../.github/workflows/desktop-win.yml) → artifact **CMAE-win-nsis**
- Release: [`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml) (`workflow_dispatch`) → public `cmae-releases`

### First open of an unsigned build

**Mac (Gatekeeper):** open the `.dmg`, drag **CMAE** to Applications.
Right-click **CMAE** → **Open** → confirm **Open**. After that, a normal
double-click works.

**Windows (SmartScreen):** run the `.exe` installer. If SmartScreen warns,
choose **More info** → **Run anyway**, then finish the NSIS wizard.
