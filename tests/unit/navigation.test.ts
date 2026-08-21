import { describe, expect, it } from 'vitest';

import type { ChainKey } from '../../src/domain/activity';
import {
  EVM_ADDRESS_PATTERN,
  inferChainFromTokenAddress,
  MAX_BASE58_ADDRESS_LENGTH,
  MAX_EVM_ADDRESS_LENGTH,
  shortenContractAddress,
  validateContractAddress,
} from '../../src/navigation/contract-address';
import {
  buildFomoProfileUrl,
  buildFomoTokenUrl,
  MAX_FOMO_HANDLE_LENGTH,
} from '../../src/navigation/fomo-links';

const EVM_ADDRESS = '0x020bfc650a365f8bb26819deaabf3e21291018b4';
const EVM_ADDRESS_UPPER = '0x020BFC650A365F8BB26819DEAABF3E21291018B4';
const EVM_ADDRESS_MIXED = '0x020Bfc650A365F8bB26819DeAaBF3E21291018B4';

const SOLANA_ADDRESS = 'So11111111111111111111111111111111111111112';
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_ZERO_BYTES = '11111111111111111111111111111111';
const SOLANA_THIRTY_THREE_BYTES = 'JNArUumxYJcSQpbuxuroRZtcSMVLcy5WbYGt14SRm1Fv';
const SOLANA_THIRTY_ONE_BYTES = 'thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE';

