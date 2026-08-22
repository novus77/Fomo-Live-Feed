# Optional Image Normalization Design

## Goal

Every valid Fomo activity must be ingested regardless of whether its trader or token image is custom, default, relative, missing, or malformed.

## Boundary

Core activity fields remain strict: `type`, `userId`, `userHandle`, `ticker`, `tokenAddress`, `networkId`, and `createdAt` must satisfy the existing raw schema. Image fields are presentation metadata and must never decide whether the activity is accepted.

## Normalization

- Absolute HTTPS image URLs are preserved.
- Root-relative image paths are resolved against `https://fomo.family`.
- Missing, empty, non-HTTPS, malformed, or oversized image values are omitted.
- The UI continues to render its existing fallback avatar when `traderAvatarUrl` is absent.
- The same policy applies to `profilePictureLink` and `tokenImageUrl`.

Resolution happens while converting a validated raw activity into `TradeEventV1`. The raw schema accepts bounded strings for optional image fields but does not validate their URL semantics. This keeps the trust boundary explicit: unsafe values never reach persisted canonical events, while invalid presentation metadata cannot reject a valid trade.

## Security

Only HTTPS output is allowed. Protocol-relative URLs, `http:`, `data:`, `javascript:`, credentials, and malformed URLs are discarded. Root-relative paths are resolved only against the fixed Fomo origin, never against attacker-controlled input.

## Verification

Unit tests cover custom HTTPS images, the `/fomo-eyes.png` default avatar, missing images, malformed images, unsafe schemes, and invalid token images. The ingest boundary test proves the event is accepted and persisted. Full typecheck, unit/integration tests, production build, and real Side Panel observation complete verification.
