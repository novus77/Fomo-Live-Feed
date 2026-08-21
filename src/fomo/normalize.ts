import type { ActivityAction, ChainKey, TradeEventV1 } from '../domain/activity';
import {
  EVM_ADDRESS_PATTERN,
  inferChainFromTokenAddress,
} from '../navigation/contract-address';
import { rawActivitySchema, type RawActivity } from './raw-schema';
import { mapNetworkId } from './network-map';

const ACTION_MAP: Readonly<Record<RawActivity['type'], ActivityAction>> = {
  swap_buy: 'buy',
  swap_sell: 'sell',
  swap_withdraw: 'withdraw',
  transfer_out: 'transfer',
  thesis: 'thesis',
};

function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS_PATTERN.test(value);
}

function normalizeEvmAddressCase(value: string): string {
  return isEvmAddress(value) ? value.toLowerCase() : value;
}

function extractThesis(comment: RawActivity['comment']): string | undefined {
  if (typeof comment === 'string') {
    return comment;
  }

  return comment?.comment;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );

  return Array.from(new Uint8Array(digest), (part) =>
    part.toString(16).padStart(2, '0'),
  ).join('');
}

async function resolveCanonicalId(raw: RawActivity, tokenAddress: string): Promise<{
  id: string;
  sourceEventId?: string;
}> {
  if (raw.id) {
    return {
      id: `fomo:${raw.id}`,
      sourceEventId: raw.id,
    };
  }

  const tokenFingerprint = normalizeEvmAddressCase(tokenAddress);

  const hash = await sha256Hex(
    [
      raw.userId,
      raw.type,
      String(raw.networkId),
      tokenFingerprint,
      raw.createdAt,
      String(raw.usdAmount ?? ''),
    ].join('|'),
  );

  return {
    id: `fomo:${hash}`,
  };
}

export async function normalizeActivity(
  payload: unknown,
  receivedAt: number,
): Promise<TradeEventV1> {
  if (!Number.isFinite(receivedAt) || receivedAt < 0 || !Number.isInteger(receivedAt)) {
    throw new Error('Invalid Fomo activity');
  }

  const result = rawActivitySchema.safeParse(payload);

  if (!result.success) {
    throw new Error('Invalid Fomo activity');
  }

  const raw = result.data;
  const mappedChain = mapNetworkId(raw.networkId);
  const chain =
    mappedChain === 'unknown'
      ? inferChainFromTokenAddress(raw.tokenAddress) ?? 'unknown'
      : mappedChain;
  const tokenAddress = normalizeEvmAddressCase(raw.tokenAddress);
  const occurredAt = Date.parse(raw.createdAt);
  const thesis = extractThesis(raw.comment);
  const canonicalId = await resolveCanonicalId(raw, tokenAddress);

  return {
    schemaVersion: 1,
    id: canonicalId.id,
    source: 'fomo',
    ...('sourceEventId' in canonicalId
      ? { sourceEventId: canonicalId.sourceEventId }
      : {}),
    ...(raw.tradeId ? { sourceTradeId: raw.tradeId } : {}),
    traderId: raw.userId,
    traderHandle: raw.userHandle,
    ...(raw.displayName !== undefined ? { traderName: raw.displayName } : {}),
    ...(raw.profilePictureLink ? { traderAvatarUrl: raw.profilePictureLink } : {}),
    chain,
    networkId: raw.networkId,
    tokenAddress,
    tokenSymbol: raw.ticker.trim(),
    ...(raw.tokenImageUrl ? { tokenImageUrl: raw.tokenImageUrl } : {}),
    action: ACTION_MAP[raw.type],
    ...(raw.usdAmount !== undefined ? { usdAmount: raw.usdAmount } : {}),
    ...(raw.marketCap !== undefined ? { marketCap: raw.marketCap } : {}),
    ...(raw.price !== undefined ? { price: raw.price } : {}),
    ...(thesis !== undefined ? { thesis } : {}),
    occurredAt,
    receivedAt,
  };
}
