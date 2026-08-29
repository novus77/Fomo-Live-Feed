# Fomo Live Feed

[简体中文](#简体中文) | [English](#english)

## 简体中文

Fomo Live Feed 是一款 Chrome 扩展，通过 Chrome 右侧边栏展示当前 Fomo
登录用户所关注交易者的实时动态。扩展会在本地保存可搜索、可筛选的历史记录，
不会在交易页面注入额外的浮动通知卡片。

> **MVP 状态：**核心功能已经实现，并通过单元、集成及端到端测试。用于补充
> 生产数据的 Fomo enrichment 与 REST backfill 适配器仍保持禁用，等待获取并
> 脱敏真实登录响应后再启用，详情见[开发指南](docs/development.md)。在此之前，
> 卡片会展示基础动态字段，将相关指标标记为不可用；断线重连补录也暂不可用。

### 下载与安装

**直接下载：**[Fomo Live Feed v0.2.0（Chrome ZIP）](https://github.com/novus77/Fomo-Live-Feed/releases/download/v0.2.0/Fomo-Live-Feed-v0.2.0-chrome.zip)

也可以从 GitHub 页面依次进入：**仓库首页 → Releases → Latest → Assets →
`Fomo-Live-Feed-v0.2.0-chrome.zip`**。

1. 下载并解压 `Fomo-Live-Feed-v0.2.0-chrome.zip`。
2. 在 Chrome 地址栏打开 `chrome://extensions`。
3. 开启右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择刚刚解压的目录。
5. 保持至少一个已登录的 Fomo 页面处于打开状态，并在首次安装或重新加载扩展后刷新该页面。
6. 点击扩展图标，在 Chrome 右侧边栏查看实时信息流。

接收者无需安装此仓库、Node.js 或 pnpm。解压目录中的 `START-HERE.html`
包含启动及故障排查清单。扩展要求 **Chrome 138 或更高版本**。

如需校验下载文件，可在同一 Assets 区域下载
`Fomo-Live-Feed-v0.2.0-chrome.zip.sha256`。

### 主要功能

- **实时捕获**：MAIN world interceptor 监听 Fomo 生产 WebSocket，仅将通过
  校验的 `trading_activity` 数据传递给隔离 bridge，再转交 service worker；
  Cookie、请求头及令牌不会跨越该边界。
- **右侧边栏历史**：按时间倒序分页，支持未读状态、搜索、动作/链/交易者/
  代币筛选、交易者标签与颜色、置顶与静音、链标识和合约地址复制。
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
  --> Chrome Side Panel (history, search, filters, annotations, diagnostics)
```

service worker 是基于可注入模块的轻量组合入口。所有跨上下文消息都经过版本化、
发送者校验的协议（`src/messaging/`），content scripts 不会运行在 `<all_urls>`。

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

- [开发指南](docs/development.md)
- [中文手工测试指南](docs/manual-testing.zh-CN.md)
- [隐私与数据处理说明](docs/privacy.md)
- [设计规格](docs/superpowers/specs/2026-08-20-fomo-live-feed-extension-design.md)
- [实施计划](docs/superpowers/plans/2026-08-20-fomo-live-feed-extension.md)

---

## English

Fomo Live Feed is a Chrome extension that surfaces real-time activity from
traders followed by the authenticated Fomo user in Chrome's Side Panel. It
stores a searchable, filterable local history without injecting floating
notification cards into trading pages.

> **MVP status:** The core implementation is covered by unit, integration, and
> end-to-end tests. The production Fomo enrichment and REST backfill adapters
> remain disabled until real authenticated responses are captured and redacted;
> see the [development guide](docs/development.md). Until then, cards display
> base activity fields with related metrics marked unavailable, and reconnect
> backfill is unavailable.

### Download and install

**Direct download:** [Fomo Live Feed v0.2.0 for Chrome](https://github.com/novus77/Fomo-Live-Feed/releases/download/v0.2.0/Fomo-Live-Feed-v0.2.0-chrome.zip)

You can also navigate through GitHub: **Repository home → Releases → Latest →
Assets → `Fomo-Live-Feed-v0.2.0-chrome.zip`**.

1. Download and extract `Fomo-Live-Feed-v0.2.0-chrome.zip`.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** in the top-right corner.
4. Select **Load unpacked** and choose the extracted directory.
5. Keep at least one authenticated Fomo page open, and refresh it after the initial installation or an extension reload.
6. Select the extension icon to open the real-time feed in Chrome's Side Panel.

Recipients do not need this repository, Node.js, or pnpm. `START-HERE.html` in
the extracted directory contains startup and troubleshooting guidance. The
extension requires **Chrome 138 or newer**.

To verify the download, get
`Fomo-Live-Feed-v0.2.0-chrome.zip.sha256` from the same Assets section.

### Features

- **Real-time capture:** A MAIN-world interceptor observes the production Fomo
  WebSocket and passes only validated `trading_activity` data to an isolated
  bridge and then the service worker. Cookies, headers, and tokens never cross
  this boundary.
- **Side Panel history:** Newest-first pagination with unread state, search,
  action/chain/trader/token filters, trader labels and colors, pinning and
  muting, chain badges, and copyable contract addresses.
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
  --> Chrome Side Panel (history, search, filters, annotations, diagnostics)
```

The service worker is a thin composition root over injectable modules. Every
cross-context message uses a versioned, sender-validated protocol
(`src/messaging/`), and content scripts never run on `<all_urls>`.

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

- [Development guide](docs/development.md)
- [Chinese manual testing guide](docs/manual-testing.zh-CN.md)
- [Privacy and data handling](docs/privacy.md)
- [Design specification](docs/superpowers/specs/2026-08-20-fomo-live-feed-extension-design.md)
- [Implementation plan](docs/superpowers/plans/2026-08-20-fomo-live-feed-extension.md)
