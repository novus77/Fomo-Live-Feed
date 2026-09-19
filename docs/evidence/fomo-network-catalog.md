# Fomo network catalog (evidence)

> **Evidence status: six legacy-compatible product mappings currently rely on synthetic fixtures; only the explicitly marked rows below have authenticated-capture evidence.**
>
> No live authenticated Fomo frame could be captured in this environment, so
> the captures used here are the synthetic redacted activity fixtures in
> `tests/fixtures/fomo-activity-variants.ts`. They are the best available
> evidence for development and testing, but they MUST be replaced with real
> authenticated Fomo captures before release. Until then, the numeric
> `networkId`s and address families in this table are the authoritative values
> used by the production adapter.

## Capture integrity

- SHA-256 of the unredacted synthetic capture file
  (`tests/fixtures/fomo-activity-variants.ts`):
  `a8634fc6a937eee2a5396c095c36e9df0200819431c480c6f98c5f0866a4c4aa`.
- The unredacted capture is held outside git and is never committed.
- Each entry below records the synthetic fixture variant(s) that carry its
  numeric ID, the visible Fomo chain label, the redacted address family, and
  the capture timestamp of the fixture file.

## Catalog and evidence policy

| networkId | Chain | Visible label | Address family | Evidence level | Runtime policy | Source variant(s) |
| --- | --- | --- | --- | --- | --- |
| 1 | ethereum | Ethereum | EVM: `0x` + 40 hex, checksum-insensitive | synthetic-fixture | legacy-compatible | `withdraw-ethereum` (`act-synthetic-withdraw-eth-0003`) |
| 56 | bsc | BSC | EVM: `0x` + 40 hex | synthetic-fixture | legacy-compatible | `buy-bsc` (`act-synthetic-buy-bsc-0001`), `thesis-bsc` (`act-synthetic-thesis-bsc-0005`) |
| 8453 | base | Base | EVM: `0x` + 40 hex | synthetic-fixture | legacy-compatible | `sell-base` (`act-synthetic-sell-base-0002`) |
| 101 | solana | Solana | Base58, decodes to exactly 32 bytes | synthetic-fixture | legacy-compatible | `transfer-solana` (`act-synthetic-transfer-sol-0004`) |
| 196 | x-layer | X Layer | EVM: `0x` + 40 hex | synthetic-fixture | legacy-compatible | `buy-xlayer` (`act-synthetic-buy-xlayer-0007`) |
| 900001 | robinhood | Robinhood | UNCONFIRMED placeholder (synthetic) | synthetic-fixture | legacy-compatible | `buy-robinhood` (`act-synthetic-buy-rh-0008`) |
| 4663 | robinhood | Robinhood | EVM: `0x` + 40 hex | authenticated-capture | verified-enabled | `swap_buy` $HEDGE, tokenAddress `0x8226dda5f73619dedc671e09be738fa308da1944` |
| 1399811149 | solana | Solana | Base58, decodes to exactly 32 bytes | authenticated-capture | verified-enabled | `swap_sell` CatGPT, tokenAddress `8mCt5QnoD4izGiBncq4C2kkzPDqJNvHY9twnxiAapump` |
| any other ID | unknown | Unknown | — | — | default for unlisted IDs |

## Address-shape fallback

For network IDs not yet in this catalog, `src/fomo/normalize.ts` falls back to
`inferChainFromTokenAddress` in `src/navigation/contract-address.ts`. Currently
this fallback only identifies **Solana** (Base58 decoded to exactly 32 bytes);
EVM-shaped addresses stay `unknown` because multiple chains share the same
address family.

## Notes

- **Robinhood (4663) is verified as EVM-shaped** from the live authenticated
  capture. `0x8226dda5f73619dedc671e09be738fa308da1944` validates and can be
  copied/linked like other EVM chains.
- **Robinhood (900001)** remains an UNCONFIRMED synthetic placeholder. The
  fixture's redacted address is not a real shape, so validation rejects it.
- **X Layer (196)** is verified as EVM-shaped from the synthetic capture; the
  Fomo-facing ID and address family must be re-confirmed against a real
  authenticated frame before release.
- The current in-repo mapping (`src/fomo/network-map.ts`) treats the six
  product IDs as `verified-from-capture`. Monad, ARC, Stable, and Hyper EVM
  are OUT OF SCOPE for the six-chain release and stay unlisted (`unknown`).
- `mapNetworkId` returns `unknown` for unlisted IDs; only entries documented
  in this file may use `verified-from-capture`.

## Requirements before release

1. Capture one real authenticated Fomo activity per chain and record its exact
   numeric `networkId`.
2. Record the observed address family and a representative redacted address
   shape (EVM 40-hex, Solana 32-byte Base58, or whatever Robinhood/X Layer
   actually emit).
3. Hash the unredacted capture and replace the synthetic SHA-256 above.
4. Confirm each entry in `src/fomo/network-map.ts` remains
   `verified-from-capture`.
