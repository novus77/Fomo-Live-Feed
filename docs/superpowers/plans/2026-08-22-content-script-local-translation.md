# Content Script Local Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Chrome built-in opinion translation from the Side Panel to the isolated Fomo content script, so it works on Chrome profiles where the API is unavailable in extension documents.

**Architecture:** The Side Panel owns display state and the bounded translated-result cache. The background service worker only routes strictly validated, correlated requests to an eligible Fomo content script. The content script owns Chrome `Translator`/`LanguageDetector` objects, session creation, model-download progress, and the next-real-gesture retry required after `NotAllowedError`.

**Tech Stack:** WXT, TypeScript, React, Zod, Vitest, Playwright, Chrome MV3 runtime messaging.

---

## File structure

- Create: `src/translation/content-translation-service.ts` — document-context model/session lifecycle.
- Create: `src/translation/content-translation-host.ts` — content-script runtime command host.
- Create: `src/translation/content-translation-client.ts` — Side Panel `BrowserTranslationApi` client.
- Modify: `src/messaging/protocol.ts` — strict command/result/event schemas.
- Modify: `src/messaging/guards.ts` — sender trust classification.
- Modify: `entrypoints/fomo-bridge.content.ts` — install the translation host in the isolated Fomo world.
- Modify: `entrypoints/background.ts` — correlated Fomo tab request router.
- Modify: `src/sidepanel/SidePanelApp.tsx` — use the content client and react to ready/progress/status events.
- Modify: `src/popup/SettingsPanel.tsx`, `src/i18n/catalog.ts` — Fomo-page gesture guidance and localized service states.
- Modify: `src/sidepanel/TranslatedOpinion.tsx` — remove card-local activation action after service-level initialization exists.
- Modify: `docs/manual-testing.zh-CN.md` — update clean-profile testing procedure.
- Test: `tests/unit/content-translation-service.test.ts`.
- Test: `tests/unit/content-translation-client.test.ts`.
- Test: `tests/unit/messaging.test.ts`, `tests/integration/fomo-bridge.test.ts`, `tests/unit/SidePanelApp.test.tsx`, `tests/e2e/live-feed.spec.ts`.

### Task 1: Strict protocol and trusted routing boundary

**Files:**
- Modify: `src/messaging/protocol.ts`
- Modify: `src/messaging/guards.ts`
- Test: `tests/unit/messaging.test.ts`

- [ ] **Step 1: Add failing schema tests for every translation command and event**

```ts
expect(parseExtensionMessage({
  protocolVersion: 1,
  type: 'translation.request',
  payload: { requestId: 'r1', clientId: 'panel-1', command: 'translate', text: 'x'.repeat(2001) },
})).toBeUndefined();

expect(trustClassForMessageType('translation.request')).toBe('privileged-ui-page');
expect(trustClassForMessageType('translation.response')).toBe('fomo-content-script');
```

- [ ] **Step 2: Run the focused tests and confirm the new assertions fail**

Run: `CI=true corepack pnpm vitest run tests/unit/messaging.test.ts`

Expected: FAIL because translation schemas and sender classes do not exist.

- [ ] **Step 3: Define closed schemas and types**

```ts
const translationCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('statusQuery') }).strict(),
  z.object({ command: z.literal('initialize'), sourceLanguage: languageSchema, targetLanguage: languageSchema }).strict(),
  z.object({ command: z.literal('detect'), text: z.string().max(2000) }).strict(),
  z.object({ command: z.literal('availability'), sourceLanguage: languageSchema, targetLanguage: languageSchema }).strict(),
  z.object({ command: z.literal('create'), sourceLanguage: languageSchema, targetLanguage: languageSchema }).strict(),
  z.object({ command: z.literal('translate'), sessionId: idSchema, text: z.string().max(2000) }).strict(),
  z.object({ command: z.literal('destroy'), sessionId: idSchema }).strict(),
]);
```

Use `requestId` and `clientId` on every request. Define only closed result codes from the specification. Route requests only from privileged UI and responses/events only from Fomo content scripts.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `CI=true corepack pnpm vitest run tests/unit/messaging.test.ts && corepack pnpm typecheck`

Expected: PASS.

### Task 2: Build the isolated content translation service

