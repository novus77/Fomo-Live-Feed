import { PumpRecentKeys, pumpTransactionKey } from '../../src/pump/watermark';

describe('PumpRecentKeys', () => {
  it('restores unique keys and evicts them in FIFO order', () => {
    const keys = new PumpRecentKeys(['a', 'b', 'a'], 3);

    keys.add('c');
    keys.add('d');

    expect(keys.values()).toEqual(['b', 'c', 'd']);
    expect(keys.has('a')).toBe(false);
    expect(keys.has('d')).toBe(true);
  });

  it('refreshes an existing key without growing or reordering the window', () => {
    const keys = new PumpRecentKeys(['a', 'b'], 2);

    keys.add('a');

    expect(keys.values()).toEqual(['a', 'b']);
  });

  it('builds a bounded chain and transaction key', () => {
    expect(pumpTransactionKey(1399811149, 'tx-1')).toBe('1399811149:tx-1');
    expect(() => pumpTransactionKey(1, '')).toThrow(TypeError);
    expect(() => pumpTransactionKey(-1, 'tx')).toThrow(TypeError);
  });
});
