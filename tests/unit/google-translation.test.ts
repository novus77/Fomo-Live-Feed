import { describe, expect, it, vi } from 'vitest';

import { GoogleTranslationGateway } from '../../src/translation/google-translation';

describe('GoogleTranslationGateway', () => {
  it('invokes fetch with the browser global receiver', async () => {
    const fetchImpl = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(new Response(JSON.stringify([[['买入']]]), { status: 200 }));
    });
    const gateway = new GoogleTranslationGateway({ fetchImpl });

    await expect(gateway.translate('buy', 'zh')).resolves.toBe('买入');
  });

  it('uses the same Google Translate endpoint as j7 and caches a translated opinion', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([[["买入", "buy this"]]]), { status: 200 }));
    const gateway = new GoogleTranslationGateway({ fetchImpl });

    await expect(gateway.translate('buy this', 'zh')).resolves.toBe('买入');
    await expect(gateway.translate('buy this', 'zh')).resolves.toBe('买入');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls.at(0) as [RequestInfo | URL, RequestInit] | undefined ?? [];
    expect(String(url)).toContain('https://translate.googleapis.com/translate_a/single?client=gtx');
    expect(String(url)).toContain('tl=zh');
    expect(init).toMatchObject({ method: 'POST' });
  });
});
