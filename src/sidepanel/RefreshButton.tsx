import type { ActivitySyncState } from '../background/activity-sync';
import type { MessageKey } from '../i18n/catalog';
import { useLocale } from '../i18n/LocaleProvider';

/**
 * Manual refresh / recovery-status control (recovery plan Task 5 Step 5).
 *
 * Renders an icon-only refresh button next to the settings toggle plus a live
 * `role="status"` region that mirrors the worker's ActivitySyncState:
 *
 * - idle / syncing / updated / current — the last recovery run's outcome;
 * - offline / login-required — the history backfill cannot run in this
 *   connection state (button disabled, mirroring the banner states);
 * - recovery-unavailable — the production history adapter is disabled
 *   (evidence gate), so the UI honestly reports that recovery cannot run;
 * - failed — the last run failed (retryable or permanent).
 *
 * The button is disabled only while a run is in flight or while the worker
 * cannot possibly recover history (offline / login-required), or when the
 * caller forces `disabled`.
 */
const STATUS_KEYS: Record<ActivitySyncState['status'], MessageKey> = {
  idle: 'header.refreshIdle',
  syncing: 'header.refreshing',
  updated: 'header.refreshUpdated',
  current: 'header.refreshCurrent',
  offline: 'connection.offline',
  'login-required': 'connection.loginRequired',
  'recovery-unavailable': 'header.refreshRecoveryUnavailable',
  failed: 'header.refreshFailed',
};

export interface RefreshButtonProps {
  state: ActivitySyncState;
  onRefresh: () => void;
  disabled?: boolean;
}

export function RefreshButton(props: RefreshButtonProps) {
  const { state, onRefresh, disabled } = props;
  const { translate } = useLocale();

  const syncing = state.status === 'syncing';
  const recoveryBlocked =
    state.status === 'offline' || state.status === 'login-required';
  const buttonDisabled = disabled === true || syncing || recoveryBlocked;

  return (
    <div className="refresh-control">
      <button
        type="button"
        className="refresh-button"
        aria-label={translate('header.refresh')}
        title={translate('header.refresh')}
        onClick={onRefresh}
        disabled={buttonDisabled}
      >
        <svg
          className={syncing ? 'refresh-icon refresh-icon-spin' : 'refresh-icon'}
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
        >
          <path
            fill="currentColor"
            d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z"
          />
        </svg>
      </button>
      <span
        className="visually-hidden"
        role="status"
      >
        {translate(STATUS_KEYS[state.status])}
      </span>
    </div>
  );
}
