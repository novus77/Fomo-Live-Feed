const TOKEN_LINK_SELECTOR = 'a[href*="/tokens/"]';

const NETWORK_IDS: Readonly<Record<string, number>> = {
  ethereum: 1,
  bnb: 56,
  bsc: 56,
  base: 8453,
  solana: 1399811149,
  'x-layer': 196,
  xlayer: 196,
  robinhood: 4663,
};

type DomActivityType =
  | 'swap_buy'
  | 'swap_sell'
  | 'swap_withdraw'
  | 'transfer_in'
  | 'transfer_out'
  | 'thesis';

export interface DomActivityCandidate {
  id: string;
  tradeId?: string;
  type: DomActivityType;
  userId: string;
  userHandle: string;
  displayName: string;
  ticker: string;
  tokenAddress: string;
  networkId: number;
  createdAt: string;
  usdAmount?: number;
  marketCap?: number;
  comment?: string;
}

interface ObserverOptions {
  document: Document;
  emit(activity: DomActivityCandidate): Promise<boolean> | boolean;
  onTokenLink?(): void;
  onCandidate?(): void;
  now?: () => number;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

const RELATIVE_TIME_PATTERN = /(?:刚刚|just now|\d+\s*(?:秒(?:钟)?|分钟|小时|天|s(?:ec(?:ond)?s?)?|min(?:ute)?s?|m|hours?|h|days?|d))(?=\s|$)/i;

function isActivityIdentityPrefix(value: string): boolean {
  return !/(?:\$|盈利|持仓|市值|\bprofit\b|\bposition\b|\bMC\b)/i.test(value)
    && !RELATIVE_TIME_PATTERN.test(value);
}

function findActivityText(link: HTMLAnchorElement): string {
  let element: Element | null = link;

  for (let depth = 0; element !== null && depth < 7; depth += 1) {
    const htmlElement = element instanceof HTMLElement ? element : null;
    const candidates = [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      htmlElement?.innerText,
      element.textContent,
      Array.from(element.querySelectorAll('img[alt]'))
        .map((image) => image.getAttribute('alt'))
        .join(' '),
    ];
    for (const candidate of candidates) {
      const text = normalizeText(candidate);
      if (/(买入|卖出|观点|转入|转出|Buy|Sell|Thesis|Transfer)/i.test(text)) {
        return text;
      }
    }
    element = element.parentElement;
  }

  return normalizeText(link.textContent);
}

function parseAction(text: string): { type: DomActivityType; label: string } | null {
  const actions: readonly [RegExp, DomActivityType][] = [
    [/买入|\bBuy\b/i, 'swap_buy'],
    [/卖出|\bSell\b/i, 'swap_sell'],
    [/观点|\bThesis\b|\bOpinion\b/i, 'thesis'],
    [/转入|Transfer In/i, 'transfer_in'],
    [/转出|Transfer Out/i, 'transfer_out'],
  ];

  for (const [pattern, type] of actions) {
    const match = pattern.exec(text);
    if (match !== null) return { type, label: match[0] };
  }

  return null;
}

function parseCompactNumber(value: string): number | undefined {
  const match = value.replace(/,/g, '').match(/^\$?([0-9]+(?:\.[0-9]+)?)(万|亿|[KMB])?$/i);
  if (match === null) return undefined;

  const multiplier = {
    '': 1,
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000,
    万: 10_000,
    亿: 100_000_000,
  }[match[2]?.toUpperCase() ?? ''];

  if (multiplier === undefined || match[1] === undefined) return undefined;
  return Math.round(Number(match[1]) * multiplier * 100) / 100;
}

function parseRelativeTime(text: string, now: number): number {
  const patterns: readonly [RegExp, number][] = [
    [/(\d+)\s*(?:秒|秒钟|s(?:ec(?:ond)?s?))(?=\s|$)/i, 1_000],
    [/(\d+)\s*(?:分钟|min(?:ute)?s?|m)(?=\s|$)/i, 60_000],
    [/(\d+)\s*(?:小时|hours?|h)(?=\s|$)/i, 3_600_000],
    [/(\d+)\s*(?:天|days?|d)(?=\s|$)/i, 86_400_000],
  ];

  if (/刚刚|just now/i.test(text)) return now;
  for (const [pattern, multiplier] of patterns) {
    const match = pattern.exec(text);
    if (match?.[1] !== undefined) return now - Number(match[1]) * multiplier;
  }
  return now;
}

function parseTokenRoute(link: HTMLAnchorElement): {
  networkId: number;
  tokenAddress: string;
  tradeId?: string;
} | null {
  try {
    const url = new URL(link.href, 'https://fomo.family');
    const match = url.pathname.match(/^\/tokens\/([^/]+)\/([^/]+)$/i);
    if (match === null) return null;
    const chain = match[1];
    const tokenAddress = match[2];
    if (chain === undefined || tokenAddress === undefined) return null;
    const networkId = NETWORK_IDS[decodeURIComponent(chain).toLowerCase()];
    if (networkId === undefined) return null;
    const rawTradeId = url.searchParams.get('tradeId')?.trim();
    const tradeId = rawTradeId !== undefined
      && rawTradeId.length > 0
      && rawTradeId.length <= 128
      ? rawTradeId
      : undefined;
    return {
      networkId,
      tokenAddress: decodeURIComponent(tokenAddress),
      ...(tradeId === undefined ? {} : { tradeId }),
    };
  } catch {
    return null;
  }
}

function stableId(parts: readonly string[]): string {
  let hash = 2166136261;
  for (const character of parts.join('|')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `dom-${(hash >>> 0).toString(16)}`;
}

export function parseFomoDomActivity(
  link: HTMLAnchorElement,
  now = Date.now(),
): DomActivityCandidate | null {
  const route = parseTokenRoute(link);
  if (route === null) return null;

  const text = findActivityText(link);
  const action = parseAction(text);
  if (action === null) return null;

  const actionIndex = text.indexOf(action.label);
  const displayName = normalizeText(text.slice(0, actionIndex));
  // Feed identities are compact labels. A longer or summary-like prefix means
  // the action came from a surrounding token-detail/chart container.
  if (
    displayName.length === 0
    || displayName.length > 64
    || !isActivityIdentityPrefix(displayName)
  ) return null;

  const afterAction = normalizeText(text.slice(actionIndex + action.label.length));
  const timeMatch = RELATIVE_TIME_PATTERN.exec(afterAction);
  // Every real feed row carries a relative timestamp immediately after its
  // action. Token-detail and chart containers also contain words such as
  // "Buy" or "Opinion", but do not have an event timestamp in that shape.
  if (timeMatch === null) return null;
  const afterTime = normalizeText(
    afterAction.slice((timeMatch.index ?? 0) + timeMatch[0].length),
  );
  const linkText = normalizeText(link.textContent);
  const beforeFirstMoney = normalizeText(afterTime.split(/\$[0-9]/, 1)[0]);
  const inferredTicker = beforeFirstMoney.split(' ').filter((part) => part !== '?').at(-1);
  const tickerCandidate = link.getAttribute('aria-label') === null
    && linkText.length > 0
    && parseAction(linkText) === null
    && !linkText.includes(' ')
    ? linkText
    : inferredTicker;
  const ticker = (tickerCandidate ?? '').replace(/^\$/, '');
  if (ticker.length === 0 || ticker.length > 128) return null;

  const moneyValues = [...afterTime.matchAll(/\$[0-9][0-9,.]*(?:万|亿|[KMB])?/gi)]
    .map((match) => ({ raw: match[0], value: parseCompactNumber(match[0]) }))
    .filter((entry): entry is { raw: string; value: number } => entry.value !== undefined);
  const marketMarker = /(?:市值|\bMC\b)/i.exec(afterTime);
  const marketCap = marketMarker === null
    ? action.type === 'thesis' ? moneyValues[0]?.value : undefined
    : [...moneyValues].reverse().find((entry) => afterTime.indexOf(entry.raw) < marketMarker.index)?.value;
  const usdAmount = action.type === 'thesis' ? undefined : moneyValues[0]?.value;
  const occurredAt = parseRelativeTime(afterAction, now);
  const userHandle = displayName.replace(/^@/, '');
  const comment = action.type === 'thesis'
    ? normalizeText(afterTime
        .replace(ticker, '')
        .replace(moneyValues[0]?.raw ?? '', '')) || undefined
    : undefined;
  const id = route.tradeId === undefined
    ? stableId([
        action.type,
        userHandle,
        route.tokenAddress,
        String(usdAmount ?? ''),
        String(marketCap ?? ''),
        String(Math.floor(occurredAt / 60_000)),
      ])
    : stableId(['trade', String(route.networkId), route.tradeId]);

  return {
    id,
    ...(route.tradeId === undefined ? {} : { tradeId: route.tradeId }),
    type: action.type,
    userId: userHandle,
    userHandle,
    displayName,
    ticker,
    tokenAddress: route.tokenAddress,
    networkId: route.networkId,
    createdAt: new Date(occurredAt).toISOString(),
    ...(usdAmount === undefined ? {} : { usdAmount }),
    ...(marketCap === undefined ? {} : { marketCap }),
    ...(comment === undefined ? {} : { comment }),
  };
}

export function installFomoDomActivityObserver(options: ObserverOptions): { uninstall(): void } {
  const now = options.now ?? (() => Date.now());
  const emitted = new WeakSet<HTMLAnchorElement>();
  const pending = new WeakSet<HTMLAnchorElement>();

  const inspect = (root: ParentNode): void => {
    const links = root instanceof HTMLAnchorElement
      ? [root]
      : Array.from(root.querySelectorAll<HTMLAnchorElement>(TOKEN_LINK_SELECTOR));

    for (const link of links) {
      if (emitted.has(link) || pending.has(link) || !link.matches(TOKEN_LINK_SELECTOR)) continue;
      options.onTokenLink?.();
      const activity = parseFomoDomActivity(link, now());
      if (activity === null) continue;
      pending.add(link);
      options.onCandidate?.();
      void Promise.resolve(options.emit(activity)).then((accepted) => {
        pending.delete(link);
        if (accepted) emitted.add(link);
      }).catch(() => {
        pending.delete(link);
      });
    }
  };

  inspect(options.document);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) inspect(node);
      }
    }
  });
  // This content script starts at document_start, where documentElement can
  // still be null. Observing Document keeps the observer active across initial
  // HTML creation as well as client-side route changes.
  observer.observe(options.document, { childList: true, subtree: true });

  const retryTimer = window.setInterval(() => inspect(options.document), 2_000);

  return {
    uninstall: () => {
      observer.disconnect();
      window.clearInterval(retryTimer);
    },
  };
}
