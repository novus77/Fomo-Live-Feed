import {
  installFomoDomActivityObserver,
  parseFomoDomActivity,
} from '../../src/fomo/dom-activity-observer';

describe('parseFomoDomActivity', () => {
  it('prefers an explicit event timestamp over a stale just-now label', () => {
    document.body.innerHTML = `<a href="/tokens/bnb/TokenAddress?tradeId=old-clock"
      aria-label="trader Buy just now TOKEN $5 at $10K MC">
      <span title="2026-01-01T00:00:00Z">just now</span></a>`;
    expect(parseFomoDomActivity(document.querySelector('a')!)?.createdAt)
      .toBe('2026-01-01T00:00:00.000Z');
  });
  it('rejects a rendered activity without the stable trade link identity', () => {
    document.body.innerHTML = `
      <a href="/tokens/solana/E4Ap4icMLwKot8rkkTbq5JkS5kZxt5XCE3yfxbzYBjHx"
         aria-label="pointfarmcap 买入 1分钟 ? BTC $3 以 $337.3万 市值">
        <span>pointfarmcap</span><span>BTC</span>
      </a>
    `;

    expect(parseFomoDomActivity(document.querySelector('a')!, 1_800_000)).toBeNull();
  });

  it('parses a rendered Chinese buy activity', () => {
    document.body.innerHTML = `
      <a href="/tokens/solana/E4Ap4icMLwKot8rkkTbq5JkS5kZxt5XCE3yfxbzYBjHx?tradeId=trade-sol-1"
         aria-label="pointfarmcap 买入 1分钟 ? BTC $3 以 $337.3万 市值">
        <span>pointfarmcap</span><span>BTC</span>
      </a>
    `;

    expect(parseFomoDomActivity(document.querySelector('a')!, 1_800_000)).toMatchObject({
      id: 'trade-sol-1',
      tradeId: 'trade-sol-1',
      type: 'swap_buy',
      userHandle: 'pointfarmcap',
      ticker: 'BTC',
      tokenAddress: 'E4Ap4icMLwKot8rkkTbq5JkS5kZxt5XCE3yfxbzYBjHx',
      networkId: 1399811149,
      usdAmount: 3,
      marketCap: 3_373_000,
      createdAt: '1970-01-01T00:29:00.000Z',
    });
  });

  it('parses an English sell activity with compact market cap', () => {
    document.body.innerHTML = `
      <a href="https://fomo.family/tokens/bnb/0x7c8d5502b544ddaf8852fc46d1174e34876d545c?tradeId=trade-bnb-1">
        anyway Sell 2m BNC4 $5 at $4.15M MC
      </a>
    `;

    expect(parseFomoDomActivity(document.querySelector('a')!, 1_800_000)).toMatchObject({
      type: 'swap_sell',
      userHandle: 'anyway',
      ticker: 'BNC4',
      networkId: 56,
      usdAmount: 5,
      marketCap: 4_150_000,
    });
  });

  it('derives the English ticker from activity text and carries the linked token image', () => {
    document.body.innerHTML = `
      <a href="/tokens/solana/CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1UjmExample?tradeId=trade-sol-en-1"
         title="Chino_40 Buy 5m BULL $8.2K at $16.2M MC">
        <img src="/images/tokens/bull.png" alt="BULL">
        <span>Chino_40</span><span>Buy</span><span>BULL</span>
      </a>
    `;

    expect(parseFomoDomActivity(document.querySelector('a')!, 1_800_000)).toMatchObject({
      tradeId: 'trade-sol-en-1',
      type: 'swap_buy',
      userHandle: 'Chino_40',
      ticker: 'BULL',
      tokenImageUrl: '/images/tokens/bull.png',
      usdAmount: 8_200,
      marketCap: 16_200_000,
    });
  });

  it('parses an ARC trade link with the observed Fomo network id', () => {
    document.body.innerHTML = `
      <a href="https://fomo.family/tokens/arc/0xece5ca8bf9220718e5727754026757512212cb3c?tradeId=trade-arc-1">
        arc_trader Buy just now ARC $5 at $10K MC
      </a>
    `;

    expect(parseFomoDomActivity(document.querySelector('a')!, 1_800_000)).toMatchObject({
      tradeId: 'trade-arc-1',
      type: 'swap_buy',
      userHandle: 'arc_trader',
      ticker: 'ARC',
      networkId: 5042,
    });
  });

  it('selects the token thumbnail rather than the avatar in the current feed row', () => {
    document.body.innerHTML = `
      <a href="/tokens/solana/TokenAddress?tradeId=current-dom-1"
         aria-label="trader Buy just now STUPIDINU $100 at $175K MC">
        <div role="link"><img src="https://profiles.example/trader.jpg"></div>
        <div>
          <div role="link">trader</div>
          <div><div><img src="https://tokens.example/token.png"></div><div role="link" translate="no">STUPIDINU</div></div>
        </div>
      </a>
    `;

    expect(parseFomoDomActivity(document.querySelector('a')!)?.tokenImageUrl)
      .toBe('https://tokens.example/token.png');
  });

  it.each(['translate="no"', ''])(
    'selects the token thumbnail when trader and ticker labels match (%s)',
    (translationAttribute) => {
      document.body.innerHTML = `
        <a href="/tokens/solana/TokenAddress?tradeId=matching-labels-1"
           aria-label="STUPIDINU Buy just now STUPIDINU $100 at $175K MC">
          <div role="link"><img src="https://profiles.example/trader.jpg"></div>
          <div>
            <div role="link">STUPIDINU</div>
            <div><div><img src="https://tokens.example/token.png"></div><div role="link" ${translationAttribute}>STUPIDINU</div></div>
          </div>
        </a>
      `;

      expect(parseFomoDomActivity(document.querySelector('a')!)?.tokenImageUrl)
        .toBe('https://tokens.example/token.png');
    },
  );

  it.each(['translate="no"', ''])(
    'omits a missing token thumbnail when a matching trader label follows its avatar (%s)',
    (translationAttribute) => {
      document.body.innerHTML = `
        <a href="/tokens/solana/TokenAddress?tradeId=matching-labels-2"
           aria-label="STUPIDINU Buy just now STUPIDINU $100 at $175K MC">
          <div role="link"><img src="https://profiles.example/trader.jpg" alt="STUPIDINU"></div>
          <div role="link">STUPIDINU</div>
          <div role="link" ${translationAttribute}>STUPIDINU</div>
        </a>
      `;

      expect(parseFomoDomActivity(document.querySelector('a')!)).not.toHaveProperty('tokenImageUrl');
    },
  );

  it('does not substitute a trader avatar when the token thumbnail is missing', () => {
    document.body.innerHTML = `
      <a href="/tokens/solana/TokenAddress?tradeId=current-dom-2"
         aria-label="trader Buy just now STUPIDINU $100 at $175K MC">
        <div role="link"><img src="https://profiles.example/trader.jpg"></div>
        <div><div role="link">trader</div><div role="link" translate="no">STUPIDINU</div></div>
      </a>
    `;

    expect(parseFomoDomActivity(document.querySelector('a')!)).not.toHaveProperty('tokenImageUrl');
  });

  it.each(['$1.20万亿', '$1.20T'])(
    'preserves trillion-scale market cap %s in DOM fallback',
    (marketCap) => {
      document.body.innerHTML = `
        <a href="/tokens/solana/TokenAddress?tradeId=trillion-1"
           aria-label="trader Sell just now MU $5 at ${marketCap} MC">MU</a>
      `;

      expect(parseFomoDomActivity(document.querySelector('a')!)?.marketCap).toBe(1_200_000_000_000);
    },
  );

  it('parses the production trade link shape from its accessible title', () => {
    document.body.innerHTML = `
      <a href="/tokens/bnb/0xd270d4e1ec6e6e0d28c0ecb8be966ec75997ffff?tradeId=e5b80a62-320a-4959-b42e-e4efc861ed3d"
         title="frankdegods 买入 刚刚 ? 4Stock $2.5万 以 $2133.9万 市值">
        <span aria-hidden="true"></span>
      </a>
    `;

    expect(parseFomoDomActivity(document.querySelector('a')!, 1_800_000)).toMatchObject({
      id: expect.any(String),
      tradeId: 'e5b80a62-320a-4959-b42e-e4efc861ed3d',
      type: 'swap_buy',
      userHandle: 'frankdegods',
      ticker: '4Stock',
      networkId: 56,
      usdAmount: 25_000,
      marketCap: 21_339_000,
    });
  });

  it('keeps the DOM event identity stable when time and market cap rerender', () => {
    document.body.innerHTML = `
      <a href="/tokens/bnb/0xd270d4e1ec6e6e0d28c0ecb8be966ec75997ffff?tradeId=e5b80a62-320a-4959-b42e-e4efc861ed3d"
         title="frankdegods 买入 刚刚 ? 4Stock $2.5万 以 $2133.9万 市值">
        <span aria-hidden="true"></span>
      </a>
    `;
    const link = document.querySelector('a')!;
    const first = parseFomoDomActivity(link, 1_800_000);

    link.title = 'frankdegods 买入 1分钟 ? 4Stock $2.5万 以 $2200万 市值';
    const rerendered = parseFomoDomActivity(link, 1_920_000);

    expect(rerendered?.id).toBe(first?.id);
    expect(rerendered?.tradeId).toBe('e5b80a62-320a-4959-b42e-e4efc861ed3d');
  });

  it('finds a thesis from the containing rendered card', () => {
    document.body.innerHTML = `
      <div>ether_monk 观点 1分钟
        <a href="/tokens/robinhood/0x39dbed3a2bd333467115de45665cc57f813c4571?tradeId=trade-rh-1">MINI</a>
        $75,026.15 mini turns big soon
      </div>
    `;

    expect(parseFomoDomActivity(document.querySelector('a')!, 1_800_000)).toMatchObject({
      type: 'thesis',
      userHandle: 'ether_monk',
      ticker: 'MINI',
      networkId: 4663,
      marketCap: 75_026.15,
      comment: 'mini turns big soon',
    });
  });

  it('rejects a token link whose ancestor only contains an unrelated buy control', () => {
    document.body.innerHTML = `
      <section>
        ether_monk 盈利 +$62,028.29 1分钟 BLUE 持仓中 市值 $240M
        <a href="/tokens/base/0xb20000000000000000000000cfbdf64a8706a94a01">以来</a>
        <button type="button">买入</button>
      </section>
    `;

    expect(parseFomoDomActivity(document.querySelector('a')!, 1_800_000)).toBeNull();
  });

  it('rejects a token-detail ancestor that merely contains activity controls', () => {
    document.body.innerHTML = `
      <section>
        4Stock 0xd270...97ffff 持仓中 市值 $6935.2万 ▲ 479,525.03%
        正在加载图表 实时 1小时 4小时 全部 交易 观点 1小时 70
        <a href="/tokens/bnb/0xd270d4e1ec6e6e0d28c0ecb8be966ec75997ffff">
          4Stock 0xd270...97ffff
        </a>
      </section>
    `;

    expect(parseFomoDomActivity(document.querySelector('a')!, 1_800_000)).toBeNull();
  });

  it('rejects activity-like text without a relative event timestamp', () => {
    document.body.innerHTML = `
      <a href="/tokens/bnb/0xd270d4e1ec6e6e0d28c0ecb8be966ec75997ffff"
         aria-label="4Stock 买入 $501 市值 $4.4万">
        4Stock
      </a>
    `;

    expect(parseFomoDomActivity(document.querySelector('a')!, 1_800_000)).toBeNull();
  });
});

