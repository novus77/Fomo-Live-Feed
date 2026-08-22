# Local Distribution Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a verified Chrome release ZIP that trusted users can extract and load directly, with an offline Chinese quick-start guide and no development prerequisites.

**Architecture:** A dependency-free Node ESM script validates WXT output, stages only the production extension plus a generated guide, creates a root-layout ZIP with the system `zip` command, and writes a SHA-256 checksum. Pure guide, naming, manifest, and banned-path functions are exported for Vitest; `package.json` composes the existing release gate with the packaging script.

**Tech Stack:** Node.js built-ins, ESM, TypeScript declarations, Info-ZIP, SHA-256, WXT, Vitest.

---

## File Structure

- Create `scripts/package-local.mjs`: pure validation/rendering helpers and the executable staging/archive pipeline.
- Create `scripts/package-local.d.mts`: strict TypeScript declarations for helpers imported by tests.
- Create `tests/unit/package-local.test.ts`: guide, naming, manifest, banned-path, artifact, and checksum tests.
- Modify `package.json`: add `package:local` and `package:local:artifact` commands.
- Modify `README.md`: replace developer-oriented distribution guidance with a short recipient-install section and artifact location.
- Modify `docs/manual-testing.zh-CN.md`: remove obsolete worktree paths/header expectations and add a release-ZIP smoke test.

### Task 1: Define and test release metadata, guide, and validation helpers

**Files:**
- Create: `scripts/package-local.mjs`
- Create: `scripts/package-local.d.mts`
- Create: `tests/unit/package-local.test.ts`

- [ ] **Step 1: Write failing guide and naming tests**

Create `tests/unit/package-local.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  artifactName,
  assertAllowedRelativePaths,
  parseManifest,
  renderGuide,
  sha256File,
} from '../../scripts/package-local.mjs';

describe('local release packaging', () => {
  it('uses the package version in the Chrome artifact name', () => {
    expect(artifactName('0.1.0')).toBe('Fomo-Live-Feed-v0.1.0-chrome.zip');
  });

  it('renders an offline recipient guide without developer prerequisites', () => {
    const guide = renderGuide({
      version: '0.1.0',
      builtAt: '2026-08-22T12:00:00.000Z',
    });

    expect(guide).toContain('chrome://extensions');
    expect(guide).toContain('加载已解压的扩展程序');
    expect(guide).toContain('https://fomo.family/');
    expect(guide).toContain('DexScreener');
    expect(guide).toContain('GMGN');
    expect(guide).toContain('刷新一次 Fomo 页面');
    expect(guide).toContain('Chrome 138');
    expect(guide).toContain('不连接钱包');
    expect(guide).toContain('0.1.0');
    expect(guide).toContain('2026-08-22T12:00:00.000Z');
    expect(guide).not.toMatch(/Node\.js|pnpm|git clone|\/Users\//);
    expect(guide).not.toMatch(/<script|https?:\/\/[^<]*\.(?:js|css)/i);
  });
});
```

- [ ] **Step 2: Write failing manifest, banned-path, and checksum tests**

Append:

```ts
it('accepts only a manifest matching the package version', () => {
  expect(parseManifest('{"manifest_version":3,"version":"0.1.0"}', '0.1.0'))
    .toMatchObject({ manifest_version: 3, version: '0.1.0' });
  expect(() => parseManifest('{"manifest_version":3,"version":"0.1.1"}', '0.1.0'))
    .toThrow('manifest version 0.1.1 does not match package version 0.1.0');
  expect(() => parseManifest('not json', '0.1.0')).toThrow('invalid manifest.json');
});

it('rejects development paths from release staging', () => {
  expect(() => assertAllowedRelativePaths(['manifest.json', 'icons/icon-16.png']))
    .not.toThrow();
  for (const path of [
    'node_modules/react/index.js',
    '.git/config',
    '.pnpm-store/index.json',
    '.output/chrome-mv3/manifest.json',
    'tests/unit/smoke.test.ts',
    'src/background.ts',
    '.env',
  ]) {
    expect(() => assertAllowedRelativePaths(['manifest.json', path])).toThrow(path);
  }
});

it('writes a standard SHA-256 digest for an artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fomo-package-test-'));
  const artifact = join(directory, 'release.zip');
  await writeFile(artifact, 'release-bytes');

  const digest = await sha256File(artifact);
  expect(digest).toBe(createHash('sha256').update('release-bytes').digest('hex'));
});
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/package-local.test.ts
```

Expected: FAIL because `scripts/package-local.mjs` does not exist.

