# Developer Support Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a localized, inline developer-support panel with copyable BSC/Solana addresses and a Telegram-linked technical co-creation group description.

**Architecture:** Keep `SidePanelApp` as the coordinator for one mutually exclusive utility-panel state (`settings`, `support`, or closed), and place all new support presentation and row-local copy feedback in a focused `SupportPanel`. Reuse the existing injected `copyText` and `openLink` boundaries; do not add storage, messaging, service-worker, network, wallet, or permission behavior.

**Tech Stack:** TypeScript 5.9, React 19, typed English/Simplified Chinese catalog, CSS, Vitest, Testing Library, Playwright, WXT.

---

## File Structure

- Create `src/sidepanel/SupportPanel.tsx`: public support constants, address rows, copy feedback, confirmed co-creation content, and Telegram navigation.
- Create `tests/unit/SupportPanel.test.tsx`: focused behavior, content, copy isolation/error, timer cleanup, and navigation tests.
- Modify `src/i18n/catalog.ts`: typed English and Simplified Chinese support strings.
- Modify `tests/unit/i18n-catalog.test.ts`: pin the two user-facing button labels while retaining existing key/placeholder parity coverage.
- Modify `src/sidepanel/SidePanelApp.tsx`: header button, mutually exclusive panel state, and `SupportPanel` composition.
- Modify `tests/unit/SidePanelApp.test.tsx`: header order, toggle, mutual exclusion, diagnostics scoping, and injected dependency wiring.
- Modify `entrypoints/sidepanel/sidepanel.css`: dark/light Support button, inline panel, address row, benefit card, feedback, wrapping, and focus styles.
- Modify `tests/unit/sidepanel-composition-boundary.test.ts`: CSS contract for Support selectors and minimum-width wrapping.
- Modify `tests/e2e/live-feed.spec.ts`: real Side Panel smoke coverage for order, mutual exclusion, copy controls, locale switching, and Telegram link.

No settings schema, service-worker, protocol, manifest, host-permission, or database file changes are permitted by this plan.

### Task 1: Add the typed support catalog

**Files:**
- Modify: `src/i18n/catalog.ts`
- Modify: `tests/unit/i18n-catalog.test.ts`

- [ ] **Step 1: Write failing label assertions**

Add this test beside the existing `translate` tests:

```ts
it('localizes the developer support entry', () => {
  expect(translate('en', 'header.support')).toBe('Support');
  expect(translate('zh-CN', 'header.support')).toBe('打赏');
  expect(translate('en', 'support.groupTitle')).toBe(
    'Developer Co-creation Group',
  );
  expect(translate('zh-CN', 'support.groupTitle')).toBe('开发共创小群');
});
```

- [ ] **Step 2: Run the catalog test and verify RED**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/i18n-catalog.test.ts
```

Expected: TypeScript/Vitest fails because `header.support` and
`support.groupTitle` are not `MessageKey` values.

- [ ] **Step 3: Add the complete English catalog entries**

Add these entries to `EN_MESSAGES`, keeping them grouped under Header and a
new Developer support section:

```ts
'header.support': 'Support',

'support.title': 'Support the Developer',
'support.thanks':
  'Thank you for your support. Your sponsorship helps me maintain and improve the extension.',
'support.bscAddress': 'BSC sponsorship address',
'support.solanaAddress': 'Solana sponsorship address',
'support.copyAddress': 'Copy {chain} address',
'support.copied': 'Copied',
'support.copyFailed': 'Copy failed',
'support.groupTitle': 'Developer Co-creation Group',
'support.groupEligibilityBeforeLink':
  'For a single sponsorship worth more than $100, send the transfer address and transaction hash to ',
'support.groupEligibilityAfterLink':
  '. After confirmation, I will invite you to the technical development group.',
'support.sponsorshipPurpose':
  'Sponsorships support ongoing extension maintenance and future development.',
'support.groupBenefitsIntro': 'In the group, you can:',
'support.optimizationTitle': 'Join extension optimization discussions',
'support.optimizationBody':
  'Suggest features and take part in voting. Requests with broader user support will be prioritized for future updates after feasibility and development cost are considered.',
'support.customizationTitle': 'Discuss shared customization needs',
'support.customizationBody':
  'When a request is broadly useful and needed by many users, I will evaluate developing it as an extension feature.',
