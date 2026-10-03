# Surface filters and Pump gap repair

Scope: repair two findings from the installed candidate without merging, publishing, changing permissions, or deleting history/settings.

## Evidence

- Selecting Pump in Side Panel and returning from PiP restores All. Each feed mounts with `DEFAULT_FILTERS`; only chain selection is durable.
- Native worker diagnostics reported a recent unresolved gap with `reason: unspecified`, a populated checkpoint, and an active catch-up status. The old implementation discards the catch-up terminal reason before persisting it. The original gap cause cannot be reconstructed from this snapshot.

## Batch 1: preserve the feed view across surfaces

1. Add failing store tests for bounded session snapshots, serialized writes, hydration ordering, and failure/retry.
2. Add a component remount regression test and ensure no initial history query occurs before hydration.
3. Inject a session-only store into Side Panel and the shared floating/PiP dependency boundary. Preserve source, actions, and financial ranges; keep chains in existing preferences.
4. Flush pending writes before surface handoffs. Do not insert an asynchronous operation before requesting PiP user activation.
5. Checkpoint: focused tests and typecheck.

## Batch 2: accurate Pump gap diagnostics and empty-response handling

1. Add failing regressions for missing watermark terminal reasons and an empty newest page with no rejected records/cursor.
2. Preserve the exact bounded reason through polling, page bridge, runtime validation, storage, and UI tooltip. Accept old messages without a reason.
3. Treat a clean, empty newest response as no new activity without advancing the checkpoint or inventing a gap. Empty catch-up pages and rejected/partial pages still retain conservative gap semantics.
4. Retain genuine unresolved gaps after live delivery resumes; never imply historical completeness merely because new trades arrive.
5. Checkpoint: focused tests, full suite, typecheck, production build; inspect a fresh native diagnostic if available. Record remaining upstream limitations explicitly.

## Final verification

Reinstall the candidate locally with unchanged permissions, verify source selection in both directions, and restore the user's original filters/locale/surface. Do not commit, merge, push, or publish in this task.

## Checkpoints

- Batch 1 complete: store queue/validation, hydration and remount, coordinator flush, and PiP failure-path regressions pass. Native handoffs preserve Pump and Fomo selection in both directions.
- Batch 2 code repairs complete: clean-empty head handling and terminal reason propagation pass, including the worker's persistence after later live status. Genuine unresolved gaps remain visible.
- Final verification complete: 108 files / 1,966 tests, typecheck, build, and whitespace checks pass; all 30 installed production files match. No new gap occurred during the short native check. The original historical trigger remains unproven because the old collector dropped its reason; no historical completeness claim is made.
- Candidate is installed locally only. No commit, merge, push, or publication performed.