- [ ] **Step 4: Implement exported helpers**

Create `scripts/package-local.mjs` with Node built-ins and these exports:

```js
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const artifactName = (version) =>
  `Fomo-Live-Feed-v${version}-chrome.zip`;

export const parseManifest = (source, expectedVersion) => {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error('invalid manifest.json');
  }
  if (manifest?.manifest_version !== 3 || typeof manifest.version !== 'string') {
    throw new Error('manifest.json must describe a versioned Manifest V3 extension');
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `manifest version ${manifest.version} does not match package version ${expectedVersion}`,
    );
  }
  return manifest;
};

const BANNED_SEGMENTS = new Set([
  'node_modules', '.git', '.pnpm-store', '.output', 'tests', 'src', '.wxt',
]);

export const assertAllowedRelativePaths = (paths) => {
  for (const path of paths) {
    const segments = path.split('/');
    if (
      segments.some((segment) => BANNED_SEGMENTS.has(segment)) ||
      segments.some((segment) => segment === '.env' || segment.startsWith('.env.'))
    ) {
      throw new Error(`banned release path: ${path}`);
    }
  }
};

export const sha256File = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
```

Implement `renderGuide({ version, builtAt })` as a complete standalone HTML
document. It must contain the exact tested phrases, four numbered install
steps, post-install startup, update steps, troubleshooting, supported sites,
privacy boundaries, and embedded responsive CSS. Escape `version` and
`builtAt` before interpolation with a local `escapeHtml` helper.

- [ ] **Step 5: Add strict declarations**

Create `scripts/package-local.d.mts`:

```ts
export interface GuideMetadata {
  version: string;
  builtAt: string;
}

export function artifactName(version: string): string;
export function renderGuide(metadata: GuideMetadata): string;
export function parseManifest(
  source: string,
  expectedVersion: string,
): { manifest_version: 3; version: string; [key: string]: unknown };
export function assertAllowedRelativePaths(paths: readonly string[]): void;
export function sha256File(path: string): Promise<string>;
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Task 1 command. Expected: all packaging-helper tests pass.

### Task 2: Implement atomic staging, ZIP creation, and checksum output

**Files:**
- Modify: `scripts/package-local.mjs`
- Modify: `scripts/package-local.d.mts`
- Modify: `tests/unit/package-local.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write a failing end-to-end packaging test**

Add `packageLocalRelease` to the test import and declaration, then add:

```ts
it('creates a root-layout ZIP, guide, and matching checksum', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fomo-local-release-'));
  const output = join(root, '.output', 'chrome-mv3');
  await mkdir(join(output, 'icons'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fomo-live-feed', version: '0.1.0' }),
  );
  await writeFile(
    join(output, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, version: '0.1.0' }),
  );
  await writeFile(join(output, 'sidepanel.html'), '<!doctype html>');
  await writeFile(join(output, 'background.js'), 'export {};');
  await writeFile(join(output, 'icons', 'icon-16.png'), 'icon');

  const result = await packageLocalRelease({
    projectRoot: root,
    builtAt: '2026-08-22T12:00:00.000Z',
  });

  expect(result.artifactPath).toBe(
    join(root, '.output', 'releases', 'Fomo-Live-Feed-v0.1.0-chrome.zip'),
  );
  const entries = execFileSync('unzip', ['-Z1', result.artifactPath], {
    encoding: 'utf8',
  }).trim().split('\n');
  expect(entries).toContain('manifest.json');
  expect(entries).toContain('START-HERE.html');
  expect(entries).not.toContain('chrome-mv3/manifest.json');
  expect(await readFile(result.checksumPath, 'utf8')).toBe(
    `${await sha256File(result.artifactPath)}  Fomo-Live-Feed-v0.1.0-chrome.zip\n`,
  );
});
```

Update test imports with `execFileSync`, `mkdir`, and `packageLocalRelease`.

- [ ] **Step 2: Run the focused test and verify RED**

Run the Task 1 command. Expected: FAIL because `packageLocalRelease` is not
exported.

- [ ] **Step 3: Implement the packaging pipeline**

Add these constants and behavior to `scripts/package-local.mjs`:

```js
import { execFile } from 'node:child_process';
import {
  cp, mkdir, readFile, readdir, rename, rm, writeFile,
} from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REQUIRED_OUTPUTS = ['manifest.json', 'sidepanel.html', 'background.js'];

const listRelativeFiles = async (root, current = root) => {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listRelativeFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
  }
  return files.sort();
};
```