describe('validateContractAddress', () => {
  it.each(['ethereum', 'bsc', 'base', 'x-layer'] as const)(
    'accepts a mixed-case EVM address on %s and exposes a canonical lowercase form',
    (chain) => {
      expect(validateContractAddress(chain, EVM_ADDRESS_MIXED)).toEqual({
        ok: true,
        chain,
        canonical: EVM_ADDRESS,
      });
    },
  );

  it('compares EVM addresses checksum-insensitively through the canonical form', () => {
    expect(validateContractAddress('ethereum', EVM_ADDRESS)).toEqual({
      ok: true,
      chain: 'ethereum',
      canonical: EVM_ADDRESS,
    });
    expect(validateContractAddress('ethereum', EVM_ADDRESS_UPPER)).toEqual({
      ok: true,
      chain: 'ethereum',
      canonical: EVM_ADDRESS,
    });
    expect(validateContractAddress('ethereum', EVM_ADDRESS_MIXED)).toEqual({
      ok: true,
      chain: 'ethereum',
      canonical: EVM_ADDRESS,
    });
  });

  it.each([
    '0x',
    '0x020bfc650a365f8bb26819deaabf3e21291018b',
    '0x020bfc650a365f8bb26819deaabf3e21291018b40',
    '0x000000000000000000000000000000000000000000',
  ])('rejects EVM addresses with the wrong length: %s', (address) => {
    expect(validateContractAddress('ethereum', address)).toMatchObject({
      ok: false,
    });
  });

  it.each([
    '0x020bfc650a365f8bb26819deaabf3e21291018bg',
    '0x'.concat('g'.repeat(40)),
    '0x'.concat('Z'.repeat(40)),
    '0x020bfc650a365f8bb26819deaabf3e21291018b-',
    '0x020bfc650a365f8bb26819deaabf3e21291018b4!',
  ])('rejects EVM addresses containing non-hex characters: %s', (address) => {
    expect(validateContractAddress('ethereum', address)).toMatchObject({
      ok: false,
    });
  });

  it.each([
    '020bfc650a365f8bb26819deaabf3e21291018b4',
    '1x020bfc650a365f8bb26819deaabf3e21291018b4',
    'x020bfc650a365f8bb26819deaabf3e21291018b4',
    'x020bfc650a365f8bb26819deaabf3e21291018b4!',
  ])('rejects EVM addresses missing the canonical 0x prefix: %s', (address) => {
    expect(validateContractAddress('ethereum', address)).toMatchObject({
      ok: false,
    });
  });

  it('accepts an uppercase 0X prefix and canonicalizes it, matching normalize.ts', () => {
    expect(validateContractAddress('ethereum', EVM_ADDRESS_UPPER)).toEqual({
      ok: true,
      chain: 'ethereum',
      canonical: EVM_ADDRESS,
    });
  });

  it.each([SOLANA_ADDRESS, SOLANA_USDC, SOLANA_ZERO_BYTES])(
    'accepts a Solana address whose Base58 form decodes to exactly 32 bytes: %s',
    (address) => {
      expect(validateContractAddress('solana', address)).toEqual({
        ok: true,
        chain: 'solana',
        canonical: address,
      });
    },
  );

  it.each([
    '0'.concat(SOLANA_ADDRESS.slice(1)),
    'O'.concat(SOLANA_ADDRESS.slice(1)),
    'I'.concat(SOLANA_ADDRESS.slice(1)),
    'l'.concat(SOLANA_ADDRESS.slice(1)),
  ])('rejects Solana addresses containing excluded Base58 characters: %s', (address) => {
    expect(validateContractAddress('solana', address)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Base58'),
    });
  });

  it.each([
    SOLANA_THIRTY_THREE_BYTES,
    SOLANA_THIRTY_ONE_BYTES,
    '1'.repeat(31),
    '1'.repeat(33),
    '',
  ])('rejects Solana addresses that do not decode to exactly 32 bytes: %s', (address) => {
    expect(validateContractAddress('solana', address)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('32 bytes'),
    });
  });

  it('rejects the unknown chain even for a valid-looking address', () => {
    expect(validateContractAddress('unknown', EVM_ADDRESS)).toMatchObject({
      ok: false,
      reason: 'unknown-chain',
    });
    expect(validateContractAddress('unknown', SOLANA_ADDRESS)).toMatchObject({
      ok: false,
      reason: 'unknown-chain',
    });
  });

  it('rejects robinhood addresses as unknown-chain because the address family is unconfirmed', () => {
    // docs/evidence/fomo-network-catalog.md: robinhood (900001) is
    // deliberately never assumed EVM or Solana, so every address is rejected
    // and can never be copied or linked.
    expect(validateContractAddress('robinhood', EVM_ADDRESS)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unknown-chain'),
    });
    expect(validateContractAddress('robinhood', SOLANA_ADDRESS)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unknown-chain'),
    });
  });

  it('rejects chains outside the ChainKey union instead of guessing EVM', () => {
    expect(validateContractAddress('tron' as ChainKey, EVM_ADDRESS)).toMatchObject({
      ok: false,
    });
  });

  it('rejects non-string address inputs', () => {
    expect(
      validateContractAddress('ethereum', 42 as unknown as string),
    ).toMatchObject({ ok: false });
    expect(
      validateContractAddress('solana', null as unknown as string),
    ).toMatchObject({ ok: false });
  });

  it('rejects a 1,000,000-character Solana address immediately instead of decoding it', () => {
    // 'z' is the highest-value Base58 digit, so decoding it is the O(n^2)
    // worst case (~190s for 1M characters on the unfixed decoder). The length
    // pre-filter must reject it before any decoding work begins.
    const huge = 'z'.repeat(1_000_000);
    const startedAt = performance.now();
    const result = validateContractAddress('solana', huge);
    const elapsedMs = performance.now() - startedAt;

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('at most'),
    });
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('rejects any Solana address longer than the Base58 character bound before decoding', () => {
    expect(
      validateContractAddress('solana', '1'.repeat(MAX_BASE58_ADDRESS_LENGTH + 1)),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining(String(MAX_BASE58_ADDRESS_LENGTH)),
    });
  });

  it('still routes in-bounds inputs through the decoded-32-byte rule', () => {
    const result = validateContractAddress(
      'solana',
      '1'.repeat(MAX_BASE58_ADDRESS_LENGTH),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('32 bytes'),
    });
  });

  it('rejects a 1,000,000-character EVM address before pattern matching', () => {
    const huge = '0x'.concat('a'.repeat(1_000_000));
    const startedAt = performance.now();
    const result = validateContractAddress('ethereum', huge);
    const elapsedMs = performance.now() - startedAt;

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('at most'),
    });
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('rejects any EVM address longer than the 42-character bound', () => {
    expect(
      validateContractAddress(
        'ethereum',
        '0x'.concat('a'.repeat(MAX_EVM_ADDRESS_LENGTH - 1)),
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining(String(MAX_EVM_ADDRESS_LENGTH)),
    });
  });

  it('exports the canonical EVM address regex used by the validator', () => {
    expect(EVM_ADDRESS_PATTERN.test(EVM_ADDRESS)).toBe(true);
    expect(EVM_ADDRESS_PATTERN.test(EVM_ADDRESS_UPPER)).toBe(true);
    expect(EVM_ADDRESS_PATTERN.test('0x'.concat('g'.repeat(40)))).toBe(false);
  });
});

