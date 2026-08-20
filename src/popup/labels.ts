import type { ActivityAction, ChainKey } from '../domain/activity';
import { ACTION_LABELS, CHAIN_LABELS } from '../overlay/presentation';

/**
 * Popup display vocabulary (plan Task 9, SHOULD-FIX 5).
 *
 * The closed-set chain/action LABELS now live in the ONE shared presentation
 * module (src/overlay/presentation.tsx) consumed by both the popup card and
 * the overlay toast; this module re-exports them for the filter bar and keeps
 * the ordered key lists the dropdowns need. Importing from here (rather than
 * redeclaring) keeps every surface on the same vocabulary.
 */
export { ACTION_LABELS, CHAIN_LABELS };

export const CHAIN_KEYS: readonly ChainKey[] = [
  'solana',
  'ethereum',
  'bsc',
  'base',
  'monad',
  'unknown',
];

export const ACTIONS: readonly ActivityAction[] = [
  'buy',
  'sell',
  'withdraw',
  'transfer',
  'thesis',
];
