import type { ActivitySource, ChainKey } from '../domain/activity';
import { buildFomoTokenUrl } from '../navigation/fomo-links';
import { buildPumpTokenUrl } from '../navigation/pump-links';

export interface FomoTabCandidate {
  id?: number;
  windowId: number;
  lastAccessed?: number;
}

export interface TokenNavigationChrome {
  tabs: {
    query(query: { url: string[] }): Promise<FomoTabCandidate[]>;
    update(tabId: number, update: { url: string; active: true }): Promise<unknown>;
    create(create: { url: string; active: true }): Promise<unknown>;
  };
  windows: {
    getLastFocused(): Promise<{ id?: number }>;
    update(windowId: number, update: { focused: true }): Promise<unknown>;
  };
}

export interface OpenTokenTarget {
  source?: ActivitySource | undefined;
  chain: ChainKey;
  tokenAddress: string;
}

export type TokenNavigationResult =
  | { ok: true }
  | { ok: false; reason: 'invalid-target' | 'chrome-api-failed' };

const FOMO_TAB_PATTERNS = [
  'https://fomo.family/*',
  'https://www.fomo.family/*',
];
const PUMP_TAB_PATTERNS = ['https://pump.fun/*', 'https://www.pump.fun/*'];

export function selectFomoTab(
  tabs: readonly FomoTabCandidate[],
  currentWindowId?: number,
): FomoTabCandidate | undefined {
  const valid = tabs.filter((tab): tab is FomoTabCandidate & { id: number } =>
    typeof tab.id === 'number');
  const preferred = currentWindowId === undefined
    ? []
    : valid.filter((tab) => tab.windowId === currentWindowId);
  const pool = preferred.length > 0 ? preferred : valid;

  return pool.toSorted((left, right) =>
    (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0) ||
    left.id - right.id)[0];
}

export async function openFomoToken(
  chrome: TokenNavigationChrome,
  target: OpenTokenTarget,
): Promise<TokenNavigationResult> {
  const url = buildFomoTokenUrl(target.chain, target.tokenAddress);
  if (url === null) {
    return { ok: false, reason: 'invalid-target' };
  }

  const create = async (): Promise<TokenNavigationResult> => {
    try {
      await chrome.tabs.create({ url: url.href, active: true });
      return { ok: true };
    } catch {
      return { ok: false, reason: 'chrome-api-failed' };
    }
  };

  try {
    const [tabs, focused] = await Promise.all([
      chrome.tabs.query({ url: [...FOMO_TAB_PATTERNS] }),
      chrome.windows.getLastFocused(),
    ]);
    const selected = selectFomoTab(tabs, focused.id);
    if (selected?.id === undefined) {
      return create();
    }

    try {
      await chrome.tabs.update(selected.id, { url: url.href, active: true });
    } catch {
      return create();
    }

    try {
      await chrome.windows.update(selected.windowId, { focused: true });
      return { ok: true };
    } catch {
      return { ok: false, reason: 'chrome-api-failed' };
    }
  } catch {
    return { ok: false, reason: 'chrome-api-failed' };
  }
}

export async function openActivityToken(
  chrome: TokenNavigationChrome,
  target: OpenTokenTarget,
): Promise<TokenNavigationResult> {
  if (target.source !== 'pump') return openFomoToken(chrome, target);

  const url = buildPumpTokenUrl(target.chain, target.tokenAddress);
  if (url === null) return { ok: false, reason: 'invalid-target' };

  const create = async (): Promise<TokenNavigationResult> => {
    try {
      await chrome.tabs.create({ url: url.href, active: true });
      return { ok: true };
    } catch {
      return { ok: false, reason: 'chrome-api-failed' };
    }
  };

  try {
    const [tabs, focused] = await Promise.all([
      chrome.tabs.query({ url: PUMP_TAB_PATTERNS }),
      chrome.windows.getLastFocused(),
    ]);
    const selected = selectFomoTab(tabs, focused.id);
    if (selected?.id === undefined) return create();
    try {
      await chrome.tabs.update(selected.id, { url: url.href, active: true });
    } catch {
      return create();
    }
    try {
      await chrome.windows.update(selected.windowId, { focused: true });
      return { ok: true };
    } catch {
      return { ok: false, reason: 'chrome-api-failed' };
    }
  } catch {
    return { ok: false, reason: 'chrome-api-failed' };
  }
}
