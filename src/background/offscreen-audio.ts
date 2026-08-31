import type { ExtensionMessage } from '../messaging/protocol';
import { PROTOCOL_VERSION } from '../messaging/protocol';

const OFFSCREEN_PATH = 'offscreen.html';

export interface OffscreenAudioChrome {
  runtime: {
    getContexts(query: {
      contextTypes: ['OFFSCREEN_DOCUMENT'];
      documentUrls: string[];
    }): Promise<unknown[]>;
    getURL(path: string): string;
    sendMessage(message: ExtensionMessage): Promise<unknown>;
  };
  offscreen: {
    createDocument(options: {
      url: string;
      reasons: ['AUDIO_PLAYBACK'];
      justification: string;
    }): Promise<void>;
  };
}

export interface BuyAudioPlayer {
  playBuy(): Promise<void>;
}

export type AudioPlaybackFailureReporter = () => void;

export function createOffscreenBuyAudioPlayer(
  chrome: OffscreenAudioChrome,
  onFailure: AudioPlaybackFailureReporter = () => undefined,
): BuyAudioPlayer {
  let creationPromise: Promise<void> | undefined;

  const reportFailure = () => {
    try {
      onFailure();
    } catch {
      // Diagnostics must remain best effort too.
    }
  };

  const ensureDocument = (): Promise<void> => {
    if (creationPromise !== undefined) {
      return creationPromise;
    }

    creationPromise = (async () => {
      const documentUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [documentUrl],
      });

      if (contexts.length === 0) {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_PATH,
          reasons: ['AUDIO_PLAYBACK'],
          justification: 'Play the user-enabled live buy alert.',
        });
      }
    })().finally(() => {
      creationPromise = undefined;
    });

    return creationPromise;
  };

  return {
    async playBuy(): Promise<void> {
      try {
        await ensureDocument();
        await chrome.runtime.sendMessage({
          protocolVersion: PROTOCOL_VERSION,
          type: 'sound.playBuy',
        });
      } catch {
        reportFailure();
      }
    },
  };
}
