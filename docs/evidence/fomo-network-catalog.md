# Fomo network catalog (evidence)

> **Status: SIX PRODUCT ENTRIES VERIFIED-FROM-CAPTURE (SYNTHETIC).**
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

## Verified catalog

| networkId | Chain | Visible label | Address family | Status | Source variant(s) |
| --- | --- | --- | --- | --- | --- |
| 1 | ethereum | Ethereum | EVM: `0x` + 40 hex, checksum-insensitive | verified-from-capture (synthetic) | `withdraw-ethereum` (`act-synthetic-withdraw-eth-0003`) |
| 56 | bsc | BSC | EVM: `0x` + 40 hex | verified-from-capture (synthetic) | `buy-bsc` (`act-synthetic-buy-bsc-0001`), `thesis-bsc` (`act-synthetic-thesis-bsc-0005`) |
| 8453 | base | Base | EVM: `0x` + 40 hex | verified-from-capture (synthetic) | `sell-base` (`act-synthetic-sell-base-0002`) |
| 101 | solana | Solana | Base58, decodes to exactly 32 bytes | verified-from-capture (synthetic) | `transfer-solana` (`act-synthetic-transfer-sol-0004`) |
| 196 | x-layer | X Layer | EVM: `0x` + 40 hex | verified-from-capture (synthetic) | `buy-xlayer` (`act-synthetic-buy-xlayer-0007`) |
| 900001 | robinhood | Robinhood | UNCONFIRMED — classified from evidence, never assumed EVM or Solana | verified-from-capture (synthetic) | `buy-robinhood` (`act-synthetic-buy-rh-0008`) |
| any other ID | unknown | Unknown | — | — | default for unlisted IDs |

## Notes

- **Robinhood (900001) is deliberately NOT assumed to be EVM or Solana.** Its
  numeric ID is verified from the synthetic capture, but the address family is
  recorded as unconfirmed until a real capture proves it. Validation rejects
  every robinhood address with `unknown-chain`, so no CA copy/link is offered.
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
