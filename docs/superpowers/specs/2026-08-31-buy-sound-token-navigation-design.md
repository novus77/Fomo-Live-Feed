# Buy Sound and Fomo Token Navigation Design

## 1. Goal

Add two required capabilities to the next Fomo Live Feed release:

1. play a short sound for every newly ingested live buy event when the global
   sound setting is enabled; and
2. navigate to the corresponding Fomo token page when the user selects the
   token name, reusing an existing Fomo tab whenever possible.

The design keeps both features independent from feed presentation state. Sound
must work while the Side Panel is closed, and navigation must be owned by the
service worker rather than by an untrusted URL supplied by the UI.

## 2. Scope

### In scope

- One global buy-sound toggle, disabled by default.
- One bundled, fixed, short sound effect.
- Sound for every followed trader's newly received live buy event.
- A reusable Offscreen Document responsible only for audio playback.
- Token-name-only navigation to a validated Fomo token URL.
- Reuse and activation of an existing Fomo tab, with new-tab fallback.
- Chinese and English settings copy.
- Unit, integration, E2E, manifest, build, and package coverage.

### Out of scope

- Per-trader sound controls or interaction with trader annotations.
- Volume controls, sound selection, sound queues, desktop notifications, or
  sell/transfer/thesis sounds.
- Audio downloaded from the network.
- Restoring whole-card click navigation.
- Guessing an unverified Fomo token route.

## 3. Product Behavior

### 3.1 Global buy-sound setting

The existing `notifications.soundEnabled` setting remains the source of truth.
Its default stays `false`, and the existing settings schema version does not
change.

The settings panel exposes one localized switch labelled as a buy sound. The
switch takes effect immediately after persistence. Its behavior is global:

- enabled: every newly received live buy from every followed trader requests
  the sound;
- disabled: no trader buy requests the sound.

Trader annotations, muted status, active feed filters, Side Panel visibility,
and whether the event is currently visible do not affect sound eligibility.

### 3.2 Eligible events

A sound request is emitted only when all of these conditions hold:

1. the event entered through the live `ingest()` path;
2. normalization succeeded;
3. the repository inserted the event for the first time;
4. the normalized action is `buy`; and
5. the current global `soundEnabled` value is `true`.

Recovered events entering through `ingestRecovered()`, duplicate events,
invalid payloads, failed inserts, sells, theses, transfers, and withdrawals do
not request playback.

Sound is a best-effort side effect after correctness-critical persistence. A
sound failure never rejects ingestion, delays broadcast, or hides an event.

### 3.3 Concurrent buys

Playback does not queue. A new play command resets the shared audio element to
the beginning and immediately calls `play()` again. This gives each new buy a
fresh audible edge without allowing a burst of activity to create a long audio
backlog.

### 3.4 Token navigation

Only the rendered token name or symbol is interactive. The card background is
not clickable.

Existing interactions retain their own behavior:

- trader identity opens the trader's Fomo profile;
- the copy control copies the contract address;
- translation and other card controls do not navigate.

The token renders as a link only when its chain and contract address can be
validated and a verified Fomo token route can be constructed. Otherwise it
renders as ordinary text.

## 4. Architecture

### 4.1 Sound eligibility and dispatch

The service worker owns eligibility because it can distinguish live ingestion
from recovery and already knows whether insertion was new. The ingestion
composition receives a best-effort sound notifier dependency. After a live buy
is inserted, it reads the latest persisted settings and, when enabled, asks the
audio service to play.

```text
live payload
  -> validate and normalize
  -> insert
  -> inserted buy?
  -> read global sound setting
  -> request Offscreen Document playback
  -> continue normal broadcast/enrichment independently
```

The recovery composition never calls the sound notifier. Duplicate detection
continues to use the repository insert result, so no additional played-event
cache is necessary.

### 4.2 Offscreen audio service

The extension adds the `offscreen` manifest permission and one WXT offscreen
entrypoint containing a single audio element backed by a packaged asset.

The background audio service:

- checks whether the offscreen document already exists;
- serializes creation through one in-memory creation promise;
- creates it with the audio-playback reason only when needed;
- sends a closed, versioned `sound.playBuy` message; and
- treats creation, messaging, or playback errors as non-fatal diagnostics.

The Offscreen Document accepts messages only from the extension runtime. Each
valid command pauses the current sound, resets `currentTime` to zero, and
starts playback. A service-worker restart may lose the creation promise but not
correctness: the service checks the actual offscreen-document state before
creating another instance.

No remote URL, arbitrary asset path, volume value, or audio bytes cross the
message boundary.

### 4.3 Navigation message boundary

The Event Card sends only the normalized event `chain` and `tokenAddress` in a
closed, versioned navigation request. It does not send a complete URL.