describe('installFomoDomActivityObserver', () => {
  it('does not treat an existing just-now card as live connection evidence', async () => {
    document.body.innerHTML = `<a href="/tokens/bnb/TokenAddress?tradeId=existing-clock"
      aria-label="trader Buy just now TOKEN $5 at $10K MC"></a>`;
    const onLiveActivity = vi.fn();
    const observer = installFomoDomActivityObserver({ document, emit: () => true, onLiveActivity });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onLiveActivity).not.toHaveBeenCalled();
    document.body.insertAdjacentHTML('beforeend', `<a href="/tokens/bnb/TokenAddress?tradeId=new-clock"
      aria-label="trader Buy just now TOKEN $5 at $10K MC"><time datetime="2026-10-03T08:00:00Z"></time></a>`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onLiveActivity).toHaveBeenCalledOnce();
    expect(onLiveActivity).toHaveBeenCalledWith(expect.objectContaining({ tradeId: 'new-clock' }));
    observer.uninstall();
  });

  it('retries a newly added card after a rejected delivery without reporting it live', async () => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
    const onLiveActivity = vi.fn();
    const emit = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const observer = installFomoDomActivityObserver({ document, emit, onLiveActivity });
    try {
      document.body.insertAdjacentHTML('beforeend', `<a href="/tokens/bnb/TokenAddress?tradeId=retry-live"
        aria-label="trader Buy just now TOKEN $5 at $10K MC"><time datetime="2026-10-03T08:00:00Z"></time></a>`);
      await vi.advanceTimersByTimeAsync(0);
      expect(emit).toHaveBeenCalledOnce();
      expect(onLiveActivity).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(emit).toHaveBeenCalledTimes(2);
      expect(onLiveActivity).toHaveBeenCalledOnce();
    } finally {
      observer.uninstall();
      vi.useRealTimers();
    }
  });

  it('does not promote a moved history card with only a relative clock', async () => {
    document.body.innerHTML = `<a href="/tokens/bnb/TokenAddress?tradeId=moved-history"
      aria-label="trader Buy just now TOKEN $5 at $10K MC"></a>`;
    let enabled = false;
    const onLiveActivity = vi.fn();
    const observer = installFomoDomActivityObserver({
      document, emit: () => true, onLiveActivity, isFallbackEnabled: () => enabled,
    });
    try {
      enabled = true;
      const container = document.createElement('section');
      container.append(document.querySelector('a')!);
      document.body.append(container);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onLiveActivity).not.toHaveBeenCalled();
    } finally {
      observer.uninstall();
    }
  });

  it('does not report a delayed DOM acknowledgement across page suspension', async () => {
    document.body.innerHTML = '';
    let acknowledge!: (accepted: boolean) => void;
    const onLiveActivity = vi.fn();
    const observer = installFomoDomActivityObserver({
      document, onLiveActivity, emit: () => new Promise<boolean>((resolve) => { acknowledge = resolve; }),
    });
    try {
      document.body.insertAdjacentHTML('beforeend', `<a href="/tokens/bnb/TokenAddress?tradeId=delayed-live"
        aria-label="trader Buy just now TOKEN $5 at $10K MC"><time datetime="2026-10-03T08:00:00Z"></time></a>`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      acknowledge(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onLiveActivity).not.toHaveBeenCalled();
    } finally {
      observer.uninstall();
    }
  });

  it('retries storage without reviving pre-suspension live evidence', async () => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
    let acknowledge!: (accepted: boolean) => void;
    const onLiveActivity = vi.fn();
    const emit = vi.fn().mockImplementationOnce(() => new Promise<boolean>((resolve) => { acknowledge = resolve; }))
      .mockResolvedValue(true);
    const observer = installFomoDomActivityObserver({ document, emit, onLiveActivity });
    try {
      document.body.insertAdjacentHTML('beforeend', `<a href="/tokens/bnb/TokenAddress?tradeId=retry-suspended"
        aria-label="trader Buy just now TOKEN $5 at $10K MC"><time datetime="2026-10-03T08:00:00Z"></time></a>`);
      await vi.advanceTimersByTimeAsync(0);
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      acknowledge(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(emit).toHaveBeenCalledTimes(2);
      expect(onLiveActivity).not.toHaveBeenCalled();
    } finally {
      observer.uninstall();
      vi.useRealTimers();
    }
  });
  it('inspects a hydrated trade link immediately instead of waiting for the retry scan', async () => {
    document.body.innerHTML = '<a href="/tokens/solana/TokenAddress?tradeId=hydrated-1"></a>';
    const emit = vi.fn(() => true);
    const observer = installFomoDomActivityObserver({ document, emit });
    expect(emit).not.toHaveBeenCalled();

    document.querySelector('a')!.append('trader Buy just now TOKEN $5 at $10K MC');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(emit).toHaveBeenCalledTimes(1);
    observer.uninstall();
  });

  it('skips the whole mutation batch when authoritative capture is active', async () => {
    const isFallbackEnabled = vi.fn(() => false);
    const observer = installFomoDomActivityObserver({
      document,
      emit: vi.fn(),
      isFallbackEnabled,
    });
    isFallbackEnabled.mockClear();
    const container = document.createElement('div');
    container.append(document.createElement('span'), document.createElement('span'));
    document.body.append(container, document.createElement('span'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(isFallbackEnabled).toHaveBeenCalledTimes(1);
    observer.uninstall();
  });

  it('emits existing and newly rendered activities only once', async () => {
    document.body.innerHTML = `
      <a href="/tokens/solana/E4Ap4icMLwKot8rkkTbq5JkS5kZxt5XCE3yfxbzYBjHx?tradeId=trade-sol-1">
        pointfarmcap 买入 1分钟 BTC $3 以 $337.3万 市值
      </a>
    `;
    const emitted: unknown[] = [];
    const observer = installFomoDomActivityObserver({
      document,
      emit: (activity) => {
        emitted.push(activity);
        return true;
      },
      now: () => 1_800_000,
    });

    expect(emitted).toHaveLength(1);

    document.body.insertAdjacentHTML('beforeend', `
      <a href="/tokens/bnb/0x7c8d5502b544ddaf8852fc46d1174e34876d545c?tradeId=trade-bnb-1">
        anyway 卖出 2分钟 BNC4 $5 以 $415万 市值
      </a>
    `);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(emitted).toHaveLength(2);
    observer.uninstall();
  });
});
