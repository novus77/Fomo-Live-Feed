# Local Distribution Package Design

## Goal

Produce a self-contained Chrome extension ZIP that a trusted user can download,
extract, and load through Chrome's **Load unpacked** flow without installing
Node.js, pnpm, or any project dependency.

## Distribution Boundary

This package targets trusted-user offline distribution, not one-click public
installation. On Windows and macOS, Chrome only supports direct end-user
installation and automatic updates through the Chrome Web Store. The local
package therefore documents Chrome's developer-mode `Load unpacked` flow
honestly and does not generate or advertise a locally installable CRX.

## User Experience

The recipient performs four installation steps:

1. Download the release ZIP.
2. Extract it to a stable local directory.
3. Open `chrome://extensions` and enable Developer mode.
4. Choose **Load unpacked** and select the extracted directory.

The extracted directory itself is the extension root. The user must not need to
find a nested `extension/` or `.output/` folder.

After installation, the guide tells the user to:

1. Keep one authenticated `https://fomo.family/` tab open.
2. Refresh the Fomo tab once after installing or updating the extension.
3. Click the extension action to open the Side Panel.
4. Browse DexScreener or GMGN to receive supported trading-page toasts.

## Package Layout

The release artifact is named:

```text
Fomo-Live-Feed-v<version>-chrome.zip
```

Its root contains the loadable Manifest V3 extension plus the user guide:

```text
manifest.json
sidepanel.html
background.js
chunks/
content-scripts/
assets/
icons/
START-HERE.html
```

`manifest.json` must remain at the ZIP root. The package must not contain source
files, `node_modules`, tests, `.git`, `.pnpm-store`, `.output`, credentials,
private keys, browser profiles, fixture captures, or developer-only documents.

## User Guide

`START-HERE.html` is a standalone UTF-8 document with embedded CSS and no remote
assets, scripts, analytics, or network requests. It uses concise Simplified
Chinese and contains:

- The four installation steps.
- The exact post-install startup sequence.
- A short explanation of where activity comes from: the extension observes the
  authenticated Fomo page's real-time activity and shows validated events in
  the Side Panel and on supported trading pages.
- Supported sites: Fomo, DexScreener, and GMGN.
- A troubleshooting checklist for empty feeds or offline status.
- Update instructions: replace the extracted files with the new release, then
  click Reload on `chrome://extensions` and refresh the Fomo tab.
- Privacy and safety boundaries: no wallet connection, seed phrase, private
  key, signature, trade placement, or credential request.
- Chrome 138 or newer requirement.
- The package version and build timestamp.

The guide must not instruct recipients to install Node.js, pnpm, clone the
repository, run commands, or select a machine-specific absolute path.

## Reproducible Packaging Command

Add a repository script:

```bash
corepack pnpm package:local
```

The command runs a focused packaging program after the normal release gate. It
must:

1. Run TypeScript checks, Vitest, and the WXT production build.
2. Read the release version from `package.json`.
3. Create a fresh staging directory under `.output/local-release/`.
4. Copy the contents of `.output/chrome-mv3/` into the staging root.
5. Generate `START-HERE.html` with the version and an ISO-8601 UTC build time.
6. Verify that the staging root contains a valid `manifest.json` and no banned
   development paths.
7. Create `.output/releases/Fomo-Live-Feed-v<version>-chrome.zip` with the
   extension files at the ZIP root.
8. Generate a neighboring `.sha256` file containing the ZIP's SHA-256 digest
   and filename.
9. Print the absolute artifact and checksum paths.

The staging directory is rebuilt from scratch for every run so stale files
cannot leak into a release. Cleanup is restricted to the exact
`.output/local-release/` staging directory.

## Implementation Boundary

Use a small Node.js ESM packaging script under `scripts/`. Prefer Node built-ins
for filesystem access, hashing, and child processes. Use an already available
archive command or an existing project dependency; do not add a runtime
dependency solely to create ZIP files.

The guide template should live in a focused source file under `scripts/` or
`assets/` and accept only trusted build metadata. It must not interpolate user
content.

## Failure Handling

The packaging command exits non-zero and leaves no publishable ZIP when:

- The release gate fails.
- The production manifest is missing or malformed.
- The manifest version differs from the version expected from `package.json`.
- A required WXT output file or directory is missing.
- A banned path appears in staging or the archive.
- ZIP creation or SHA-256 generation fails.

Write the final ZIP to a temporary filename and rename it only after validation,
so interrupted packaging cannot leave a file that looks ready to distribute.

## Verification

Automated tests cover:

- Stable artifact naming from `package.json` version.
- Guide generation without developer prerequisites or absolute local paths.
- Required installation, startup, troubleshooting, privacy, and update text.
- Manifest-at-root archive layout.
- Banned-path rejection.
- Missing/malformed manifest failure.
- Deterministic file selection that excludes previous release artifacts.
- SHA-256 output matching the produced ZIP.

Release verification runs:

```bash
CI=true corepack pnpm check
CI=true corepack pnpm test:e2e
corepack pnpm package:local
```

The resulting ZIP is extracted into a temporary directory and checked for a
root `manifest.json`. A final manual smoke test loads that extracted directory
in Chrome and verifies the Side Panel opens.

## Non-goals

- Chrome Web Store submission or listing assets.
- Automatic extension updates.
- A locally installable CRX for Windows or macOS.
- Enterprise policy deployment.
- Bundling source code or a development environment.
- Removing the authenticated Fomo-tab requirement.
- Enabling currently gated production enrichment or REST backfill adapters.
