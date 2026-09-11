# Fomo Live Feed

[简体中文](#简体中文) | [English](#english)

## 简体中文

Fomo Live Feed 是一款 Chrome 扩展，通过 Chrome 侧边栏或始终置顶的画中画
窗口统一展示当前 Fomo 与 Pump 登录用户所关注交易者的动态。扩展会在本地保存可搜索、
可筛选的历史记录，不会在交易页面注入额外的浮动通知卡片。

> **MVP 状态：**核心功能已经实现，并通过单元、集成及端到端测试。用于补充
> 生产数据的 Fomo enrichment 与 REST backfill 适配器仍保持禁用，等待获取并
> 脱敏真实登录响应后再启用，详情见[开发指南](docs/development.md)。在此之前，
> 卡片会展示基础动态字段，将相关指标标记为不可用；断线重连补录也暂不可用。

### 下载与安装

**直接下载：**[Fomo Live Feed v0.5.1（Chrome ZIP）](https://github.com/novus77/Fomo-Live-Feed/releases/download/v0.5.1/Fomo-Live-Feed-v0.5.1-chrome.zip)

也可以从 GitHub 页面依次进入：**仓库首页 → Releases → Latest → Assets →
`Fomo-Live-Feed-v0.5.1-chrome.zip`**。

1. 下载并解压 `Fomo-Live-Feed-v0.5.1-chrome.zip`。
2. 在 Chrome 地址栏打开 `chrome://extensions`。
3. 开启右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择刚刚解压的目录。
5. 保持已登录的 Fomo 和/或 Pump 页面处于打开状态；扩展重新加载后会自动恢复对应来源。
6. 点击扩展图标打开实时信息流；可在设置中选择侧边栏或悬浮模式。
   首次进入悬浮模式时，小型激活宿主会要求再点击一次“将悬浮窗
   保持在最前”；随后打开的文档画中画才是真正的始终置顶信息流。

接收者无需安装此仓库、Node.js 或 pnpm。解压目录中的 `START-HERE.html`
包含启动及故障排查清单。扩展要求 **Chrome 141 或更高版本**。

如需校验下载文件，可在同一 Assets 区域下载
`Fomo-Live-Feed-v0.5.1-chrome.zip.sha256`。

### 主要功能

- **实时捕获**：MAIN world interceptor 监听 Fomo 生产 WebSocket，仅将通过
  校验的 `trading_activity` 数据传递给隔离 bridge，再转交 service worker；
  Cookie、请求头及令牌不会跨越该边界。
- **Pump 近实时动态**：在已登录的 Pump 页面内串行请求 Following 交易动态，
  目标间隔一秒，并提供自动退避、游标补齐、交易去重和缺口状态。
- **双来源信息流**：支持全部来源、仅 Fomo 或仅 Pump；同一交易合并来源标识，
  用户名和代币跳转会跟随当前选中来源。
- **右侧边栏历史**：按时间倒序分页，支持未读状态、搜索、动作/链/交易者/
  代币筛选、交易者标签与颜色、置顶与静音、链标识和合约地址复制。
- **关注链筛选**：可单独开关 BSC、Solana、Robinhood、Base、Ethereum 和
  X Layer；未选择的链不会进入当前信息流，选择结果保存在本地。
- **买入声音提示**：设置中可开启全局买入提示音；默认关闭，只响应实时买入，
  重复事件、卖出、观点、转入和转出不会触发。
- **Fomo 快捷跳转**：点击代币名称可复用现有 Fomo 标签页并打开对应链和合约的
  代币页面；无法构造可靠目标时保持普通文本。
- **侧边栏 / 始终置顶悬浮窗无缝切换**：两种模式共享后台连接、历史、
  筛选、设置与备注。侧边栏先把数据同步给小型激活宿主，用户直接点击后再
  打开 Document Picture-in-Picture；PiP 就绪后宿主最小化，任何时刻只保留一个
  可交互信息流。PiP 可跨 Chrome 标签页保持在最前，不占用页面侧边宽度；返回
  侧边栏、原生关闭恢复和扩展重载都会防止丢失或重复信息流。
- **紧凑终端界面**：买入、卖出、观点等事件使用不同语义色边框；工具栏、筛选、
  设置、空状态和加载反馈采用统一的明暗主题设计，同时保持每屏信息密度。
- **本地存储**：动态历史保存在 IndexedDB；设置与交易者标注保存在
  `chrome.storage.local`；连接状态保存在 `chrome.storage.session`。默认保留
  30 天或最多 20,000 条动态，以先达到的限制为准。
- **去重**：稳定的事件 ID 可避免断线重放产生重复记录。
- **本地化**：界面支持英语和简体中文。交易观点可通过 Chrome 138 内置 AI
  翻译器在设备端翻译，无需上传文本。
- **信息流恢复**：重连或手动刷新后可从 Fomo 登录态历史接口补录遗漏动态；
  此功能在获得已验证的真实响应前保持禁用。

### 架构

```text
Fomo page (MAIN world interceptor) --postMessage--> Fomo bridge (ISOLATED world)
  --> service worker (ingest: normalize -> insert -> broadcast -> enrich)
  --> shared feed UI
      |--> Chrome Side Panel
      `--> activation host --user gesture--> always-on-top Document PiP
```

service worker 是基于可注入模块的轻量组合入口。所有跨上下文消息都经过版本化、
发送者校验的协议（`src/messaging/`），content scripts 不会运行在 `<all_urls>`。
悬浮模式的扩展宿主只负责接收用户激活和承载 PiP 生命周期；真正置顶的信息流
运行在 Document PiP 中，不使用原生助手、页面注入或普通弹窗伪装置顶。

### 支持范围与隐私边界

- 识别 BSC、Solana、Robinhood、Base、Ethereum、X Layer，以及 `unknown`
  占位值。Fomo network ID 映射在真实登录数据验证前会显示为 `unknown`。
- 仅在 `https://fomo.family/*` 与 `https://www.fomo.family/*` 注入捕获脚本；
  不申请 DexScreener、GMGN、`<all_urls>` 或 Cookie 权限。
- 扩展仅提供信息展示，不会下单、跟单、修改钱包状态，也不会读取私钥或凭据。
- 实时信息流要求至少一个已登录的 Fomo 页面保持打开。
- 实时监控 Fomo 关闭后的动态与云同步不在当前 MVP 范围内。

### 本地开发

```bash
pnpm install
pnpm dev        # development build with live reload
pnpm build      # production build -> .output/chrome-mv3
```

维护者可运行 `corepack pnpm package:local` 生成安装包。产物和 SHA-256 校验文件
位于 `.output/releases/`，生成的二进制文件不提交到 Git 仓库。

### 文档

- [版本更新记录](CHANGELOG.md)
- [后续版本路线图](ROADMAP.md)
- [开发指南](docs/development.md)
- [中文手工测试指南](docs/manual-testing.zh-CN.md)
- [始终置顶悬浮窗验证矩阵](docs/testing/always-on-top-floating-window.md)
- [隐私与数据处理说明](docs/privacy.md)
- [设计规格](docs/superpowers/specs/2026-08-20-fomo-live-feed-extension-design.md)
- [实施计划](docs/superpowers/plans/2026-08-20-fomo-live-feed-extension.md)

---

## English

Fomo Live Feed is a Chrome extension that surfaces real-time activity from
traders followed by the authenticated Fomo user in Chrome's Side Panel or an
always-on-top Document Picture-in-Picture window. It stores a searchable,
filterable local history without injecting floating notification cards into
trading pages.

> **MVP status:** The core implementation is covered by unit, integration, and
> end-to-end tests. The production Fomo enrichment and REST backfill adapters
> remain disabled until real authenticated responses are captured and redacted;
> see the [development guide](docs/development.md). Until then, cards display
> base activity fields with related metrics marked unavailable, and reconnect
> backfill is unavailable.

### Download and install

**Direct download:** [Fomo Live Feed v0.5.1 for Chrome](https://github.com/novus77/Fomo-Live-Feed/releases/download/v0.5.1/Fomo-Live-Feed-v0.5.1-chrome.zip)

You can also navigate through GitHub: **Repository home → Releases → Latest →
Assets → `Fomo-Live-Feed-v0.5.1-chrome.zip`**.

1. Download and extract `Fomo-Live-Feed-v0.5.1-chrome.zip`.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** in the top-right corner.
4. Select **Load unpacked** and choose the extracted directory.
5. Keep an authenticated Fomo and/or Pump page open; the extension automatically restores the matching source after an extension reload.
6. Select the extension icon to open the feed; choose Side Panel or floating mode in Settings.
   On first entry, the compact activation host asks you to select **Keep floating
   window on top**. The Document PiP opened by that gesture is the actual
   always-on-top feed.

Recipients do not need this repository, Node.js, or pnpm. `START-HERE.html` in
the extracted directory contains startup and troubleshooting guidance. The
extension requires **Chrome 141 or newer**.

To verify the download, get
`Fomo-Live-Feed-v0.5.1-chrome.zip.sha256` from the same Assets section.

### Features

- **Real-time capture:** A MAIN-world interceptor observes the production Fomo
  WebSocket and passes only validated `trading_activity` data to an isolated
  bridge and then the service worker. Cookies, headers, and tokens never cross
  this boundary.
- **Pump near-real-time activity:** The authenticated Pump page serially reads
  Following trades at a target one-second interval with automatic backoff,
  cursor catch-up, transaction deduplication, and explicit gap status.
- **Unified sources:** Select All Sources, Fomo only, or Pump only. Matching
  transactions merge source badges, while profile and token navigation follow
  the active source projection.
- **Side Panel history:** Newest-first pagination with unread state, search,
  action/chain/trader/token filters, trader labels and colors, pinning and
  muting, chain badges, and copyable contract addresses.
- **Chain visibility:** Independently toggle BSC, Solana, Robinhood, Base,
  Ethereum, and X Layer. Hidden chains stay out of the current feed and the
  selection persists locally.
- **Buy sound alerts:** Enable one global real-time buy alert in Settings. It is
  off by default and ignores duplicate, sell, thesis, transfer, and withdraw
  events.
- **Fomo navigation:** Select a token symbol to reuse an existing Fomo tab and
  open the verified chain-and-contract route. Unverifiable targets remain text.
- **Seamless Side Panel / always-on-top floating switching:** Both modes share
  the background connection, history, filters, settings, and annotations. The
  Side Panel first synchronizes a compact activation host; a direct user click
  then opens Document PiP. After PiP is ready the host is minimized, leaving
  exactly one interactive feed. PiP stays above Chrome tabs without consuming
  page width, while atomic return, native-close recovery, and reload handling
  prevent lost or duplicated feed state.
- **Compact terminal UI:** Semantic borders distinguish buy, sell, thesis, and
  transfer events. Toolbar, filters, settings, empty states, and loading
  feedback share one light/dark visual system without reducing feed density.
- **Local persistence:** Activity history is stored in IndexedDB; settings and
  trader annotations use `chrome.storage.local`; connection state uses
  `chrome.storage.session`. Retention defaults to 30 days or 20,000 events,
  whichever limit is reached first.
- **Deduplication:** Stable event IDs prevent reconnect replays from creating
  duplicate history rows.
- **Localization:** The interface supports English and Simplified Chinese.
  Trader opinions can be translated on-device with Chrome 138's built-in AI
  translator, without uploading the text.
- **Feed recovery:** After reconnect or manual refresh, the extension can
  backfill missed activity from Fomo's authenticated history endpoint; this
  remains disabled until verified production responses are available.

### Architecture

```text
Fomo page (MAIN world interceptor) --postMessage--> Fomo bridge (ISOLATED world)
  --> service worker (ingest: normalize -> insert -> broadcast -> enrich)
  --> shared feed UI
      |--> Chrome Side Panel
      `--> activation host --user gesture--> always-on-top Document PiP
```

The service worker is a thin composition root over injectable modules. Every
cross-context message uses a versioned, sender-validated protocol
(`src/messaging/`), and content scripts never run on `<all_urls>`.
The floating host exists only to collect the required activation and coordinate
the PiP lifecycle. The actual always-on-top feed runs in Document PiP; no native
helper, page injection, or ordinary-popup fallback is used.

### Supported scope and privacy boundaries

- Recognizes BSC, Solana, Robinhood, Base, Ethereum, X Layer, and an `unknown`
  sentinel. Fomo network-ID mappings render as `unknown` until verified with
  authenticated production data.
- Capture scripts run only on `https://fomo.family/*` and
  `https://www.fomo.family/*`; the extension requests no DexScreener, GMGN,
  `<all_urls>`, or cookie permissions.
- The extension is informational only. It never places or copies trades,
  changes wallet state, or reads private keys or credentials.
- Real-time delivery requires at least one authenticated Fomo page to remain
  open.
- Monitoring while Fomo is closed and cloud sync are outside the current MVP.

### Local development

```bash
pnpm install
pnpm dev        # development build with live reload
pnpm build      # production build -> .output/chrome-mv3
```

Maintainers can run `corepack pnpm package:local` to create the installation
archive. The ZIP and neighboring SHA-256 checksum are written to
`.output/releases/`; generated binaries are not committed to Git.

### Documentation

- [Changelog](CHANGELOG.md)
- [Roadmap](ROADMAP.md)
- [Development guide](docs/development.md)
- [Chinese manual testing guide](docs/manual-testing.zh-CN.md)
- [Always-on-top floating verification matrix](docs/testing/always-on-top-floating-window.md)
- [Privacy and data handling](docs/privacy.md)
- [Design specification](docs/superpowers/specs/2026-08-20-fomo-live-feed-extension-design.md)
- [Implementation plan](docs/superpowers/plans/2026-08-20-fomo-live-feed-extension.md)
