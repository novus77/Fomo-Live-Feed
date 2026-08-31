import { describe, expect, it, vi } from 'vitest';

import { installBuyAudioListener } from '../../src/offscreen/buy-audio-controller';

describe('installBuyAudioListener', () => {
  it('owns one audio element and restarts it for every valid command', () => {
    const pause = vi.fn();
    const play = vi.fn(async () => undefined);
    const audio = { pause, play, preload: '', currentTime: 9 };
    const createAudio = vi.fn(() => audio);
    let listener: ((message: unknown) => undefined) | undefined;
    const addListener = vi.fn((value: typeof listener) => { listener = value; });

    installBuyAudioListener({
      getURL: (path) => `chrome-extension://extension-id${path}`,
      addListener,
      createAudio,
    });

    expect(createAudio).toHaveBeenCalledOnce();
    expect(createAudio).toHaveBeenCalledWith(
      'chrome-extension://extension-id/audio/buy-alert.wav',
    );
    expect(audio.preload).toBe('auto');

    listener?.({ protocolVersion: 1, type: 'sound.playBuy' });
    listener?.({ protocolVersion: 1, type: 'sound.playBuy' });

    expect(pause).toHaveBeenCalledTimes(2);
    expect(audio.currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('ignores invalid, unrelated, and open-shaped messages', () => {
    const audio = {
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
      preload: '',
      currentTime: 0,
    };
    let listener: ((message: unknown) => undefined) | undefined;

    installBuyAudioListener({
      getURL: (path) => path,
      addListener: (value) => { listener = value; },
      createAudio: () => audio,
    });

    listener?.({ protocolVersion: 1, type: 'activity.broadcast', payload: { event: {} } });
    listener?.({ protocolVersion: 1, type: 'sound.playBuy', payload: {} });
    listener?.({ type: 'sound.playBuy' });

    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();
  });

  it('swallows playback rejection', async () => {
    const play = vi.fn(() => Promise.reject(new Error('blocked')));
    const reportFailure = vi.fn(async () => undefined);
    let listener: ((message: unknown) => undefined) | undefined;

    installBuyAudioListener({
      getURL: (path) => path,
      addListener: (value) => { listener = value; },
      createAudio: () => ({ pause: vi.fn(), play, preload: '', currentTime: 0 }),
      reportFailure,
    });

    expect(() => listener?.({ protocolVersion: 1, type: 'sound.playBuy' })).not.toThrow();
    await Promise.resolve();
    expect(reportFailure).toHaveBeenCalledOnce();
  });
});
