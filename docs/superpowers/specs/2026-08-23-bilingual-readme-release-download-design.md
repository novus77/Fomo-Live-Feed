# Bilingual README and Release Download Design

## Goal

Make the GitHub project page usable for both Simplified Chinese and English
readers, and provide an explicit, working path for downloading the packaged
Chrome extension.

## README structure

`README.md` will start with language anchor links and then present two complete
sections in this order:

1. 简体中文
2. English

Both sections will cover the same user-facing information: project summary,
release download, unpacked-extension installation, requirements, core
capabilities, privacy boundaries, development commands, and documentation.
Maintainer-only details will remain concise and consistent across languages.

## Release distribution

GitHub Releases is the canonical distribution channel. Version `0.1.0` will be
published under tag `v0.1.0` with these assets:

- `Fomo-Live-Feed-v0.1.0-chrome.zip`
- `Fomo-Live-Feed-v0.1.0-chrome.zip.sha256`

The README will describe the UI path explicitly:

`Repository → Releases → Latest → Assets → Fomo-Live-Feed-v0.1.0-chrome.zip`

It will also include a direct versioned link:

`https://github.com/novus77/Fomo-Live-Feed/releases/download/v0.1.0/Fomo-Live-Feed-v0.1.0-chrome.zip`

The repository will not track generated ZIP files, avoiding binary growth in
Git history. Future versions will use the same filename and tag convention.

## Installation flow

Readers will be told to download the ZIP, extract it, open
`chrome://extensions`, enable Developer mode, choose Load unpacked, and select
the extracted directory. The minimum supported browser remains Chrome 138.

## Validation

- Verify the Chinese and English sections describe equivalent behavior.
- Verify all Markdown anchors and repository-relative documentation links.
- Verify the release assets' SHA-256 checksum before upload.
- Create the private GitHub Release and confirm its direct asset URL resolves.
- Confirm the remote `main` commit matches the local commit after pushing.
