# Bilingual README and Release Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a complete Simplified Chinese and English README with a working, explicit download path for the packaged Chrome extension.

**Architecture:** Keep `README.md` as the bilingual project entry point, with matching Chinese and English sections and stable anchor navigation. Distribute generated binaries only through a versioned GitHub Release, while retaining `.output/releases/` as the local build location and verifying the checksum before upload.

**Tech Stack:** GitHub-flavored Markdown, pnpm packaging script, SHA-256, Git, GitHub CLI

---

### Task 1: Rewrite the project entry point as a bilingual README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Record the current release state**

Run:

```bash
gh release view v0.1.0 --repo novus77/Fomo-Live-Feed
```

Expected before publication: command reports that release `v0.1.0` does not
exist.

- [ ] **Step 2: Replace README with a symmetric bilingual structure**

Use this top-level structure:

```markdown
# Fomo Live Feed

[简体中文](#简体中文) | [English](#english)

## 简体中文

### 下载与安装

[下载 Fomo Live Feed v0.1.0（Chrome ZIP）](https://github.com/novus77/Fomo-Live-Feed/releases/download/v0.1.0/Fomo-Live-Feed-v0.1.0-chrome.zip)

GitHub 页面路径：**Releases → Latest → Assets → `Fomo-Live-Feed-v0.1.0-chrome.zip`**。

1. 下载并解压 ZIP。
2. 在 Chrome 打开 `chrome://extensions`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择刚刚解压的目录。

## English

### Download and install

[Download Fomo Live Feed v0.1.0 for Chrome](https://github.com/novus77/Fomo-Live-Feed/releases/download/v0.1.0/Fomo-Live-Feed-v0.1.0-chrome.zip)

GitHub navigation path: **Releases → Latest → Assets → `Fomo-Live-Feed-v0.1.0-chrome.zip`**.

1. Download and extract the ZIP archive.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the extracted directory.
```

Preserve the current technical content in both languages: Chrome 138 minimum,
Side Panel-only behavior, real-time Fomo capture, local history, localization,
privacy boundaries, development commands, architecture, supported hosts,
documentation links, and MVP limitations. Ensure the two sections make the
same claims.

- [ ] **Step 3: Validate Markdown content and repository links**

Run:

```bash
rg -n "简体中文|English|releases/download/v0.1.0/Fomo-Live-Feed-v0.1.0-chrome.zip|chrome://extensions|Chrome 138" README.md
git diff --check
for path in docs/development.md docs/manual-testing.zh-CN.md docs/privacy.md; do test -f "$path"; done
```

Expected: both language headings, two identical versioned asset URLs,
installation instructions, and Chrome 138 references are present; whitespace
and local documentation checks succeed.

- [ ] **Step 4: Commit the README**

```bash
git add README.md
git commit -m "docs: add bilingual release instructions"
```

Expected: one documentation commit containing only `README.md`.

### Task 2: Rebuild and validate the release artifacts

**Files:**
- Generate: `.output/releases/Fomo-Live-Feed-v0.1.0-chrome.zip`
- Generate: `.output/releases/Fomo-Live-Feed-v0.1.0-chrome.zip.sha256`

- [ ] **Step 1: Produce the release package from the committed source**

Run:

```bash
CI=true corepack pnpm package:local
```

Expected: TypeScript validation, 51 test files / 1155 tests, production build,
and local packaging succeed.

- [ ] **Step 2: Validate checksum and archive shape**

Run:

```bash
cd .output/releases
shasum -a 256 -c Fomo-Live-Feed-v0.1.0-chrome.zip.sha256
unzip -Z1 Fomo-Live-Feed-v0.1.0-chrome.zip
```

Expected: checksum is `OK`; archive includes `manifest.json`, `sidepanel.html`,
`START-HERE.html`, scripts, assets, and icons, with no trading overlay file.

### Task 3: Push main and publish the versioned GitHub Release

**Files:**
- No tracked file changes
- Upload: `.output/releases/Fomo-Live-Feed-v0.1.0-chrome.zip`
- Upload: `.output/releases/Fomo-Live-Feed-v0.1.0-chrome.zip.sha256`

- [ ] **Step 1: Push the documentation commits**

Run:

```bash
git push origin main
```

Expected: `main` is pushed without force and local `main` matches
`origin/main`.

- [ ] **Step 2: Create the private repository release and upload assets**

Run:

```bash
gh release create v0.1.0 \
  .output/releases/Fomo-Live-Feed-v0.1.0-chrome.zip \
  .output/releases/Fomo-Live-Feed-v0.1.0-chrome.zip.sha256 \
  --repo novus77/Fomo-Live-Feed \
  --target main \
  --title "Fomo Live Feed v0.1.0" \
  --notes "Initial trusted-user release. Download the Chrome ZIP, extract it, and load the extracted directory from chrome://extensions using Load unpacked."
```

Expected: GitHub creates tag and release `v0.1.0` with exactly the ZIP and
checksum assets.

- [ ] **Step 3: Verify remote commit, release assets, and download URL**

Run:

```bash
test "$(git rev-parse HEAD)" = "$(gh api repos/novus77/Fomo-Live-Feed/branches/main --jq .commit.sha)"
gh release view v0.1.0 --repo novus77/Fomo-Live-Feed --json tagName,isDraft,isPrerelease,assets,url
gh api repos/novus77/Fomo-Live-Feed/releases/tags/v0.1.0 --jq '.assets[].name'
git status --short --branch
```

Expected: local and remote commit hashes match; release is published rather
than draft or prerelease; both expected asset names appear; working tree is
clean and tracks `origin/main`.

- [ ] **Step 4: Report the canonical user path**

Provide both:

```text
Repository → Releases → Latest → Assets → Fomo-Live-Feed-v0.1.0-chrome.zip
https://github.com/novus77/Fomo-Live-Feed/releases/download/v0.1.0/Fomo-Live-Feed-v0.1.0-chrome.zip
```

Also report the release page and local ZIP/checksum paths.