**Files:**
- Create: `src/translation/content-translation-service.ts`
- Test: `tests/unit/content-translation-service.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it('coalesces the same pair and retries it once after a trusted gesture', async () => {
  const service = new ContentTranslationService({ env, onEvent });
  await expect(service.create('en', 'zh')).rejects.toMatchObject({ code: 'activation-required' });
  service.handleTrustedGesture();
  await expect(waitForEvent('ready')).resolves.toMatchObject({ sourceLanguage: 'en', targetLanguage: 'zh' });
  expect(create).toHaveBeenCalledTimes(2);
});
```

Also test: local Chinese/English hints; detector fallback; download progress clamping; unavailable and unsupported mapping; same-pair single-flight; one-session eviction; no text retained in pending activation state; `dispose()` destroys sessions and removes gesture state.

- [ ] **Step 2: Run the new test file and confirm it fails**

Run: `CI=true corepack pnpm vitest run tests/unit/content-translation-service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement one document-context service**

```ts
export class ContentTranslationService {
  async execute(command: TranslationCommand): Promise<TranslationResult> { /* closed command switch */ }
  handleTrustedGesture(): void { /* retry only pair keys recorded after NotAllowedError */ }
  dispose(): void { /* reject pending work and destroy sessions once */ }
}
```

Reuse `inferCommonOpinionLanguage`, `normalizeLanguageTag`, typed error classification, and session-creation single-flight semantics. Do not import `browser`, `chrome`, storage, DOM-query, or background modules.

- [ ] **Step 4: Run focused service tests and typecheck**

Run: `CI=true corepack pnpm vitest run tests/unit/content-translation-service.test.ts tests/unit/local-language-hint.test.ts && corepack pnpm typecheck`

Expected: PASS.

### Task 3: Add the Fomo content-script host and background router

**Files:**
- Create: `src/translation/content-translation-host.ts`
- Modify: `entrypoints/fomo-bridge.content.ts`
- Modify: `entrypoints/background.ts`
- Test: `tests/integration/fomo-bridge.test.ts`

- [ ] **Step 1: Write failing end-to-end runtime-boundary tests**

```ts
await expect(sidePanelClient.translate('hello')).resolves.toBe('你好');
expect(sentToFomo).toMatchObject({ type: 'translation.request' });
expect(diagnostics).not.toContain('hello');

await expect(clientWithoutFomo.translate('hello')).rejects.toMatchObject({ code: 'fomo-tab-required' });
```

Add sender-forgery coverage for page-originated results and verify a late response after a timed-out request cannot resolve a new request.

- [ ] **Step 2: Run integration tests and confirm they fail**

Run: `CI=true corepack pnpm vitest run tests/integration/fomo-bridge.test.ts`

Expected: FAIL because no translation host/router exists.

- [ ] **Step 3: Install the isolated host and implement correlated routing**

```ts
const host = installContentTranslationHost({
  runtime: browser.runtime,
  service: new ContentTranslationService({ env: readBrowserTranslationEnv(), onEvent }),
});

browser.runtime.onMessage.addListener((message, sender) =>
  routeTranslationMessage(message, sender, { findFomoTab, sendToTab, timeoutMs: 15_000 }),
);
```

The host must listen only in the Fomo isolated content script. The router must use allowed Fomo URL patterns, request correlation, a 15-second timeout, and explicit `fomo-tab-required` or `context-disposed` results. It must not add `scripting` permission or use `window.postMessage`.

- [ ] **Step 4: Run focused integration tests and typecheck**

Run: `CI=true corepack pnpm vitest run tests/integration/fomo-bridge.test.ts tests/unit/messaging.test.ts && corepack pnpm typecheck`

Expected: PASS.

### Task 4: Replace the Side Panel adapter and make initialization service-level

**Files:**
- Create: `src/translation/content-translation-client.ts`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `src/popup/SettingsPanel.tsx`
- Modify: `src/sidepanel/TranslatedOpinion.tsx`
- Modify: `src/i18n/catalog.ts`
- Test: `tests/unit/content-translation-client.test.ts`
- Test: `tests/unit/SidePanelApp.test.tsx`
- Test: `tests/unit/SettingsPanel.test.tsx`
- Test: `tests/unit/TranslatedOpinion.test.tsx`

- [ ] **Step 1: Write failing client and UI tests**

```ts
it('turns a ready event into a retry token increment', async () => {
  runtime.emit({ protocolVersion: 1, type: 'translation.ready', payload: { clientId: 'panel-1', sourceLanguage: 'en', targetLanguage: 'zh' } });
  await expect(screen.findByText('[translated] English thesis')).resolves.toBeInTheDocument();
});

