import type { TradeEventV1 } from '../domain/activity';
import type { LocalSettingsV5 } from '../domain/settings';
import type { BuyAudioPlayer } from './offscreen-audio';

export interface LiveBuyNotifier {
  notify(event: TradeEventV1): void;
}

export interface LiveBuyNotifierDependencies {
  preferences: {
    getSettings(): Promise<LocalSettingsV5>;
  };
  audio: BuyAudioPlayer;
  onFailure?: () => void;
}

export function createLiveBuyNotifier(
  dependencies: LiveBuyNotifierDependencies,
): LiveBuyNotifier {
  const reportFailure = () => {
    try {
      dependencies.onFailure?.();
    } catch {
      // Diagnostics must never escape the best-effort side effect.
    }
  };

  return {
    notify(event): void {
      if (event.action !== 'buy') {
        return;
      }

      void dependencies.preferences.getSettings()
        .then(async (settings) => {
          if (settings.notifications.soundEnabled) {
            await dependencies.audio.playBuy();
          }
        })
        .catch(reportFailure);
    },
  };
}
