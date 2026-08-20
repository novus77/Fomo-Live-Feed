import type { PopupConnectionState } from './event-query';

/**
 * Non-connected popup banners (plan Task 9 Step 3, spec section 8).
 *
 * The connected states (empty vs with-history) are rendered by the feed;
 * this component owns the three failure states: login-required, reconnecting
 * (BLOCKING 2: authenticated socket closed, waiting for the page's reconnect
 * behavior), and Fomo-tab-offline. The login banner links to the fixed Fomo
 * origin - the extension never attempts to bypass authentication.
 *
 * In EVERY non-connected state the stored history renders READ-ONLY below
 * the banner (BLOCKING 1): rows are shown but never marked read, so the
 * copy below is truthful.
 */

/** Fixed, trusted navigation target; never built from user input. */
const FOMO_HOME_URL = new URL('https://fomo.family/');

export interface ConnectionBannerProps {
  state: Extract<PopupConnectionState, 'login-required' | 'offline' | 'reconnecting'>;
  openLink?: (url: URL) => void;
}

export function ConnectionBanner(props: ConnectionBannerProps) {
  const { state, openLink } = props;

  const open =
    openLink ??
    ((url: URL) => {
      window.open(url.href, '_blank', 'noopener,noreferrer');
    });

  if (state === 'login-required') {
    return (
      <section className="connection-banner connection-banner-login" role="status">
        <h2 className="connection-banner-title">Log in to Fomo</h2>
        <p className="connection-banner-body">
          Open Fomo and log in to see live trader activity. Your existing
          Fomo session powers this extension - it never asks for credentials.
          History already stored here stays available below (read-only).
        </p>
        <a
          className="connection-banner-action"
          href={FOMO_HOME_URL.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            event.preventDefault();
            open(FOMO_HOME_URL);
          }}
        >
          Open Fomo
        </a>
      </section>
    );
  }

  if (state === 'reconnecting') {
    return (
      <section className="connection-banner connection-banner-offline" role="status">
        <h2 className="connection-banner-title">Fomo reconnecting</h2>
        <p className="connection-banner-body">
          Your authenticated Fomo socket closed and the page is reconnecting.
          Live activity resumes automatically. History already stored here
          stays available below (read-only).
        </p>
      </section>
    );
  }

  return (
    <section className="connection-banner connection-banner-offline" role="status">
      <h2 className="connection-banner-title">Fomo tab offline</h2>
      <p className="connection-banner-body">
        Keep an authenticated Fomo tab open to collect live activity.
        History already stored here stays available below (read-only).
      </p>
    </section>
  );
}
