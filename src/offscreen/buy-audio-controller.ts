import { parseExtensionMessage } from '../messaging/protocol';

interface AudioLike {
  preload: string;
  currentTime: number;
  pause(): void;
  play(): Promise<unknown>;
}

export interface BuyAudioListenerDependencies {
  getURL(path: '/audio/buy-alert.wav'): string;
  addListener(listener: (message: unknown) => undefined): void;
  createAudio(source: string): AudioLike;
  reportFailure?(): void | Promise<unknown>;
}

export function installBuyAudioListener(
  dependencies: BuyAudioListenerDependencies,
): void {
  const audio = dependencies.createAudio(
    dependencies.getURL('/audio/buy-alert.wav'),
  );
  audio.preload = 'auto';

  dependencies.addListener((candidate) => {
    const parsed = parseExtensionMessage(candidate);

    if (!parsed.ok || parsed.message.type !== 'sound.playBuy') {
      return undefined;
    }

    audio.pause();
    audio.currentTime = 0;
    void audio.play().catch(() => {
      try {
        void Promise.resolve(dependencies.reportFailure?.()).catch(() => undefined);
      } catch {
        // Diagnostics are best effort and must not escape playback.
      }
    });
    return undefined;
  });
}