it('guides the user to click the Fomo page after activation-required', () => {
  renderPanel({ translationSetup: { status: 'activation-required' } });
  expect(screen.getByText(/click anywhere in the Fomo page/i)).toBeInTheDocument();
});
```

Also test request cancellation on unmount, progress rendering, fomo-tab-required status, and that `TranslatedOpinion` no longer renders a per-card activation action.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run: `CI=true corepack pnpm vitest run tests/unit/content-translation-client.test.ts tests/unit/SidePanelApp.test.tsx tests/unit/SettingsPanel.test.tsx tests/unit/TranslatedOpinion.test.tsx`

Expected: FAIL because the client and new state contract do not exist.

- [ ] **Step 3: Implement the runtime client and UI state mapping**

```ts
export function createContentTranslationClient(runtime: RuntimeLike, clientId: string): BrowserTranslationApi {
  return {
    detect: (text) => request('detect', { text }),
    availability: (sourceLanguage, targetLanguage) => request('availability', { sourceLanguage, targetLanguage }),
    create: async (sourceLanguage, targetLanguage) => createRemoteSession(request, sourceLanguage, targetLanguage),
  };
}
```

Use one client ID per mounted panel. Convert `translation.progress` and `translation.ready` events into setup state and retry-token updates. Keep original text primary on any temporary error. Replace direct Side Panel global feature detection. Remove card-local “Enable local translation” behavior.

- [ ] **Step 4: Run focused UI tests and typecheck**

Run: `CI=true corepack pnpm vitest run tests/unit/content-translation-client.test.ts tests/unit/SidePanelApp.test.tsx tests/unit/SettingsPanel.test.tsx tests/unit/TranslatedOpinion.test.tsx && corepack pnpm typecheck`

Expected: PASS.

### Task 5: Production-contract, E2E, and manual verification

**Files:**
- Modify: `tests/e2e/live-feed.spec.ts`
- Modify: `docs/manual-testing.zh-CN.md`
- Modify: `README.md` only if it still claims Side Panel execution
- Test: `tests/unit/manifest-config.test.ts`

- [ ] **Step 1: Write the failing E2E activation flow**

```ts
await installTranslationDoubleInFomoContentScript(fomoPage, { firstCreate: 'NotAllowedError' });
await emit(fomoPage, thesisPayload(1));
await expect(panel.hasText('Click anywhere in the Fomo page')).resolves.toBe(true);
await fomoPage.mouse.click(40, 40);
await expect(panel.hasText(TRANSLATED_THESIS)).resolves.toBe(true);
```

Assert that no `translate.googleapis.com` or `clients5.google.com` request is made. Assert manifest permissions are exactly `storage` and `sidePanel`.

- [ ] **Step 2: Run E2E and confirm the activation path fails before implementation**

Run: `CI=true corepack pnpm test:e2e`

Expected: FAIL because the current Side Panel adapter cannot observe a Fomo-page gesture.

- [ ] **Step 3: Update test doubles and manual procedure**

Install Translator/LanguageDetector doubles in the Fomo isolated content-script context before the host starts. Update the Chinese manual guide to require a one-time Fomo-page click only when Settings reports activation-required; retain clean-profile, tab-close/reopen, and no-network checks.

- [ ] **Step 4: Run the final verification suite**

Run: `CI=true corepack pnpm check`

Expected: typecheck, all Vitest files, and WXT production build PASS.

Run: `CI=true corepack pnpm test:e2e`

Expected: all Playwright tests PASS.

Run: `git diff --check`

Expected: no output.

### Task 6: Review and handoff

**Files:**
- Review: every modified source/test/document file

- [ ] **Step 1: Inspect generated manifest**

Run: `node -e "const m=require('./.output/chrome-mv3/manifest.json'); console.log(JSON.stringify({permissions:m.permissions,minimumChrome:m.minimum_chrome_version,hosts:m.host_permissions},null,2))"`

Expected: permissions exactly `storage` and `sidePanel`; Chrome minimum remains `138`; no Google translation hosts.

- [ ] **Step 2: Inspect privacy boundary**

Run: `rg -n "translate\.googleapis|clients5\.google|scripting|window\.postMessage" src entrypoints wxt.config.ts`

Expected: no new translation fallback, scripting permission, or MAIN-world translation route.

- [ ] **Step 3: Report implementation and testing results**

Include the Fomo-page first-use gesture requirement, behavior when Fomo is closed, exact verification commands, and remaining browser-version constraints.