'support.earlyAccessTitle': 'Get early access to new extensions',
'support.earlyAccessBody':
  'You may get early access to other extensions and preview versions I build, and help improve them through feedback.',
```

The eligibility sentence is split only around the Telegram anchor. Do not
render catalog text through HTML or `dangerouslySetInnerHTML`.

- [ ] **Step 4: Add the complete Simplified Chinese catalog entries**

Add the exact corresponding keys to `ZH_MESSAGES`:

```ts
'header.support': '打赏',

'support.title': '支持开发者',
'support.thanks': '感谢老板支持，你的赞助会帮助我维护和改进插件。',
'support.bscAddress': 'BSC 赞助地址',
'support.solanaAddress': 'Solana 赞助地址',
'support.copyAddress': '复制{chain}地址',
'support.copied': '已复制',
'support.copyFailed': '复制失败',
'support.groupTitle': '开发共创小群',
'support.groupEligibilityBeforeLink':
  '单笔赞助价值超过 $100，请将转账地址和交易哈希私信 ',
'support.groupEligibilityAfterLink':
  '。确认后，我会邀请你加入技术开发小群。',
'support.sponsorshipPurpose':
  '大家的赞助将用于支持插件的持续维护和后续开发。',
'support.groupBenefitsIntro': '加入小群后，你可以：',
'support.optimizationTitle': '参与插件优化讨论',
'support.optimizationBody':
  '提出功能建议并参与投票。获得较多用户支持的需求，我会结合可行性和开发成本，优先纳入后续更新计划。',
'support.customizationTitle': '讨论共性定制需求',
'support.customizationBody':
  '如果某项需求具有较高的普遍性，并且有较多用户需要，我会评估将其开发为插件功能。',
'support.earlyAccessTitle': '优先体验新插件',
'support.earlyAccessBody':
  '有机会优先体验我后续开发的其他插件和早期版本，并参与反馈与改进。',
```

- [ ] **Step 5: Run the catalog test and verify GREEN**

Run the Task 1 command. Expected: all catalog tests pass, including equal key
sets, non-empty messages, and equal placeholder names (`chain`) in both locales.

### Task 2: Build `SupportPanel` with isolated copy feedback

**Files:**
- Create: `src/sidepanel/SupportPanel.tsx`
- Create: `tests/unit/SupportPanel.test.tsx`

- [ ] **Step 1: Write failing content and navigation tests**

Create `tests/unit/SupportPanel.test.tsx` with the same `useLocale` mock pattern
as `CopyableAddress.test.tsx`, then add:

```tsx
it('renders complete addresses and the confirmed bounded benefits', () => {
  render(<SupportPanel copyText={vi.fn()} openLink={vi.fn()} />);

  expect(screen.getByText(BSC_SUPPORT_ADDRESS)).not.toHaveTextContent('…');
  expect(screen.getByText(SOLANA_SUPPORT_ADDRESS)).not.toHaveTextContent('…');
  expect(screen.getByRole('heading', { name: 'Developer Co-creation Group' }))
    .toBeInTheDocument();
  expect(screen.getByText('Join extension optimization discussions'))
    .toBeInTheDocument();
  expect(screen.getByText('Discuss shared customization needs'))
    .toBeInTheDocument();
  expect(screen.getByText('Get early access to new extensions'))
    .toBeInTheDocument();
});

it('opens the fixed Telegram URL through the injected boundary', () => {
  const openLink = vi.fn();
  render(<SupportPanel copyText={vi.fn()} openLink={openLink} />);

  fireEvent.click(screen.getByRole('link', { name: '@XXten177' }));
  expect(openLink).toHaveBeenCalledWith(new URL('https://t.me/XXten177'));
});
```

- [ ] **Step 2: Write failing row-isolation and failure tests**

Add tests that select buttons by their chain-specific accessible names:

```tsx
it('copies each address and keeps feedback scoped to that row', async () => {
  const copyText = vi.fn().mockResolvedValue(undefined);
  render(<SupportPanel copyText={copyText} openLink={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: 'Copy BSC address' }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(BSC_SUPPORT_ADDRESS));
  expect(screen.getAllByRole('status')).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: 'Copy Solana address' }));
  await waitFor(() => expect(copyText).toHaveBeenLastCalledWith(SOLANA_SUPPORT_ADDRESS));
  expect(screen.getAllByRole('status')).toHaveLength(2);
});

