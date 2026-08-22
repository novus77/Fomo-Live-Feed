import { useLocale } from '../i18n/LocaleProvider';
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
  state: Extract<PopupConnectionState, 'login-required' | 'offline' | 'reconnecting'> | 'refresh-required';
  openLink?: (url: URL) => void;
}

export function ConnectionBanner(props: ConnectionBannerProps) {
  const { state, openLink } = props;
  const { translate } = useLocale();

  const open =
    openLink ??
    ((url: URL) => {
      window.open(url.href, '_blank', 'noopener,noreferrer');
    });

  if (state === 'login-required') {
    return (
      <section className="connection-banner connection-banner-login">
        <h2 className="connection-banner-title">{translate('banner.loginTitle')}</h2>
        <p className="connection-banner-body">{translate('banner.loginBody')}</p>
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
          {translate('banner.openFomo')}
        </a>
      </section>
    );
  }

  if (state === 'reconnecting') {
    return (
      <section className="connection-banner connection-banner-offline">
        <h2 className="connection-banner-title">{translate('banner.reconnectingTitle')}</h2>
        <p className="connection-banner-body">{translate('banner.reconnectingBody')}</p>
      </section>
    );
  }

  if (state === 'refresh-required') {
    return (
      <section className="connection-banner connection-banner-refresh">
        <h2 className="connection-banner-title">{translate('banner.refreshTitle')}</h2>
        <p className="connection-banner-body">{translate('banner.refreshBody')}</p>
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
          {translate('banner.openFomo')}
        </a>
      </section>
    );
  }

  return (
    <section className="connection-banner connection-banner-offline">
      <h2 className="connection-banner-title">{translate('banner.offlineTitle')}</h2>
      <p className="connection-banner-body">{translate('banner.offlineBody')}</p>
    </section>
  );
}
