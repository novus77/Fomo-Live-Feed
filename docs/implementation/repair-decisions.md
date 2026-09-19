# Repair decisions

## D-001: Repair scope

- Date: 2026-09-19
- Decision: Follow the repair plan RP00–RP13 before adding new product capabilities.
- Rationale: The supplied plan explicitly excludes Arc and requires reliable ingest, durable acknowledgements, identities, leases, and preferences to be corrected as coherent groups.
- Consequence: Arc support remains a separate feature request and is not implemented by this repair branch.

## D-002: Baseline package runner

- Date: 2026-09-19
- Decision: Do not let an incompatible global pnpm mutate or purge the existing dependency directory.
- Rationale: The repository declares pnpm 10.15.0, while the available command is pnpm 11.19.0 and its dependency preflight failed before project checks began.
- Consequence: Use the installed project binaries for read-only typecheck, test, build, and E2E validation until the locked package manager is available.

## D-003: Stable event identity

- Date: 2026-09-19
- Decision: Treat `sourceEventId` and `sourceTradeId` as source- and network-scoped aliases; do not infer cross-source identity from token, amount, trader, or timestamp similarity.
- Rationale: Fomo and Pump can independently emit the same raw identifier and legitimate concurrent trades frequently share visible attributes. Keeping two rows is recoverable; merging them is data loss.
- Consequence: Version 5 adds an alias table. New event rows and aliases are written in one Dexie transaction, and historical rows are backfilled during migration.

## D-004: Source-scoped read eligibility

- Date: 2026-09-19
- Decision: Determine read eligibility from the active surface owner, the current source filter, and the health of each visible provenance source.
- Rationale: A merged Fomo/Pump row can be visible through only one selected source. A healthy Pump session must not mark a Fomo-only cached row read, and the inverse must also hold.
- Consequence: `canMarkEventRead` is a pure selector used by the Side Panel; the hook remains responsible for confirmation-only local `readAt` updates and duplicate suppression.
