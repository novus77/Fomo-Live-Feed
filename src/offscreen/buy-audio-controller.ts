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
  recordPlayback?(): void;
  reportFailure?(): void | Promise<unknown>;
}

export function installBuyAudioListener(
  dependencies: BuyAudioListenerDependencies,
): void {
  const audio = dependencies.createAudio(
    dependencies.getURL('/audio/buy-alert.wav'),
  );
  audio.preload = 'auto';

  const reportFailure = () => {
    try {
      void Promise.resolve(dependencies.reportFailure?.()).catch(() => undefined);
    } catch {
      // Diagnostics are best effort and must not escape playback.
    }
  };

  dependencies.addListener((candidate) => {
    const parsed = parseExtensionMessage(candidate);

    if (!parsed.ok || parsed.message.type !== 'sound.playBuy') {
      return undefined;
    }

    try {
      dependencies.recordPlayback?.();
      audio.pause();
      audio.currentTime = 0;
      void audio.play().catch(reportFailure);
    } catch {
      reportFailure();
    }
    return undefined;
  });
}
