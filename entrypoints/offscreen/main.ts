import { installBuyAudioListener } from '../../src/offscreen/buy-audio-controller';

declare global {
  var __fomoBuyAudioPlaybackCount: number | undefined;
}

globalThis.__fomoBuyAudioPlaybackCount = 0;

installBuyAudioListener({
  getURL: (path) => browser.runtime.getURL(path),
  addListener: (listener) => browser.runtime.onMessage.addListener(listener),
  createAudio: (source) => new Audio(source),
  recordPlayback: () => {
    globalThis.__fomoBuyAudioPlaybackCount =
      (globalThis.__fomoBuyAudioPlaybackCount ?? 0) + 1;
  },
  reportFailure: () => browser.runtime.sendMessage({
    protocolVersion: 1,
    type: 'diagnostics.record',
    payload: {
      code: 'audio_playback_failure',
      messageType: 'sound.playBuy',
    },
  }),
});
