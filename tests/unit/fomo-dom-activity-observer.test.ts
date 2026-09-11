import {
  installFomoDomActivityObserver,
  parseFomoDomActivity,
} from '../../src/fomo/dom-activity-observer';

describe('parseFomoDomActivity', () => {
  it('parses a rendered Chinese buy activity', () => {
    document.body.innerHTML = `
      <a href="/tokens/solana/E4Ap4icMLwKot8rkkTbq5JkS5kZxt5XCE3yfxbzYBjHx"
         aria-label="pointfarmcap 买入 1分钟 ? BTC $3 以 $337.3万 市值">
        <span>pointfarmcap</span><span>BTC</span>
      </a>
    `;

    expect(parseFomoDomActivity(document.querySelector('a')!, 1_800_000)).toMatchObject({
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
      <a href="https://fomo.family/tokens/bnb/0x7c8d5502b544ddaf8852fc46d1174e34876d545c">
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
        <a href="/tokens/robinhood/0x39dbed3a2bd333467115de45665cc57f813c4571">MINI</a>
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
  it('emits existing and newly rendered activities only once', async () => {
    document.body.innerHTML = `
      <a href="/tokens/solana/E4Ap4icMLwKot8rkkTbq5JkS5kZxt5XCE3yfxbzYBjHx">
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
      <a href="/tokens/bnb/0x7c8d5502b544ddaf8852fc46d1174e34876d545c">
        anyway 卖出 2分钟 BNC4 $5 以 $415万 市值
      </a>
    `);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(emitted).toHaveLength(2);
    observer.uninstall();
  });
});