describe('shortenContractAddress', () => {
  it('shortens a validated EVM address to the 0x1234…abcd display form', () => {
    const result = validateContractAddress('ethereum', EVM_ADDRESS_MIXED);

    expect(result).toEqual({ ok: true, chain: 'ethereum', canonical: EVM_ADDRESS });

    if (result.ok) {
      expect(shortenContractAddress(result)).toBe('0x020b…18b4');
    }
  });

  it('honors custom head and tail lengths', () => {
    const result = validateContractAddress('ethereum', EVM_ADDRESS);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(shortenContractAddress(result, { head: 10, tail: 6 })).toBe(
        '0x020bfc65…1018b4',
      );
    }
  });

  it('returns the full address when head and tail already cover it', () => {
    const result = validateContractAddress('ethereum', EVM_ADDRESS);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(shortenContractAddress(result, { head: 30, tail: 30 })).toBe(
        EVM_ADDRESS,
      );
    }
  });

  it('shortens a validated Solana address with the same rule', () => {
    const result = validateContractAddress('solana', SOLANA_ADDRESS);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(shortenContractAddress(result)).toBe('So1111…1112');
    }
  });

  it('refuses to shorten data that was not produced by validation', () => {
    expect(() =>
      shortenContractAddress({ chain: 'ethereum', canonical: 'not-an-address' }),
    ).toThrowError(TypeError);
    expect(() =>
      shortenContractAddress({ chain: 'unknown', canonical: EVM_ADDRESS }),
    ).toThrowError(TypeError);
    expect(() =>
      shortenContractAddress({ chain: 'solana', canonical: SOLANA_THIRTY_THREE_BYTES }),
    ).toThrowError(TypeError);
  });

  it('rejects invalid shortening options', () => {
    const result = validateContractAddress('ethereum', EVM_ADDRESS);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(() => shortenContractAddress(result, { head: 0 })).toThrowError(
        TypeError,
      );
      expect(() => shortenContractAddress(result, { tail: -1 })).toThrowError(
        TypeError,
      );
      expect(() => shortenContractAddress(result, { head: 1.5 })).toThrowError(
        TypeError,
      );
    }
  });
});

describe('inferChainFromTokenAddress', () => {
  it.each([
    [SOLANA_ADDRESS, 'solana'],
    [SOLANA_USDC, 'solana'],
    ['8mCt5QnoD4izGiBncq4C2kkzPDqJNvHY9twnxiAapump', 'solana'],
  ])('identifies %s as solana', (address, chain) => {
    expect(inferChainFromTokenAddress(address)).toBe(chain);
  });

  it.each([
    [EVM_ADDRESS],
    ['0x020bfc650a365f8bb26819deaabf3e21291018b'],
    ['not-an-address'],
    [SOLANA_THIRTY_ONE_BYTES],
    [SOLANA_THIRTY_THREE_BYTES],
    [''],
    [null as unknown as string],
  ])('returns null for ambiguous or non-Solana address: %s', (address) => {
    expect(inferChainFromTokenAddress(address)).toBeNull();
  });
});