it('keeps the address selectable and reports clipboard failure', async () => {
  const copyText = vi.fn().mockRejectedValue(new Error('denied'));
  render(<SupportPanel copyText={copyText} openLink={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: 'Copy BSC address' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Copy failed');
  expect(screen.getByText(BSC_SUPPORT_ADDRESS)).toBeInTheDocument();
});
```

Also use fake timers to assert feedback clears after 2,000 ms and that
unmounting clears pending timers, matching the lifecycle guarantees already
covered for `CopyableAddress`.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/SupportPanel.test.tsx
```

Expected: FAIL because `SupportPanel.tsx` and its exports do not exist.

- [ ] **Step 4: Implement the focused component**

Create the component with these fixed constants and types:

```tsx
import { useEffect, useRef, useState } from 'react';

import { useLocale } from '../i18n/LocaleProvider';

export const BSC_SUPPORT_ADDRESS =
  '0x373709fdbdcf272cba93164c7d0e3b87b88a1b02';
export const SOLANA_SUPPORT_ADDRESS =
  '4NrMQRjLde48FSm52UDdn2EgAvd1z7TraXpX1S44L9rj';
const TELEGRAM_URL = new URL('https://t.me/XXten177');
const FEEDBACK_DURATION_MS = 2_000;

export interface SupportPanelProps {
  copyText(text: string): Promise<void>;
  openLink(url: URL): void;
}

interface SupportAddressRowProps {
  chain: 'BSC' | 'Solana';
  address: string;
  copyText(text: string): Promise<void>;
}

type CopyResult = 'idle' | 'copied' | 'failed';
```

Implement `SupportAddressRow` with one `CopyResult`, generation counter,
mounted ref, and reset timer per mounted row. Its button calls
`copyText(address)`, announces success with `role="status"`, announces failure
with `role="alert"`, and always leaves the address in selectable text:

```tsx
function SupportAddressRow({ chain, address, copyText }: SupportAddressRowProps) {
  const { translate } = useLocale();
  const [result, setResult] = useState<CopyResult>('idle');
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => {
    mountedRef.current = false;
    generationRef.current += 1;
    clearTimeout(timerRef.current);
  }, []);

  const copy = async (): Promise<void> => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    clearTimeout(timerRef.current);
    setResult('idle');

    try {
      await copyText(address);
      if (mountedRef.current && generationRef.current === generation) {
        setResult('copied');
        timerRef.current = setTimeout(() => {
          if (mountedRef.current && generationRef.current === generation) {
            setResult('idle');
          }
        }, FEEDBACK_DURATION_MS);
      }
    } catch {
      if (mountedRef.current && generationRef.current === generation) {
        setResult('failed');
        timerRef.current = setTimeout(() => {
          if (mountedRef.current && generationRef.current === generation) {
            setResult('idle');
          }
        }, FEEDBACK_DURATION_MS);
      }
    }
  };

  return (
    <div className="support-address-row">
      <div className="support-address-header">
        <strong className={`support-chain support-chain-${chain.toLowerCase()}`}>
          {chain}
        </strong>
        <button
          type="button"
          className="support-copy-button"
          aria-label={translate('support.copyAddress', { chain })}
          onClick={() => void copy()}
        >
          {result === 'copied' ? translate('support.copied') : '⧉'}
        </button>
      </div>
      <span className="support-address-value">{address}</span>
      {result === 'copied' && <span role="status" className="support-copy-feedback">{translate('support.copied')}</span>}
      {result === 'failed' && <span role="alert" className="support-copy-feedback support-copy-feedback-error">{translate('support.copyFailed')}</span>}
    </div>
  );
}
```

Render the public panel as a labeled `<section className="support-panel">`,
two `SupportAddressRow` instances, and a bordered
`<section className="support-group-card">`. Compose the eligibility sentence
as React text + an anchor; intercept its click so navigation stays injectable:

```tsx
<p className="support-group-eligibility">
  {translate('support.groupEligibilityBeforeLink')}
  <a
    href={TELEGRAM_URL.href}
    onClick={(event) => {
      event.preventDefault();
      openLink(TELEGRAM_URL);
    }}
  >
    @XXten177
  </a>
  {translate('support.groupEligibilityAfterLink')}
</p>
```

Render the three benefits as `<li>` elements, each containing a `<strong>`
title and a `<p>` description from the catalog. Use local inline SVG markup
for decorative copy/group icons; do not add an icon dependency.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Task 2 command. Expected: all `SupportPanel` tests pass with no timer
leaks or React act warnings.

### Task 3: Integrate a mutually exclusive utility panel state

**Files:**
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `tests/unit/SidePanelApp.test.tsx`

- [ ] **Step 1: Replace the obsolete two-button expectation with a failing order test**

Change the existing header test to assert the three accessible buttons in
DOM order:

```tsx
const header = container.querySelector('.sidepanel-header');
expect(header).not.toBeNull();
const buttons = within(header as HTMLElement).getAllByRole('button');
expect(buttons).toHaveLength(3);
expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
  'Refresh. Ready',
  'Settings',
  'Support',
]);
```

Keep the existing theme assertion in a separate test so header-order failures
do not obscure Settings behavior.

- [ ] **Step 2: Add failing toggle, mutual-exclusion, and dependency tests**

Add tests with these concrete assertions:

```tsx
it('keeps Settings and Support mutually exclusive', async () => {
  const harness = createHarness(connectedVerdict);
  render(<SidePanelApp deps={harness.deps} />);
  await waitFor(() => expect(connectionStatus()).toHaveTextContent('Connected'));

  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(screen.getByRole('region', { name: 'Settings' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Support' }));
  expect(screen.queryByRole('region', { name: 'Settings' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Support the Developer' }))
    .toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Support' }));
  expect(screen.queryByRole('region', { name: 'Support the Developer' }))
    .not.toBeInTheDocument();
});

it('uses the injected copy and navigation boundaries', async () => {
  const harness = createHarness(connectedVerdict);
  const copyText = vi.fn().mockResolvedValue(undefined);
  harness.deps.copyText = copyText;
  render(<SidePanelApp deps={harness.deps} />);
  await waitFor(() => expect(connectionStatus()).toHaveTextContent('Connected'));

  fireEvent.click(screen.getByRole('button', { name: 'Support' }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy BSC address' }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(BSC_SUPPORT_ADDRESS));
  fireEvent.click(screen.getByRole('link', { name: '@XXten177' }));
  expect(harness.opened.at(-1)?.href).toBe('https://t.me/XXten177');
});
```

Use the harness's existing connected response inline or extract one local
`connectedVerdict` constant. Extend the Settings test to verify diagnostics
disappear when Support replaces Settings.

- [ ] **Step 3: Run the focused Side Panel test and verify RED**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/SidePanelApp.test.tsx
```

Expected: FAIL because the Support button/panel and mutually exclusive state
do not exist.

- [ ] **Step 4: Implement the state and header composition**

Import `SupportPanel`, add the discriminator, and replace `showSettings`:

```tsx
type OpenUtilityPanel = 'settings' | 'support' | null;

const [openUtilityPanel, setOpenUtilityPanel] =
  useState<OpenUtilityPanel>(null);

const toggleUtilityPanel = (panel: Exclude<OpenUtilityPanel, null>): void => {
  setOpenUtilityPanel((current) => current === panel ? null : panel);
};
```

Update the diagnostics refresh effect to use
`openUtilityPanel === 'settings'`. Keep the existing `now()` update behavior.

Render the Support button after Settings:

```tsx
<button
  type="button"
  className="sidepanel-support-toggle"
  aria-label={translate('header.support')}
  title={translate('header.support')}
  aria-expanded={openUtilityPanel === 'support'}
  onClick={() => toggleUtilityPanel('support')}
>
  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
    <path fill="currentColor" d="M12 21s-7-4.35-9.33-8.28C.66 9.33 2.27 5 6.4 5c2.02 0 3.16 1.13 3.6 1.72C10.44 6.13 11.58 5 13.6 5c4.13 0 5.74 4.33 3.73 7.72C15 16.65 12 21 12 21Z" />
  </svg>
  <span>{translate('header.support')}</span>
</button>
```

Change Settings toggle behavior and state attributes to the discriminator,
then replace the bottom conditional composition with:

```tsx
{openUtilityPanel === 'settings' && (
  <>
    <SettingsPanel
      settings={settings}
      onOpinionTranslationChange={updateOpinionTranslation}
      onThemeChange={updateTheme}
    />
    {pipelineHealth !== undefined && (
      <PipelineDiagnostics health={pipelineHealth} now={() => diagnosticsNow} />
    )}
  </>
)}

{openUtilityPanel === 'support' && (
  <SupportPanel copyText={copyText} openLink={openLink} />
)}
```

- [ ] **Step 5: Run focused integration tests and verify GREEN**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/SupportPanel.test.tsx tests/unit/SidePanelApp.test.tsx
```

Expected: both files pass, including header order and mutual exclusion.

### Task 4: Style both themes and lock the narrow-width contract

**Files:**
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Modify: `tests/unit/sidepanel-composition-boundary.test.ts`

- [ ] **Step 1: Write a failing CSS contract test**

Add a second test that reads `entrypoints/sidepanel/sidepanel.css` and asserts
the focused contract:

```ts
it('styles the support panel in both themes without truncating addresses', () => {
  const css = readFileSync('entrypoints/sidepanel/sidepanel.css', 'utf8');

  expect(css).toContain('.sidepanel-support-toggle');
  expect(css).toContain('.support-panel');
  expect(css).toContain('.support-group-card');
  expect(css).toContain("[data-theme='light'] .support-panel");
  expect(css).toMatch(/\.support-address-value\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  expect(css).not.toMatch(/\.support-address-value\s*\{[^}]*text-overflow:\s*ellipsis/s);
});
```

- [ ] **Step 2: Run the boundary test and verify RED**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/sidepanel-composition-boundary.test.ts
```

Expected: FAIL because the support selectors do not exist.

- [ ] **Step 3: Add dark-theme and layout styles**

Add focused selectors using the existing palette:

```css
.sidepanel-support-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 9px;
  color: #ffffff;
  background: #4c1d95;
  border: 1px solid #7c3aed;
  border-radius: 6px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.sidepanel-support-toggle:hover { background: #5b21b6; }
.sidepanel-support-toggle:focus-visible,
.support-copy-button:focus-visible,
.support-group-card a:focus-visible {
  outline: 2px solid #a78bfa;
  outline-offset: 2px;
}

.support-panel {
  margin: 8px 12px 12px;
  padding: 14px;
  color: #e2e8f0;
  background: #111c31;
  border: 1px solid #334155;
  border-radius: 10px;
}

.support-title { margin: 0; font-size: 15px; }
.support-thanks,
.support-group-eligibility,
.support-purpose,
.support-benefit p { color: #aebbd0; line-height: 1.55; }

.support-address-list { display: grid; gap: 8px; margin-top: 12px; }
.support-address-row {
  padding: 10px;
  background: #0b1220;
  border: 1px solid #273449;
  border-radius: 8px;
}
.support-address-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.support-address-value {
  display: block;
  margin-top: 7px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  user-select: text;
}
.support-copy-button {
  min-width: 32px;
  min-height: 28px;
  padding: 4px 8px;
  color: #ddd6fe;
  background: #2e1f53;
  border: 1px solid #6d4bc0;
  border-radius: 6px;
  font: inherit;
  cursor: pointer;
}
.support-copy-feedback { display: block; margin-top: 5px; font-size: 11px; color: #c4b5fd; }
.support-copy-feedback-error { color: #f87171; }

.support-group-card {
  margin-top: 13px;
  padding: 11px;
  background: #2e1f53;
  border: 1px solid #7c3aed;
  border-radius: 9px;
}
.support-benefits { margin: 8px 0 0; padding-left: 19px; }
.support-benefit + .support-benefit { margin-top: 8px; }
.support-benefit strong { color: #ede9fe; }
.support-benefit p { margin: 3px 0 0; }
.support-group-card a { color: #c4b5fd; font-weight: 600; }
```

- [ ] **Step 4: Add explicit light-theme overrides**

Add root-scoped light selectors:

```css
.sidepanel-root[data-theme='light'] .sidepanel-support-toggle {
  color: #ffffff;
  background: #6d28d9;
  border-color: #7c3aed;
}
.sidepanel-root[data-theme='light'] .support-panel {
  color: #172033;
  background: #ffffff;
  border-color: #d7dee9;
}
.sidepanel-root[data-theme='light'] .support-address-row {
  background: #f8fafc;
  border-color: #d7dee9;
}
.sidepanel-root[data-theme='light'] .support-thanks,
.sidepanel-root[data-theme='light'] .support-group-eligibility,
.sidepanel-root[data-theme='light'] .support-purpose,
.sidepanel-root[data-theme='light'] .support-benefit p {
  color: #526176;
}
.sidepanel-root[data-theme='light'] .support-group-card {
  background: #f4f0ff;
  border-color: #8b5cf6;
}
.sidepanel-root[data-theme='light'] .support-benefit strong {
  color: #4c1d95;
}
.sidepanel-root[data-theme='light'] .support-group-card a {
  color: #6d28d9;
}
```

- [ ] **Step 5: Run component and CSS tests**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/SupportPanel.test.tsx tests/unit/SidePanelApp.test.tsx tests/unit/sidepanel-composition-boundary.test.ts
```

Expected: all focused UI and CSS-contract tests pass.

### Task 5: Add real Side Panel smoke coverage and run release gates

**Files:**
- Modify: `tests/e2e/live-feed.spec.ts`

- [ ] **Step 1: Extend the existing Side Panel theme scenario**

In the scenario that already opens Settings and toggles light/dark themes,
add assertions before changing theme:

```ts
const headerButtons = await panel.evaluate<number>(
  "document.querySelectorAll('.sidepanel-header-controls button').length",
);
expect(headerButtons).toBe(3);
expect(await panel.hasText('Support')).toBe(true);

await panel.click('.sidepanel-support-toggle');
await expect.poll(async () => panel.exists('.support-panel')).toBe(true);
await expect.poll(async () => panel.exists('.settings-panel')).toBe(false);
expect(
  await panel.hasText('0x373709fdbdcf272cba93164c7d0e3b87b88a1b02'),
).toBe(true);
expect(
  await panel.hasText('4NrMQRjLde48FSm52UDdn2EgAvd1z7TraXpX1S44L9rj'),
).toBe(true);

await panel.click('[data-testid="settings-toggle"]');
await expect.poll(async () => panel.exists('.support-panel')).toBe(false);
await expect.poll(async () => panel.exists('.settings-panel')).toBe(true);
```

Keep Telegram URL verification in the unit test rather than opening an
external browser target from E2E.

- [ ] **Step 2: Run static type checking**

Run:

```bash
CI=true corepack pnpm typecheck
```

Expected: exit code 0 with no TypeScript diagnostics.

- [ ] **Step 3: Run the full unit/integration suite**

Run:

```bash
CI=true corepack pnpm test
```

Expected: all Vitest suites pass; there are no timer leaks, unhandled promise
rejections, or React act warnings introduced by `SupportPanel`.

- [ ] **Step 4: Run the production build gate**

Run:

```bash
CI=true corepack pnpm build
```

Expected: WXT produces `.output/chrome-mv3` successfully and the manifest adds
no new permission or host permission.

- [ ] **Step 5: Run Side Panel E2E**

Run:

```bash
CI=true corepack pnpm test:e2e
```

Expected: the existing E2E suite passes, including Support/Settings mutual
exclusion and both complete addresses.

- [ ] **Step 6: Review the final diff against the design boundaries**

Run:

```bash
git diff --check
git status --short
git diff -- src/i18n/catalog.ts src/sidepanel/SupportPanel.tsx src/sidepanel/SidePanelApp.tsx entrypoints/sidepanel/sidepanel.css tests/unit/i18n-catalog.test.ts tests/unit/SupportPanel.test.tsx tests/unit/SidePanelApp.test.tsx tests/unit/sidepanel-composition-boundary.test.ts tests/e2e/live-feed.spec.ts
```

Expected: no whitespace errors; only the planned UI, catalog, and test files
change; no wallet API, network call, permission, storage schema, service-worker,
or protocol change appears.

## Git Handling

Do not create commits unless the user explicitly requests them. If commit
authorization is later given, prefer small commits aligned with Tasks 1-4 and
one final verification/E2E commit; use English commit messages.
