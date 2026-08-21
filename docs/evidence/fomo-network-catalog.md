# Fomo network catalog (evidence)

> **Status: ALL ENTRIES PROVISIONAL-UNVERIFIED.**
>
> No real authenticated Fomo frame could be captured in this environment, so no
> numeric `networkId` is verified. The IDs below are plausible placeholders
> only: EIP-155 chain IDs where they exist (1, 56, 8453, 196), the conventional
> Solana pseudo-ID (101), and a guessed internal ID for Robinhood (900001).
> Every entry MUST be re-confirmed against a real authenticated Fomo frame
> before release; until then `mapNetworkId` must return `unknown` for every
> entry in this table (plan Task 3 step 4).

## Capture integrity

- SHA-256 of the unredacted capture: `sha256-redacted-outside-git` (placeholder
  — replace with the real digest once a capture exists).
- The unredacted capture is held outside git and is never committed.
- An entry may be promoted to `verified-from-capture` only after a real
  authenticated Fomo activity carrying that numeric ID is captured, redacted,
  and hashed.

## Provisional catalog

| networkId (provisional) | Chain | Address family (provisional) | Status | Needs |
| --- | --- | --- | --- | --- |
| 1 | ethereum | EVM: `0x` + 40 hex, checksum-insensitive | provisional-unverified | real frame capture |
| 56 | bsc | EVM: `0x` + 40 hex | provisional-unverified | real frame capture |
| 8453 | base | EVM: `0x` + 40 hex | provisional-unverified | real frame capture |
| 101 | solana | Base58, decodes to exactly 32 bytes | provisional-unverified | real frame capture |
| 196 | x-layer | EVM-compatible `0x` + 40 hex (assumed — UNVERIFIED) | provisional-unverified | real frame capture |
| 900001 | robinhood | UNCONFIRMED — classified from evidence, never assumed EVM or Solana | provisional-unverified | real frame capture |
| any other ID | unknown | — | — | default for unlisted IDs |

## Notes

- **Robinhood (900001) is deliberately NOT assumed to be EVM or Solana.** Its
  numeric ID and address format must come from evidence (plan Task 3 step 2);
  the address family is recorded as unconfirmed until a real capture exists.
- **X Layer (196)** is assumed EVM-compatible because X Layer is an EVM chain,
  but the Fomo-facing ID and address family are unverified.
- The current in-repo mapping (`src/fomo/network-map.ts`) still treats
  1/56/8453 as `established-in-codebase` and also carries Monad entries
  (143/10143) as provisional. Monad, ARC, Stable, and Hyper EVM are OUT OF
  SCOPE for the six-chain release (plan scope section); until verified, every
  ID in this table maps to `unknown` and no UI badge may claim a chain.
- `mapNetworkId` must return `unknown` for provisional entries, and only
  entries documented in this file may ever use `verified-from-capture`.

## Requirements before release

1. Capture one real activity per chain and record its exact numeric
   `networkId`.
2. Record the observed address family and a representative redacted address
   shape (EVM 40-hex, Solana 32-byte Base58, or whatever Robinhood/X Layer
   actually emit).
3. Hash the unredacted capture and replace `sha256-redacted-outside-git`.
4. Promote each confirmed entry to `verified-from-capture` and update
   `src/fomo/network-map.ts` accordingly.
