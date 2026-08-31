import { describe, expect, it, vi } from 'vitest';

import { createOffscreenBuyAudioPlayer } from '../../src/background/offscreen-audio';

function createChrome(existingContexts: unknown[] = []) {
  const getContexts = vi.fn(async () => existingContexts);
  const createDocument = vi.fn(async () => undefined);
  const sendMessage = vi.fn(async () => undefined);
  const chrome = {
    runtime: {
      getContexts,
      getURL: vi.fn((path: string) => `chrome-extension://extension-id/${path}`),
      sendMessage,
    },
    offscreen: { createDocument },
  };

  return { chrome, getContexts, createDocument, sendMessage };
}

describe('createOffscreenBuyAudioPlayer', () => {
  it('creates one offscreen document for concurrent playback requests and sends each command', async () => {
    const { chrome, createDocument, sendMessage } = createChrome();
    const player = createOffscreenBuyAudioPlayer(chrome);

    await Promise.all([player.playBuy(), player.playBuy()]);

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledWith({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play the user-enabled live buy alert.',
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith({
      protocolVersion: 1,
      type: 'sound.playBuy',
    });
  });

  it('reuses an existing offscreen document', async () => {
    const { chrome, getContexts, createDocument, sendMessage } = createChrome([{}]);
    const player = createOffscreenBuyAudioPlayer(chrome);

    await player.playBuy();

    expect(getContexts).toHaveBeenCalledWith({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: ['chrome-extension://extension-id/offscreen.html'],
    });
    expect(createDocument).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('isolates context, creation, and messaging failures', async () => {
    const onFailure = vi.fn();
    const first = createChrome();
    first.getContexts.mockRejectedValueOnce(new Error('context failed'));
    await expect(createOffscreenBuyAudioPlayer(first.chrome, onFailure).playBuy())
      .resolves.toBeUndefined();

    const second = createChrome();
    second.createDocument.mockRejectedValueOnce(new Error('create failed'));
    await expect(createOffscreenBuyAudioPlayer(second.chrome, onFailure).playBuy())
      .resolves.toBeUndefined();

    const third = createChrome([{}]);
    third.sendMessage.mockRejectedValueOnce(new Error('send failed'));
    await expect(createOffscreenBuyAudioPlayer(third.chrome, onFailure).playBuy())
      .resolves.toBeUndefined();

    expect(onFailure).toHaveBeenCalledTimes(3);
  });
});
