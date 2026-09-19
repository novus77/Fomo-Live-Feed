import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import { mutateAnnotation, mutateSettings, type PopupRuntimeLike } from '../../src/popup/popup-io';

describe('mutateSettings', () => {
  it('retries a lost acknowledgement with the same mutation ID', async () => {
    const sent: unknown[] = [];
    const runtime: PopupRuntimeLike = {
      sendMessage: vi.fn(async (message: unknown) => {
        sent.push(message);
        return sent.length === 1
          ? undefined
          : { ok: true, settings: { ...DEFAULT_SETTINGS, uiTheme: 'light' } };
      }),
      onMessage: { addListener() {}, removeListener() {} },
    };

    await expect(mutateSettings(runtime, { uiTheme: 'light' })).resolves.toMatchObject({
      uiTheme: 'light',
    });
    expect(sent).toHaveLength(2);
    expect((sent[0] as { payload: { mutationId?: string } }).payload.mutationId)
      .toEqual((sent[1] as { payload: { mutationId?: string } }).payload.mutationId);
  });
});

describe('mutateAnnotation', () => {
  it('retries a lost acknowledgement with the same mutation ID', async () => {
    const sent: unknown[] = [];
    const runtime: PopupRuntimeLike = {
      sendMessage: vi.fn(async (message: unknown) => {
        sent.push(message);
        return sent.length === 1
          ? undefined
          : {
            ok: true,
            annotation: { traderId: 'trader-1', label: 'Momentum', updatedAt: 1_800_000_000_000 },
          };
      }),
      onMessage: { addListener() {}, removeListener() {} },
    };

    await expect(mutateAnnotation(runtime, {
      traderId: 'trader-1', update: { label: 'Momentum' }, at: 1_800_000_000_000,
    })).resolves.toMatchObject({ label: 'Momentum' });
    expect((sent[0] as { payload: { mutationId?: string } }).payload.mutationId)
      .toEqual((sent[1] as { payload: { mutationId?: string } }).payload.mutationId);
  });
});
