# Fomo activity contract (evidence)

> **Status: SYNTHETIC-FIXTURE-MODEL; not live transport verification.**
>
> This document does not contain a redacted live authenticated payload set, so
> this document and the matching fixtures in
> `tests/fixtures/fomo-activity-variants.ts` are hand-built reconstructions of
> the payload shape implemented in `src/fomo/raw-schema.ts`, the frame envelope
> implemented in `src/fomo/websocket-observer.ts`, and the normalization in
> `src/fomo/normalize.ts`. Every value is synthetic or truncated: no real
> identity, address, amount, timestamp, URL, or opinion text appears in this
> document or in the fixtures. Treat every field and variant below as
> provisional until a real authenticated capture is redacted and this contract
> is re-verified.

## Capture integrity

- Recorded SHA-256 of the synthetic fixture file
  (`tests/fixtures/fomo-activity-variants.ts`):
  `a8634fc6a937eee2a5396c095c36e9df0200819431c480c6f98c5f0866a4c4aa`.
- Synthetic fixtures are committed test models, not an unredacted live capture.
- Synthetic fixtures alone cannot promote this contract to
  `verified-from-capture`. Verify the fixture digest when changing the file;
  record a separate real-capture digest only after collecting live evidence.

## Transport (unchanged from the implementation)

| Item | Value |
| --- | --- |
| Socket | `wss://prod-api.fomo.family/ws` |
| Frame envelope | `{ "type": "data", "topicType": "trading_activity", "payload": { … } }` |
| Extraction | `src/fomo/websocket-observer.ts` supports the topic envelope and bounded nested activity extraction; `/feed/tradingActivity` responses are also observed through fetch/XHR |

The envelope is validated by `rawActivitySchema` (Zod, passthrough) at ingest;
unknown payload keys are tolerated and ignored, never persisted.

## Payload fields (raw activity)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | optional | Fomo event identifier; becomes `sourceEventId`; bounded to 128 chars. |
| `tradeId` | string | optional | Fomo trade identifier; becomes `sourceTradeId`. |
| `type` | `"swap_buy" \| "swap_sell" \| "swap_withdraw" \| "transfer_in" \| "transfer_out" \| "thesis"` | required | Maps to canonical action `buy` / `sell` / `withdraw` / `transfer` / `thesis` in `src/fomo/normalize.ts`. |
| `userId` | string | required | Trader identifier; becomes `traderId`; bounded to 128 chars. |
| `userHandle` | string | required | Trader handle; becomes `traderHandle`. |
| `ticker` | string | required | Token symbol; trimmed on normalize. |
| `tokenAddress` | string | required | Contract/mint address; address family depends on `networkId` (see `fomo-network-catalog.md`); bounded to 128 chars. |
| `networkId` | number (integer) | required | Numeric chain ID; see `fomo-network-catalog.md`. |
| `createdAt` | string, ISO 8601 with offset | required | Event time; becomes `occurredAt` epoch milliseconds. |
| `displayName` | string | optional | Trader display name; becomes `traderName`; preserved verbatim, may be empty. |
| `profilePictureLink` | image input | optional | Trader avatar; normalization accepts HTTPS or a root-relative Fomo path, ≤ 2048 chars. Unsafe/malformed optional images are omitted. |
| `tokenImageUrl` | image input | optional | Token image; normalization accepts HTTPS or a root-relative Fomo path, ≤ 2048 chars. Unsafe/malformed optional images are omitted. |
| `usdAmount` | number, finite ≥ 0 | optional | USD notional. |
| `marketCap` | number, finite ≥ 0 | optional | — |
| `price` | number, finite ≥ 0 | optional | — |
| `comment` | string \| `{ comment: string }` | optional | Opinion text; both forms normalize to the same `thesis` value; bounded to 4096 chars. |

## Synthetic payload variants

All variants live in `tests/fixtures/fomo-activity-variants.ts` and satisfy the
compile-time container:

```ts
export const redactedActivityVariants = [
  // One synthetic record per modeled payload variant.
] as const satisfies readonly {
  expectedAction: 'buy' | 'sell' | 'withdraw' | 'transfer' | 'thesis';
  expectedNetworkId: number;
  payload: Readonly<Record<string, unknown>>;
}[];
```

| Variant | `type` | expectedAction | networkId | Chain | Comment form | Address shape |
| --- | --- | --- | --- | --- | --- | --- |
| buy-bsc | `swap_buy` | buy | 56 | bsc | — | `0x` + 40 hex |
| sell-base | `swap_sell` | sell | 8453 | base | — | `0x` + 40 hex |
| withdraw-ethereum | `swap_withdraw` | withdraw | 1 | ethereum | — | `0x` + 40 hex |
| transfer-solana | `transfer_out` | transfer | 101 | solana | — | Base58, 32 bytes |
| thesis-bsc | `thesis` | thesis | 56 | bsc | structured `{ comment }` | `0x` + 40 hex |
| thesis-ethereum | `thesis` | thesis | 1 | ethereum | plain string | `0x` + 40 hex |
| buy-xlayer | `swap_buy` | buy | 196 | x-layer | — | `0x` + 40 hex |
| buy-robinhood | `swap_buy` | buy | 900001 | robinhood | — | redacted non-EVM/non-Solana placeholder |

These rows describe synthetic fixture values, not current production IDs.
Consult `fomo-network-catalog.md` for separately marked live observations,
including Solana `1399811149`, Robinhood `4663`, and ARC `5042`.

## Bounds (enforced by `src/fomo/raw-schema.ts`)

- Identifiers (`id`, `tradeId`, `userId`, `userHandle`, `ticker`): 1–128 chars
  after trimming; empty strings are rejected.
- `tokenAddress`: 1–128 chars.
- `comment` / thesis text: ≤ 4096 chars.
- `profilePictureLink` / `tokenImageUrl`: normalization requires ≤ 2048 chars
  and a safe HTTPS URL or root-relative Fomo path; invalid optional input is omitted.
- `createdAt`: ISO 8601 with an offset (for example `Z`).
- `usdAmount` / `marketCap` / `price`: finite, non-negative numbers.

## Redaction rules applied

- Every identifier, handle, display name, address, ticker, amount, timestamp,
  URL, and prose value in the fixtures is synthetic or explicitly truncated.
- EVM addresses in the fixtures are full `0x` + 40-hex synthetic addresses,
  not real contract addresses.
- Solana addresses are clearly synthetic Base58-alphabet strings that decode
  to exactly 32 bytes.
- Profile/token image URLs use `https://example.com/…` (RFC 2606 reserved
  domain).
- No session credentials, request headers, tokens, or real social URLs appear.

## Requirements before release

1. Capture at least one real authenticated frame per `type` value (plan Task 1
   step 2), using Chrome DevTools on an authenticated Fomo tab.
2. Record the exact observed numeric `networkId` per chain into
   `fomo-network-catalog.md`.
3. Redact every sensitive value and record a separate digest of the original
   capture without committing it. Retain the synthetic fixture digest with
   its synthetic label; a live capture does not change that file's provenance.
4. Mark only directly captured fields/variants as `verified-from-capture`;
   preserve synthetic-only and unverified variants as such.

## DOM observation update (2026-10-03)

Live browser inspection confirmed that transaction anchors wrap the trader
avatar before the token thumbnail. Token labels use `div[role="link"]`, the
outer anchor has a stable `tradeId` query parameter, and `innerText` separates
fields that `textContent` concatenates. Token thumbnails are adjacent to the
semantic token label, not necessarily the first image. Chinese market-cap
labels can use `万亿`; DOM fallback now supports it and the English `T` unit.

This verifies DOM structure only, not a new transport payload contract. See
`../audits/2026-10-03-system-performance-and-fomo-capture.md` for the audit,
limitations, and candidate verification status.
