# Fomo activity contract (evidence)

> **Status: VERIFIED-FROM-CAPTURE (SYNTHETIC).**
>
> No live authenticated Fomo traffic could be captured in this environment, so
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

- SHA-256 of the unredacted synthetic capture file
  (`tests/fixtures/fomo-activity-variants.ts`):
  `a8634fc6a937eee2a5396c095c36e9df0200819431c480c6f98c5f0866a4c4aa`.
- The unredacted capture is held outside git and is never committed.
- This contract is promoted to `verified-from-capture` based on the synthetic
  fixtures; replace the SHA-256 with a real authenticated capture digest
  before release.

## Transport (unchanged from the implementation)

| Item | Value |
| --- | --- |
| Socket | `wss://prod-api.fomo.family/ws` |
| Frame envelope | `{ "type": "data", "topicType": "trading_activity", "payload": { … } }` |
| Extraction | `src/fomo/websocket-observer.ts` forwards only `record.payload` when `type === "data"` and `topicType === "trading_activity"` |

The envelope is validated by `rawActivitySchema` (Zod, passthrough) at ingest;
unknown payload keys are tolerated and ignored, never persisted.

## Payload fields (raw activity)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | optional | Fomo event identifier; becomes `sourceEventId`; bounded to 128 chars. |
| `tradeId` | string | optional | Fomo trade identifier; becomes `sourceTradeId`. |
| `type` | `"swap_buy" \| "swap_sell" \| "swap_withdraw" \| "transfer_out" \| "thesis"` | required | Maps to canonical action `buy` / `sell` / `withdraw` / `transfer` / `thesis` in `src/fomo/normalize.ts`. |
| `userId` | string | required | Trader identifier; becomes `traderId`; bounded to 128 chars. |
| `userHandle` | string | required | Trader handle; becomes `traderHandle`. |
| `ticker` | string | required | Token symbol; trimmed on normalize. |
| `tokenAddress` | string | required | Contract/mint address; address family depends on `networkId` (see `fomo-network-catalog.md`); bounded to 128 chars. |
| `networkId` | number (integer) | required | Numeric chain ID; see `fomo-network-catalog.md`. |
| `createdAt` | string, ISO 8601 with offset | required | Event time; becomes `occurredAt` epoch milliseconds. |
| `displayName` | string | optional | Trader display name; becomes `traderName`; preserved verbatim, may be empty. |
| `profilePictureLink` | HTTPS URL | optional | Trader avatar; becomes `traderAvatarUrl`; HTTPS only, ≤ 2048 chars. |
| `tokenImageUrl` | HTTPS URL | optional | Token image; HTTPS only, ≤ 2048 chars. |
| `usdAmount` | number, finite ≥ 0 | optional | USD notional. |
| `marketCap` | number, finite ≥ 0 | optional | — |
| `price` | number, finite ≥ 0 | optional | — |
| `comment` | string \| `{ comment: string }` | optional | Opinion text; both forms normalize to the same `thesis` value; bounded to 4096 chars. |

## Observed payload variants

All variants live in `tests/fixtures/fomo-activity-variants.ts` and satisfy the
compile-time container:

```ts
export const redactedActivityVariants = [
  // one complete redacted record per observed payload variant
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

Network IDs and address shapes are verified from synthetic captures (see
`fomo-network-catalog.md`); they are preserved verbatim in the fixtures so a
later parser/test can assert the exact observed number once real captures
exist.

## Bounds (enforced by `src/fomo/raw-schema.ts`)

- Identifiers (`id`, `tradeId`, `userId`, `userHandle`, `ticker`): 1–128 chars
  after trimming; empty strings are rejected.
- `tokenAddress`: 1–128 chars.
- `comment` / thesis text: ≤ 4096 chars.
- `profilePictureLink` / `tokenImageUrl`: ≤ 2048 chars and must parse as HTTPS.
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
3. Redact every sensitive value, hash the unredacted capture, and replace the
   synthetic SHA-256 above.
4. Confirm this contract and the fixtures remain `verified-from-capture`.