Export `packageLocalRelease({ projectRoot, builtAt = new Date().toISOString() })`.
It reads `package.json`, validates the package version, validates WXT's
manifest, checks all `REQUIRED_OUTPUTS`, removes only
`.output/local-release`, copies `.output/chrome-mv3/.` into staging, writes
`START-HERE.html`, validates staged paths, writes a temporary ZIP under
`.output/releases`, executes `zip -q -r <temp> .` with `cwd: staging`, checks
archive entries using `unzip -Z1`, computes the digest, atomically renames the
ZIP, and writes `<artifact>.sha256`.

Use this final guard so importing the module in Vitest never packages:

```js
const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  fileURLToPath(import.meta.url) === invokedPath
) {
  packageLocalRelease({ projectRoot: process.cwd() })
    .then(({ artifactPath, checksumPath }) => {
      console.log(`Release ZIP: ${artifactPath}`);
      console.log(`SHA-256: ${checksumPath}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
```

- [ ] **Step 4: Add package scripts**

Add:

```json
"package:local": "tsc --noEmit && vitest run && wxt build && node scripts/package-local.mjs",
"package:local:artifact": "node scripts/package-local.mjs"
```

Do not invoke `pnpm` recursively from an npm script. Each executable resolves
from the lifecycle `PATH`; recipients never run these commands.

- [ ] **Step 5: Run focused tests and a real package build**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/package-local.test.ts
corepack pnpm package:local
```

Expected: tests pass; the command prints absolute ZIP/checksum paths under
`.output/releases/`; `unzip -Z1` lists `manifest.json` and `START-HERE.html` at
archive root.

### Task 3: Replace developer-only handoff instructions and run release gates

**Files:**
- Modify: `README.md`
- Modify: `docs/manual-testing.zh-CN.md`
- Test: `tests/unit/package-local.test.ts`

- [ ] **Step 1: Add failing documentation contract assertions**

Append:

```ts
it('keeps recipient installation independent from the development checkout', async () => {
  const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8');
  const manual = await readFile(
    join(process.cwd(), 'docs', 'manual-testing.zh-CN.md'),
    'utf8',
  );

  expect(readme).toContain('Fomo-Live-Feed-v<version>-chrome.zip');
  expect(readme).toContain('Load unpacked');
  expect(manual).toContain('package:local');
  expect(manual).not.toContain('.worktrees/codex-fomo-live-feed');
  expect(manual).not.toContain('右上角只有“刷新”和“设置”两个图标按钮');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run the Task 1 command. Expected: FAIL on stale documentation.

- [ ] **Step 3: Update recipient and release documentation**

In `README.md`, add a **Trusted-user installation** section before Quick start:

```markdown
## Trusted-user installation

Recipients do not need this repository, Node.js, or pnpm. Download
`Fomo-Live-Feed-v<version>-chrome.zip`, extract it, open
`chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and
select the extracted directory. Open `START-HERE.html` in that directory for the
startup and troubleshooting checklist.

Maintainers create the artifact with `corepack pnpm package:local`; output is
written under `.output/releases/` with a neighboring SHA-256 checksum.
```

In `docs/manual-testing.zh-CN.md`:

- Change the header expectation to Refresh, Settings, Support.
- Replace the obsolete `.worktrees/codex-fomo-live-feed` path and branch
  expectation with the current repository root/branch-independent wording.
- Add a **本地分发包验收** section containing the packaging command, checksum
  verification, temporary extraction, root-manifest check, Chrome Load
  unpacked smoke test, Support panel check, and post-install Fomo refresh.
- Preserve existing authenticated Fomo and real-event test cases.

- [ ] **Step 4: Run focused and full release gates**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/package-local.test.ts
CI=true corepack pnpm check
CI=true corepack pnpm test:e2e
corepack pnpm package:local
```

Expected: every command exits 0; Vitest includes the package tests; E2E passes;
the final ZIP and checksum are regenerated from the verified production build.

- [ ] **Step 5: Inspect the final distributable**

Run:

```bash
unzip -Z1 .output/releases/Fomo-Live-Feed-v0.1.0-chrome.zip
cd .output/releases
shasum -a 256 -c Fomo-Live-Feed-v0.1.0-chrome.zip.sha256
```

Expected: `manifest.json` is at archive root; `START-HERE.html` is present; no
development path is listed; checksum reports `OK`.

## Git Handling

Do not create commits unless the user explicitly requests them. Keep generated
`.output/` release artifacts untracked; commit only the reproducible script,
tests, package command, and documentation when authorized.
