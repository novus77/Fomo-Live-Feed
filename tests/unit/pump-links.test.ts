import { buildPumpTokenUrl } from '../../src/navigation/pump-links';

const SOLANA_MINT = 'So11111111111111111111111111111111111111112';

describe('Pump token navigation', () => {
  it('builds only the allowlisted Pump Solana coin route', () => {
    expect(buildPumpTokenUrl('solana', SOLANA_MINT)?.href).toBe(
      `https://pump.fun/coin/${SOLANA_MINT}`,
    );
    expect(buildPumpTokenUrl('bsc', '0x020bfc650a365f8bb26819deaabf3e21291018b4')).toBeNull();
    expect(buildPumpTokenUrl('solana', 'javascript:alert(1)')).toBeNull();
  });
});
