import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Repository-owned alert: a deterministic 180 ms two-tone sine chime.
// The generated PCM WAV is distributable with this repository and requires
// no downloaded or third-party audio source.
const sampleRate = 16_000;
const durationSeconds = 0.18;
const sampleCount = Math.floor(sampleRate * durationSeconds);
const dataSize = sampleCount * 2;
const wav = Buffer.alloc(44 + dataSize);

wav.write('RIFF', 0);
wav.writeUInt32LE(36 + dataSize, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(dataSize, 40);

for (let index = 0; index < sampleCount; index += 1) {
  const time = index / sampleRate;
  const frequency = time < 0.09 ? 880 : 1_176;
  const attack = Math.min(1, time / 0.008);
  const release = Math.min(1, (durationSeconds - time) / 0.04);
  const envelope = attack * release;
  const sample = Math.sin(2 * Math.PI * frequency * time) * envelope * 0.22;
  wav.writeInt16LE(Math.round(sample * 32_767), 44 + index * 2);
}

const outputPath = resolve('public/audio/buy-alert.wav');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wav);
