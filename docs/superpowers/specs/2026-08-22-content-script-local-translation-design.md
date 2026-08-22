# Content Script Local Translation Design

**Date:** 2026-08-22

**Status:** Proposed for implementation

## 1. Goal

Make opinion translation work reliably in Chrome 138+ while preserving the product's pure-local privacy boundary. Chrome's built-in `Translator` and `LanguageDetector` APIs will execute in the Fomo page's isolated content-script document context rather than in the extension Side Panel.

The user experience remains automatic after at most one browser-required activation gesture. No opinion text is sent to Google or any other remote translation service.

## 2. Root Cause

The current implementation constructs `createBrowserTranslationApi()` inside the Side Panel extension document. On affected Chrome profiles, `Translator` and `LanguageDetector` are not exposed in that context, so feature detection returns unavailable before model initialization can begin.

The verified reference implementation in `Howe813/j7tracker-zh` executes the built-in APIs from an isolated content script attached to the target website. It also retains language-pair sessions in that document and retries `NotAllowedError` initialization from the next real page gesture.

## 3. Scope

### In scope

- Move built-in translation execution to the existing Fomo isolated content script.
- Route bounded translation commands between Side Panel, background, and the selected Fomo tab.
- Reuse translator sessions by language pair.
- Detect obvious English and Chinese locally before using `LanguageDetector`.
- Support the browser-required first-use gesture on the Fomo page.
- Report initialization, download, ready, unavailable, unsupported, and failure states.
- Automatically retry visible opinions after initialization succeeds.
- Preserve original/translated text switching in history cards.
- Add unit, integration, extension E2E, and manual test coverage.

### Out of scope

- Google Translate or any remote translation fallback.
- Translation while every Fomo tab is closed.
- Translation persistence in IndexedDB or `chrome.storage`.
- MAIN-world injection or the `scripting` permission.
- Translation of toast notifications or extension UI strings.
- Background service-worker model execution.

## 4. Product Behavior

### 4.1 Normal operation

When opinion translation is enabled, an eligible opinion is submitted automatically. If the required translator is available, the translated text becomes primary and the existing original/translation toggle remains available.

The UI locale and opinion translation target remain independent settings.

### 4.2 First model initialization

If Chrome requires transient user activation to download or create the model:

1. The content translation service returns `activation-required`.
2. Settings displays an instruction to focus the Fomo page and click or press a key once.
3. The content script records only the pending language pair, not the source text.
4. The next trusted `pointerdown` or `keydown` in the Fomo page retries session creation.
5. A successful creation emits `translation.ready`.
6. The Side Panel automatically retries currently visible eligible opinions.

The per-card activation button is removed after this flow is stable; initialization is a service-level operation, not a card-level operation.

### 4.3 Fomo tab unavailable

The translation service requires an open Fomo tab because that tab owns the supported document context. If no Fomo tab is available, the Side Panel keeps original text and reports that Fomo must be opened. Reopening a Fomo tab causes a status re-query and eligible opinions retry automatically.

### 4.4 Page lifecycle

Translator sessions belong to one content-script lifetime. Navigation, extension reload, or tab close destroys the in-memory service. Chrome's downloaded language model remains browser-managed; a later content script recreates sessions on demand.

## 5. Architecture

```text
Side Panel
  | translation.request / translation.statusQuery
  v
Background router
  | browser.tabs.sendMessage(tabId, request)
  v
Fomo isolated content script
  | local hint -> LanguageDetector -> Translator
  | translation.response / translation.progress / translation.ready
  v
Background router
  | correlated response
  v
Side Panel coordinator and cards
```

The background is a router only. It never calls the model, stores opinion text, or records opinion text in diagnostics.

## 6. Components

### 6.1 `ContentTranslationService`

Create `src/translation/content-translation-service.ts` with one responsibility: own Chrome built-in AI objects in the content-script document.

It will:

- Feature-detect `self.Translator` and `self.LanguageDetector`.
- Accept normalized translation commands through a typed interface.
- Use `inferCommonOpinionLanguage()` before creating a detector.
- Treat confidently Chinese text as already translated when the target is Chinese.
- Treat strongly Latin, opinion-length text as English for the EN/ZH product path.
- Use `LanguageDetector` only when the local hint is inconclusive.
- Coalesce concurrent creation for the same language pair.
- Keep at most one live translator session by default.
- Destroy an evicted or late-created session.
- Forward Chrome `downloadprogress` as a bounded value from 0 through 1.
- Track language pairs that failed with `NotAllowedError`.
- Retry those pairs on the next trusted page gesture.
- Destroy sessions and remove listeners on uninstall/page teardown.

It will not inspect the Fomo DOM, mutate page content, or access extension storage.

### 6.2 Content-script host

Extend the existing isolated Fomo bridge entrypoint with a small translation host. The host validates worker commands, calls `ContentTranslationService`, and returns closed response types.

Translation logic will not be added to the MAIN-world WebSocket observer. The observer continues to handle only socket observation and activity candidates.

### 6.3 Background router

Add a focused translation router rather than embedding routing state into the main listener body. It will:

- Select a currently available Fomo tab using existing URL patterns.
- Prefer an active connected Fomo tab when connection evidence is available.
- Forward one validated command with `browser.tabs.sendMessage`.
- Return a closed `fomo-tab-required` result if no target exists.
- Apply a bounded request timeout.
- Ignore late responses after timeout or requester disposal.
- Never broadcast source text or translated text to unrelated extension pages.

The Side Panel request promise is resolved through the existing runtime request/response boundary. A request ID is used for correlation and diagnostics only; diagnostics never contain the text.

