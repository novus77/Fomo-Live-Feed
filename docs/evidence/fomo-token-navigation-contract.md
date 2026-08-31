# Fomo Token Navigation Contract

Status: verified on 2026-08-31.

Authenticated browser observations established these current token routes:

- `https://fomo.family/tokens/solana/{solanaAddress}`
- `https://fomo.family/tokens/robinhood/{evmAddress}`
- `https://fomo.family/tokens/bnb/{evmAddress}`

Fomo's official [September 2025 recap](https://fomo.family/blog/september-2025-recap)
documents Base support, establishing `https://fomo.family/tokens/base/{evmAddress}`.

The project-to-route mapping is closed: `bsc -> bnb`, `solana -> solana`,
`robinhood -> robinhood`, and `base -> base`. No verified current token-route
evidence exists for `ethereum`, `x-layer`, or `unknown`; these return no target
and remain plain text. The implementation must not infer or guess routes.