The service worker validates the request and calls the shared Fomo URL builder.
This keeps the fixed HTTPS origin and chain-specific contract validation at the
trusted boundary.

Before implementation locks the route, the real Fomo site must be inspected to
capture the canonical token-page URL for every supported chain family. The URL
builder and its tests are updated from that observed contract. If a chain has
no verified route, the builder returns `null` and its token stays non-clickable;
the implementation must not fall back to the current provisional
`/token/{chain}/{address}` assumption.

### 4.4 Fomo tab selection

For a valid target URL, the service worker queries only Fomo tabs and selects
the destination in this order:

1. the most recently accessed Fomo tab in the current window;
2. the most recently accessed Fomo tab in another window;
3. a newly created tab when no Fomo tab exists.

For an existing tab it updates the URL, activates the tab, and focuses its
window. If updating the selected tab fails because it disappeared or became
unavailable, it creates a new tab with the validated target. A final Chrome API
failure is reported as a bounded diagnostic and does not affect the feed.

Tab ranking is implemented as a pure function over the bounded query result so
the selection policy is deterministic and independently testable.

## 5. Components and Changes

### Settings

- Reuse `LocalSettingsV4.notifications.soundEnabled` and its existing default.
- Add the localized settings switch and explanatory copy.
- Do not introduce a settings migration.

### Background

- Add a buy-sound eligibility/notifier boundary to live ingestion composition.
- Add an offscreen-document lifecycle and playback client.
- Add the token-navigation message handler and tab-selection policy.
- Add bounded diagnostic codes for audio and navigation failures without raw
  payloads or URLs.

### Offscreen entrypoint

- Own exactly one bundled audio element.
- Validate the runtime message and restart playback on every valid command.
- Contain no feed, storage, Fomo, or navigation logic.

### Event Card

- Remove the card-level navigation handler.
- Render the token name as an explicit link/button only when the builder can
  represent the event safely.
- Keep profile, copy, and translation interactions isolated.

### Manifest and assets

- Add only the `offscreen` permission.
- Package one local short audio asset.
- Preserve the current Fomo-only host permissions and privacy boundary.

## 6. Error Handling and Observability

- Settings read failure: skip sound and record a bounded storage/audio
  diagnostic; do not assume enabled.
- Offscreen creation race: await the shared creation promise, then send once.
- Playback rejection: swallow at the audio boundary and record a non-sensitive
  failure signal.
- Invalid navigation request: reject before any tab API call.
- Unverified chain route: render non-interactive token text.
- Existing-tab update failure: retry once by creating a new tab.
- Final navigation failure: keep the Side Panel unchanged and record a bounded
  failure signal.

Diagnostics must not store full contract addresses, complete target URLs,
event payloads, or user identifiers.

## 7. Testing Strategy

### Unit and integration

- Default setting remains disabled and settings updates persist immediately.
- Live inserted buy plus enabled setting requests one playback.
- Disabled setting and every ineligible action request no playback.
- Recovered, duplicate, invalid, and failed-insert events request no playback.
- Audio failure does not reject ingestion or suppress broadcast.
- Offscreen creation is single-flight and an existing document is reused.
- Every play command restarts the audio rather than queuing it.
- The manifest contains `offscreen` and no unrelated new permission.
- Verified token routes preserve the fixed HTTPS Fomo origin and reject invalid
  chain/address pairs.
- Tab ranking follows current-window recency, cross-window recency, then new
  tab fallback.
- Existing-tab update failure falls back to one new-tab creation.
- Only the token identity navigates; the card body, profile link, and copy
  action remain independent.

### End to end

- Enable buy sound, inject a live buy, and observe one offscreen play command.
- Reload or reconnect and verify recovered/duplicate activity remains silent.
- Select a token name and verify an existing Fomo tab is updated and activated.
- Verify absence of a Fomo tab creates one target tab.
- Verify selecting card whitespace does not navigate.

### Release validation

- TypeScript type check.
- Full unit and integration suite.
- Playwright E2E suite.
- Production build.
- Local Chrome package generation and SHA-256 verification.
- Manual Chrome test with the Side Panel closed to confirm offscreen audio.
- Manual verification of the real Fomo token URL contract on supported chains.

## 8. Acceptance Criteria

The feature is complete when:

1. sound is disabled on a fresh or migrated installation;
2. enabling it causes every first-seen live buy to restart the fixed sound once,
   regardless of trader annotations, filters, or Side Panel visibility;
3. disabling it suppresses all buy sounds immediately;
4. no recovered, duplicate, invalid, or non-buy event plays sound;
5. clicking only a valid token identity reuses and activates the preferred Fomo
   tab, or creates one when none exists;
6. invalid or unverified token targets are visibly non-interactive;
7. all other card interactions retain their current behavior; and
8. playback and navigation failures never interrupt ingestion or feed display.