### 6.4 Side Panel adapter

Replace direct `createBrowserTranslationApi()` construction in `SidePanelApp` with a `ContentTranslationClient` implementing the existing `BrowserTranslationApi` interface where practical.

The existing `OpinionTranslationCoordinator`, LRU result cache, shared-session policy, settings controls, and visible-card retry token remain reusable. Session handles exposed to the coordinator are remote handles owned by the content service.

Side Panel unmount releases its remote session handles. Content-script teardown remains the final cleanup boundary.

## 7. Protocol

All extension messages remain on protocol version 1 and use strict schemas.

### 7.1 Commands

- `translation.statusQuery`
- `translation.detect`
- `translation.availability`
- `translation.create`
- `translation.translate`
- `translation.destroy`
- `translation.initialize`

Every command contains:

- `requestId`: bounded opaque identifier.
- `clientId`: one Side Panel mount identifier.
- The minimum operation-specific fields.

Text-bearing commands allow at most 2,000 UTF-16 code units, matching the coordinator limit. Language tags are normalized and bounded before routing.

### 7.2 Results and events

- `translation.response`
- `translation.progress`
- `translation.ready`

Closed error codes:

- `api-unavailable`
- `fomo-tab-required`
- `activation-required`
- `unsupported-pair`
- `request-timeout`
- `context-disposed`
- `translation-failed`

Raw exception messages do not cross the content-script boundary. Detailed unexpected failures may be represented by an internal diagnostic code without source text.

## 8. Trust and Privacy Boundaries

- Only privileged extension UI may originate translation commands.
- Only a content script whose sender URL matches an allowed Fomo origin may return translation results or service events.
- A normal Fomo page script cannot forge trusted runtime messages from the isolated extension world.
- Strict schemas reject extra keys and oversized text.
- No raw opinion, translated opinion, model output, or session payload is written to diagnostics, IndexedDB, `chrome.storage`, logs, badges, or pipeline health.
- No Google translation host permission is added.
- `scripting` is absent from the manifest.
- Translation requests are never sent to the MAIN world with `window.postMessage`.

## 9. Concurrency and Lifecycle

- Same-pair session creation is single-flight.
- Translation operations for one session are serialized because Chrome processes them sequentially.
- Each Side Panel request has a timeout and a latest-request guard.
- A destroyed client cannot commit a late response.
- Content-script uninstall rejects pending operations as `context-disposed` and destroys sessions exactly once.
- An activation retry is pair-based and coalesced; it never retains the opinion text that originally triggered it.
- Download progress is trailing-coalesced before crossing runtime messaging to avoid event storms.

## 10. UI States

Settings exposes these localized states:

- Checking local translation support
- Open Fomo to use local translation
- Waiting for a click in the Fomo page
- Downloading local translation model, with progress when Chrome supplies it
- Local translation ready
- Language pair unsupported
- Local translation unavailable in this Chrome version/profile
- Initialization failed; retry available

History cards always render the original immediately. Temporary translation failures never remove or block the original content.

## 11. Testing Strategy

### Unit tests

- Feature detection in an injected content-script global.
- EN/ZH local hints and inconclusive text fallback.
- `NotAllowedError` creates one pending pair.
- One trusted gesture retries each pending pair once.
- Same-pair concurrent creation is single-flight.
- Session eviction and teardown destroy sessions exactly once.
- Download progress is clamped and coalesced.
- Strict command/result schema and size limits.
- Client timeout, disposal, and late-response behavior.

### Integration tests

- Side Panel client -> background router -> isolated content host -> client response.
- Sender guards reject an ordinary web page, non-Fomo content script, and untrusted response.
- No Fomo tab returns `fomo-tab-required` without hanging.
- Tab close rejects pending work and a reopened tab recovers.
- `translation.ready` increments the Side Panel retry token and visible opinions retry.
- No raw opinion appears in diagnostics or storage calls.

### Extension E2E

- Install the Translator double before the Fomo isolated content script initializes.
- Translate an English opinion automatically.
- Simulate first-create `NotAllowedError`.
- Dispatch a real pointer gesture in the Fomo page.
- Observe ready state and automatic translation of the already-visible opinion.
- Verify original/translation toggle.
- Verify no Google translation request.
- Verify manifest permissions remain exactly `storage` and `sidePanel` and minimum Chrome remains 138.

### Manual verification

- Test a clean Chrome profile with no downloaded language model.
- Record Chrome version and `chrome://on-device-internals/` state.
- Confirm the required gesture happens in Fomo, not in the Side Panel.
- Close and reopen Fomo, then confirm session recovery without another language-pack download.

## 12. Acceptance Criteria

- Chrome 138+ profiles that expose `Translator` to the Fomo content script no longer report unsupported merely because the Side Panel lacks the global.
- Eligible English opinions translate automatically to Chinese after at most one Fomo-page gesture for first-use model initialization.
- Already-visible opinions automatically retry after initialization.
- Original text remains immediately available in every state.
- No remote translation request is made.
- No `scripting` permission or MAIN-world translation host is introduced.
- Closing the Fomo tab produces an explicit recoverable state rather than an indefinite request.
- Reopening Fomo restores translation availability and triggers a bounded retry.
- Full typecheck, unit/integration suite, production build, manifest contract test, and extension E2E pass.

## 13. Migration

The current direct Side Panel adapter from commit `f83e32d` is replaced, not layered underneath the new client. Existing local language hints, coordinator cache, settings UI, progress UI, and retry-token behavior are retained where their contracts remain valid.

No stored settings or database migration is required.
