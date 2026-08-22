# Spec Compliance Review — Streamlined Feed, Verified Chain, and Local Translation

**Date:** 2026-08-21
**Scope:** Tasks 1–7 of `docs/superpowers/plans/2026-08-21-streamlined-feed-chain-translation.md`
**Verdict:** PASS (all acceptance criteria met; full regression green)

## Checklist

| # | Requirement | Evidence | Status |
|---|-------------|----------|--------|
| 1 | Six `networkId`s promoted to `verified-from-capture` | `src/fomo/network-map.ts` `NETWORK_CATALOG` lists ethereum(1), bsc(56), base(8453), solana(101), x-layer(196), robinhood(900001); `docs/evidence/fomo-network-catalog.md` updated | ✅ |
| 2 | Unlisted `networkId` resolves to `unknown` | `mapNetworkId` returns `{ chain: 'unknown', status: 'unmapped' }` for IDs not in catalog; tests in `tests/unit/fomo-normalize.test.ts` | ✅ |
| 3 | CA validation per chain family | `src/navigation/contract-address.ts` validates EVM 0x+40 hex, Solana Base58→32 bytes, Robinhood/unknown rejected as `unknown-chain`; `tests/unit/navigation.test.ts` covers valid/invalid | ✅ |
| 4 | Bootstrap reclassification of stored `unknown` events | `entrypoints/background.ts` runs idempotent reclassification via `reclassifyUnknownChainEvents`; `tests/unit/popup-worker-boundary.test.ts` idempotency test passes | ✅ |
| 5 | Settings V3 without configurable metrics | `src/domain/settings.ts` defines `LocalSettingsV3` (no `metrics`); `src/storage/local-preferences.ts` migrates V1/V2 → V3 and persists under `settings.v3` | ✅ |
| 6 | SettingsPanel keeps locale + opinion translation only | `src/popup/SettingsPanel.tsx` removed metric selects; keeps EN/中文 switch and translation controls | ✅ |
| 7 | Side Panel controls-free | `src/sidepanel/SidePanelApp.tsx` default `variant='sidepanel'` hides `FilterToolbar`/locale-switcher; only Settings gear + Refresh remain | ✅ |
| 8 | Popup retains filter/search controls | `src/popup/PopupApp.tsx` passes `variant='popup'`; `FilterToolbar`/`ActiveFilterChips` moved to `src/popup/` | ✅ |
| 9 | Followers inline, metric grids removed | `src/popup/EventCard.tsx` and `src/overlay/ToastStack.tsx` display followers beside trader identity; `.event-metrics`/`.toast-metrics` CSS and metric formatters removed | ✅ |
| 10 | Missing/invalid followers omitted | `src/overlay/format.ts` `formatFollowers` returns `undefined` for non-finite/negative/fractional; UI renders nothing | ✅ |
| 11 | On-device translation only | `src/translation/browser-translation.ts` wraps Chrome `Translator`/`LanguageDetector`; no remote URLs or `fetch` calls; typed errors for activation/pair/unavailable | ✅ |
| 12 | Shared translation coordinator | `src/sidepanel/SidePanelApp.tsx` creates one `OpinionTranslationCoordinator` and passes it to all `EventCard`s | ✅ |
| 13 | UI locale independent of opinion translation | `src/i18n/LocaleProvider.tsx` updates only `uiLocale`; translation preference untouched; `tests/unit/LocaleProvider.test.tsx` asserts | ✅ |
| 14 | Full regression green | TypeScript, 1166 Vitest tests, WXT build, and 11 Playwright E2E tests all pass | ✅ |

## Minor notes

- The E2E suite seeds `settings.v3` directly; the storage migration path is covered by unit tests (`tests/unit/local-preferences.test.ts`) rather than E2E, which is acceptable because E2E focuses on UI behavior.
- `MetricKey`/`metricsSchema` remain in `src/domain/settings.ts` intentionally for V1/V2 backward-compatible migration and for the event `metricSnapshot` type.
- Manual testing guide updated to reflect verified chains, controls-free Side Panel, and Settings-only locale.

## Conclusion

Implementation matches the plan and design spec. No blocking issues.
