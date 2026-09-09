# Pump Following Trade Contract Feasibility

Status: **approved for bounded authenticated HTTP near-real-time collection**  
Checked: 2026-09-09

## Scope

This note records only field names, primitive types, counts, and public frontend
behavior observed on the official `pump.fun` application. It intentionally omits
cookies, headers, tokens, wallet addresses, user identifiers, transaction hashes,
and unrelated identities.

## Confirmed authenticated snapshot contract

The logged-in page can request the official Following alerts endpoint with
`kinds=trade`. A successful response has:

- response: `{ items: Array, nextCursor: string | null }`
- item discriminator: `kind === "trade"`
- trader: `author.userId`, `author.userName`, `author.profileImage`,
  `author.walletAddress`, and `author.xUsername`
- token: `coinMint`, `coinName`, `coinImage`, and `symbol`
- chain: numeric `chainId`
- trade: `trade.tx`, `trade.isBuy`, `trade.timestamp`, `trade.amountUsd`,
  `trade.baseAmount`, and `trade.priceUsd`
- event market cap: numeric `marketCap`

A bounded 10-item sample contained 9 buys and 1 sell. All 10 items contained a
string transaction hash, finite USD amount, and finite event market cap.

The current-account Following endpoint returns an array with:

- `user_id`
- `username`
- `profile_image`
- `address`
- `kind`
- `followers`

These endpoints depend on the page's existing authenticated session. The
extension must never read, persist, or forward that session material.

## Confirmed real-time page transport

The official frontend subscribes to the NATS Core subject:

```text
followingFeed.user.{viewerUserId}
```

The frontend handler accepts only messages whose discriminator is
`type === "position"`, then uses a callout identifier to refresh the Following
callout feed. The frontend's current Following feed constant requests:

```text
callout,update,reply,quote,repost
```

It does not request `trade` in that page feed. The only other user-related NATS
Core subscription found in the official frontend is an account balance subject;
it is not a followed-trader transaction feed and does not provide the confirmed
trade contract above.

## Controlled one-request-per-second test

On 2026-09-09, the authenticated page executed a bounded 60-second test against
the trade alerts endpoint. The test requested one page per second, stopped early
on `403` or `429`, and retained only aggregate status, latency, response-count,
and `Retry-After` observations. It did not retain response bodies or identities.

- completed requests: 60 of 60
- status codes: 60 × `200`
- latency: 367 ms median, 477 ms p95, 492 ms maximum
- returned items: 10 minimum, 10 maximum
- `Retry-After`: absent
- `403`, `429`, and network failures: none

This result shows that the current authenticated endpoint tolerated one request
per second for one minute in this account and network context. It is not a
published rate-limit contract, does not establish long-duration tolerance, and
does not remove the need for backoff and cursor-based catch-up.

## Gate result

The required trade fields are confirmed from the authenticated Following alerts
endpoint. Paired buy/sell messages are **not exposed by the page's real-time
Following transport**, so position messages must not be presented as trades.

The product decision is to use the page's authenticated same-origin HTTP
endpoint at a target cadence of one request per second, with strict request
serialization, bounded cursor recovery, automatic backoff, and an initial
watermark that excludes pre-connection history. This path is approved for
implementation as **near-real-time**, not as a native stream or a guaranteed
one-second SLA.

The production parser is developed only against synthetic, redacted fixtures.
Authentication material and raw responses remain outside the extension
protocol, persistence, diagnostics, and test artifacts.
