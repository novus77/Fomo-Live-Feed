# Fomo Token Navigation Contract

Status: verified on 2026-08-31.

Authenticated browser observations established these current token routes:

- `https://fomo.family/tokens/solana/{solanaAddress}`
- `https://fomo.family/tokens/robinhood/{evmAddress}`
- `https://fomo.family/tokens/bnb/{evmAddress}`

Fomo's official [September 2025 recap](https://fomo.family/blog/september-2025-recap)
documents Base support, but does not establish a canonical token-page route.
An HTTP 200 response is not route evidence because the SPA responds to arbitrary paths.

The project-to-route mapping is closed: `bsc -> bnb`, `solana -> solana`,
`robinhood -> robinhood`. No authenticated-page observation establishes a
current token route for `base`, `ethereum`, `x-layer`, or `unknown`; these
return no target and remain plain text. The implementation must not infer or
guess routes from general network support or SPA HTTP responses.
