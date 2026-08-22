# Streamlined Feed, Verified Chain, and Local Translation Design

**Status:** Approved
**Date:** 2026-08-21

## Goal

Turn the Side Panel into a focused newest-first information feed, correctly
show verified Fomo chain and CA data, and automatically translate English KOL
opinions with Chrome's on-device translation APIs.

## Product decisions

- Remove the main-view EN/Chinese switcher. Locale is changed only in Settings.
- Remove search, Filters, Unread, Pinned, filter chips, and reset controls.
- Always show all locally stored activities newest-first with pagination.
- Show followers beside trader identity only when a valid value exists.
- Remove the card metric grid, 7-day win rate, and metric configuration.
- Keep refresh, connection status, Settings, annotations, and labels.
- Translation is automatic, on-device, and independent from UI locale.

## Card layout

Each card renders:

1. avatar, trader name, handle, optional followers, and label action;
2. action, token, verified chain badge, amount, and relative time;
3. optional opinion plus automatic translation state;
4. optional annotation editor;
5. full verified CA plus copy action.

Followers accept only finite non-negative integers. Missing or invalid values
render nothing, never `0` or `Unavailable`.

## Settings and migration

Introduce `LocalSettingsV3` without `metrics`. Preserve notification settings,
toast-suppression filters, UI locale, and opinion-translation settings. V1/V2
records migrate by ignoring legacy metric slots. Existing IndexedDB events keep
their optional `metricSnapshot.followers` for backward compatibility; no
destructive event migration is required.

## Authoritative chain resolution

Fomo activity messages already contain `networkId` and `tokenAddress`.
`networkId` is the authoritative chain discriminator:

```text
verified Fomo networkId
  -> ChainKey
  -> chain-specific address validation
  -> chain badge + CA copy/link
```

The CA validates the address family but must not choose among EVM chains. A
`0x` address alone cannot distinguish Ethereum, BSC, Base, or X Layer.

Before enabling mappings, capture one authenticated activity for BSC, Solana,
Robinhood, Base, Ethereum, and X Layer. Record the visible Fomo chain label,
numeric `networkId`, redacted address shape, timestamp, and SHA-256 of the
private raw capture retained outside Git. Only captured mappings may use
`verified-from-capture`.

Validation rules:

- EVM: `0x` plus 40 hexadecimal characters.
- Solana: Base58 decoding to exactly 32 bytes.
- Robinhood: only the address family proven by capture.
- Unknown ID: show `Unknown`; CA remains selectable but non-interactive.
- Known chain with invalid CA: show the badge but no copy/link.
- Reclassify stored `unknown` rows idempotently after their preserved
  `networkId` becomes verified.

## Automatic on-device translation

Use Chrome 138+ `LanguageDetector` and `Translator`. Never send opinion text to
Google Translate HTTP endpoints or another third-party service.

Flow:

1. render original immediately;
2. automatically detect source language when translation is enabled;
3. skip when source and target match;
4. inspect availability and create/download the model;
5. if Chrome requires transient activation, show one localized enable action;
6. retry automatically after activation/download;
7. show translation as primary with a view-original toggle.

The Side Panel owns one coordinator. Session creation is single-flight per
language pair, LRU-bounded, latest-wins, and destroyed on panel unmount.
Translation failures never block or remove the original activity.

## Feed simplification

Delete main-view search/filter composition and styling. Repository pagination
remains internal and always receives default filters plus an empty search.
Annotation data remains compatible; pin no longer changes feed order, while
mute remains applicable only to toast suppression.

## Acceptance criteria

- No main-view locale, search, filter, unread, pinned, chip, or reset control.
- Settings contains the only EN/Chinese switch.
- No card metric grid and no metric settings.
- Valid followers appear beside identity; missing followers leave no placeholder.
- Six captured chains show exact badges and valid CA copy controls.
- Unknown/invalid CA never becomes a trusted copy/link action.
- English opinions translate automatically in a supported clean Chrome profile.
- UI locale changes do not alter translation enabled/target settings.
- Existing history, annotations, and retained settings migrate without loss.

## Verification

Unit/integration coverage must include settings migration, simplified
composition, follower omission/formatting, six-chain normalization and CA
validation, stored-row reclassification, automatic translation activation,
session concurrency/cleanup, and locale independence.

Real-extension E2E must cover the 280 px feed, Settings-only locale switching,
six chain badges, exact CA clipboard writes without navigation, optional inline
followers, absence of metric/filter UI, and automatic translation through a
contract-accurate Chrome API double. Release also requires a manual test in a
clean Chrome 138+ profile with no pre-downloaded translation model.
