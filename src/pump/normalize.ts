import type { TradeEventV1 } from '../domain/activity';
import type { RawPumpTrade } from './raw-schema';
import { mapPumpChainId } from './network-map';

function safeHttpsUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username.length === 0 && url.password.length === 0
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function normalizePumpTrade(
  raw: RawPumpTrade,
  receivedAt: number,
  delivery: 'live' | 'recovered',
): TradeEventV1 {
  if (!Number.isInteger(receivedAt) || receivedAt < 0) {
    throw new TypeError('receivedAt must be a non-negative integer');
  }

  const occurredAt = Date.parse(raw.trade.timestamp);
  const traderAvatarUrl = safeHttpsUrl(raw.author.profileImage);
  const tokenImageUrl = safeHttpsUrl(raw.coinImage);

  return {
    schemaVersion: 1,
    id: `pump:${raw.chainId}:${raw.trade.tx}`,
    source: 'pump',
    sources: ['pump'],
    sourceTradeId: raw.trade.tx,
    traderId: raw.author.userId,
    traderHandle: raw.author.xUsername ?? raw.author.userName,
    traderName: raw.author.userName,
    ...(traderAvatarUrl !== undefined ? { traderAvatarUrl } : {}),
    chain: mapPumpChainId(raw.chainId),
    networkId: raw.chainId,
    tokenAddress: raw.coinMint,
    tokenSymbol: raw.symbol,
    ...(tokenImageUrl !== undefined ? { tokenImageUrl } : {}),
    action: raw.trade.isBuy ? 'buy' : 'sell',
    usdAmount: raw.trade.amountUsd,
    ...(raw.marketCap !== undefined ? { marketCap: raw.marketCap } : {}),
    ...(raw.trade.priceUsd !== undefined ? { price: raw.trade.priceUsd } : {}),
    occurredAt,
    receivedAt,
    delivery,
  };
}
