import { describe, expect, it } from 'vitest';

import { inferCommonOpinionLanguage } from '../../src/translation/local-language-hint';

describe('inferCommonOpinionLanguage', () => {
  it('recognizes an English KOL opinion without a detector model', () => {
    expect(inferCommonOpinionLanguage('This is the official token and buyers are accumulating.')).toBe('en');
  });

  it('recognizes a Chinese KOL opinion without a detector model', () => {
    expect(inferCommonOpinionLanguage('这是官方代币，最近有很多钱包在持续买入。')).toBe('zh');
  });

  it('returns undefined for short or ambiguous content', () => {
    expect(inferCommonOpinionLanguage('GM')).toBeUndefined();
    expect(inferCommonOpinionLanguage('1234 🚀')).toBeUndefined();
  });
});
