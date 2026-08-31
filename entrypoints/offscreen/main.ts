import { installBuyAudioListener } from '../../src/offscreen/buy-audio-controller';

installBuyAudioListener({
  getURL: (path) => browser.runtime.getURL(path),
  addListener: (listener) => browser.runtime.onMessage.addListener(listener),
  createAudio: (source) => new Audio(source),
  reportFailure: () => browser.runtime.sendMessage({
    protocolVersion: 1,
    type: 'diagnostics.record',
    payload: {
      code: 'audio_playback_failure',
      messageType: 'sound.playBuy',
    },
  }),
});