describe('buildFomoTokenUrl', () => {
  it('builds an HTTPS fomo.family token URL from a valid EVM address', () => {
    const url = buildFomoTokenUrl('ethereum', EVM_ADDRESS_MIXED);

    expect(url).not.toBeNull();
    expect(url?.protocol).toBe('https:');
    expect(url?.origin).toBe('https://fomo.family');
    expect(url?.pathname).toBe('/token/ethereum/' + EVM_ADDRESS);
  });

  it('builds a token URL for a valid Solana address', () => {
    const url = buildFomoTokenUrl('solana', SOLANA_ADDRESS);

    expect(url?.protocol).toBe('https:');
    expect(url?.origin).toBe('https://fomo.family');
    expect(url?.pathname).toBe('/token/solana/' + SOLANA_ADDRESS);
  });

  it.each([
    ['ethereum', '0xnothex'],
    ['ethereum', ''],
    ['ethereum', '0x020bfc650a365f8bb26819deaabf3e21291018b'],
    ['unknown', EVM_ADDRESS],
    ['unknown', SOLANA_ADDRESS],
    ['solana', SOLANA_THIRTY_THREE_BYTES],
    ['solana', '0'.concat(SOLANA_ADDRESS.slice(1))],
    ['ethereum', 'javascript:alert(1)'],
    ['solana', 'javascript:alert(1)'],
    ['ethereum', 'data:text/html,evil'],
    ['ethereum', '//evil.com/x'],
    ['ethereum', 'https://evil.com/' + EVM_ADDRESS],
    ['bsc', '0x../../../../etc/passwd'],
  ] as const)(
    'returns null instead of throwing for invalid token input: %s %s',
    (chain, address) => {
      expect(buildFomoTokenUrl(chain, address)).toBeNull();
    },
  );

  it('never produces javascript:, data:, protocol-relative, or foreign URLs', () => {
    for (const address of [EVM_ADDRESS, EVM_ADDRESS_UPPER, SOLANA_ADDRESS, SOLANA_USDC]) {
      for (const url of [
        buildFomoTokenUrl('ethereum', address),
        buildFomoTokenUrl('solana', address),
        buildFomoTokenUrl('x-layer', address),
        buildFomoTokenUrl('base', address),
        buildFomoTokenUrl('bsc', address),
        // robinhood always fails validation (unknown-chain), so it never
        // produces a URL; the loop tolerates null.
        buildFomoTokenUrl('robinhood', address),
      ]) {
        if (url !== null) {
          expect(url.protocol).toBe('https:');
          expect(url.host).toBe('fomo.family');
          expect(url.href.startsWith('https://fomo.family/')).toBe(true);
        }
      }
    }
  });
});

describe('buildFomoProfileUrl', () => {
  it.each(['alpha', 'alpha_trader', 'Alpha_09', 'x'])(
    'builds a verified profile URL for an allowlisted handle: %s',
    (handle) => {
      const url = buildFomoProfileUrl(handle);

      expect(url).not.toBeNull();
      expect(url?.protocol).toBe('https:');
      expect(url?.origin).toBe('https://fomo.family');
      expect(url?.pathname).toBe('/user/' + handle);
      expect(url?.search).toBe('');
      expect(url?.hash).toBe('');
    },
  );

  it('pins profile URLs to the fixed fomo.family origin', () => {
    const url = buildFomoProfileUrl('alpha');

    expect(url?.href).toBe('https://fomo.family/user/alpha');
  });

  it.each([
    '',
    ' ',
    'a b',
    '..',
    '../evil',
    'a/../b',
    'a/b',
    'a?b',
    'a#b',
    'a\\b',
    'a\tb',
    'a\nb',
    '\u0000evil',
    'a%2Fb',
    'a'.repeat(MAX_FOMO_HANDLE_LENGTH + 1),
    'javascript:alert(1)',
    'data:text/html,x',
    '//evil.com/x',
    'https://evil.com',
    'alpha@evil.com',
    'a-b',
    'a.b',
    '🙂',
    'αlpha',
  ])('rejects an unsafe handle: %s', (handle) => {
    expect(buildFomoProfileUrl(handle)).toBeNull();
  });

  it('accepts a handle of exactly ' + MAX_FOMO_HANDLE_LENGTH + ' characters', () => {
    expect(buildFomoProfileUrl('a'.repeat(MAX_FOMO_HANDLE_LENGTH))).not.toBeNull();
    expect(buildFomoProfileUrl('a'.repeat(MAX_FOMO_HANDLE_LENGTH + 1))).toBeNull();
  });

  it('rejects non-string handles', () => {
    expect(buildFomoProfileUrl(42 as unknown as string)).toBeNull();
  });

  it('never throws for hostile inputs and always answers null', () => {
    const hostile = [
      'javascript:alert(1)',
      'data:text/html,x',
      '//evil.com/x',
      'https://evil.com',
      '..',
      'a'.repeat(1_000),
      '\u0000\u0001\u0002',
    ];

    for (const value of hostile) {
      expect(() => buildFomoTokenUrl('ethereum', value)).not.toThrow();
      expect(() => buildFomoTokenUrl('solana', value)).not.toThrow();
      expect(() => buildFomoProfileUrl(value)).not.toThrow();
    }
  });
});
