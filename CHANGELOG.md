# Changelog

本文档记录 Fomo Live Feed 每个正式版本新增、调整、修复和验证的内容。日期按
Asia/Shanghai 时区记录；安装包及校验文件请从对应的 GitHub Release 下载。

This document records the additions, changes, fixes, and validation completed
for every Fomo Live Feed release. Dates use the Asia/Shanghai timezone. Download
the installation archive and checksum from the corresponding GitHub Release.

## [0.3.0] - 2026-09-01

### 新增与优化

- 新增全局买入声音提示，默认关闭；开启后所有关注交易员的实时买入都会播放一次
  提示音，重复事件及其他动作不会触发。
- 新增安全的代币跳转：点击代币名称可复用并激活现有 Fomo 标签页，按事件链和
  合约地址打开对应页面；无法验证目标时保持普通文本。
- 新增六链可见性筛选，可分别开关 BSC、Solana、Robinhood、Base、Ethereum 和
  X Layer，并将选择结果保存在本地。
- 侧栏升级为紧凑专业终端风格，买入、卖出、观点、转入和转出使用不同语义色；
  统一顶部工具栏、筛选、设置、支持、诊断、空状态和加载反馈的视觉语言。
- 链标识改用扩展内置 SVG；补充明暗主题、键盘焦点和减少动态效果支持。
- 保持信息密度：窄侧栏中的卡片维持单行交易摘要，代币名称不再拉伸，链标签紧跟
  名称显示。

### 修复

- 修复声音播放失败可能影响事件投递的问题，并确保 offscreen 音频控制器只响应
  符合条件的实时买入。
- 修复代币跳转可能重复创建 Fomo 标签页或接受不可靠路由的问题。
- 修复链筛选在重新打开侧栏后丢失，以及所有链关闭时缺少明确反馈的问题。
- 修复加载骨架缺少可访问状态播报、浅色主题工具面板契约过时，以及窄宽度下代币
  名称与链标签间距异常的问题。

### 验证

- TypeScript 类型检查通过。
- 1,297 项单元及集成测试通过。
- 13 项 Playwright 端到端测试通过。
- Chrome Manifest V3 生产构建、本地安装包及 SHA-256 校验通过。

### Added and improved

- Added an opt-in global buy sound alert. Every real-time buy from followed
  traders plays once, while duplicate and non-buy events remain silent.
- Added verified token navigation that reuses and activates an existing Fomo
  tab and routes by event chain and contract address.
- Added persistent visibility toggles for BSC, Solana, Robinhood, Base,
  Ethereum, and X Layer.
- Rebuilt the Side Panel as a compact professional terminal with semantic event
  accents and unified toolbar, filters, settings, support, diagnostics, empty,
  and loading states.
- Replaced chain marks with packaged SVG assets and added light/dark theme,
  keyboard focus, and reduced-motion coverage.
- Preserved feed density with single-row trade summaries and compact inline
  token, chain, amount, and market-cap presentation.

### Fixed

- Isolated sound playback failures from event delivery and limited the
  offscreen audio controller to eligible real-time buys.
- Prevented duplicate Fomo tabs and rejected unverifiable token routes.
- Persisted chain filters across panel sessions and added a clear all-hidden
  state.
- Restored accessible loading announcements, current light-theme utility
  contracts, and compact token/chain spacing at narrow widths.

### Validation

- TypeScript type checking.
- 1,297 unit and integration tests.
- 13 Playwright end-to-end tests.
- Chrome Manifest V3 production build, local package, and SHA-256 verification.

## [0.2.0] - 2026-08-30

### 新增与优化

- 丰富信息卡：在事件数据可用时展示买入或卖出金额、所属链，以及带 `MC:`
  前缀的事件市值；缺失的市值保持为空，不额外请求或缓存数据。
- 新增紧凑筛选面板：可分别开关买入、卖出和观点，并按以 `K` 为单位的市值
  区间筛选；转入和转出不受这三个状态按钮影响，始终正常显示。
- 统一侧栏工具栏：筛选、刷新、设置和爱心打赏位于同一行；打赏仅显示爱心
  图标，并通过悬停提示说明用途。
- 优化卡片密度：相对时间移动到用户名同一行，复制按钮与完整 CA 地址对齐。
- 用户名链接改为打开对应的 Fomo 用户主页；Robinhood 链缩写统一为 `rh`。

### 修复

- 修复扩展重新加载或 Fomo 页面刷新后，翻译宿主无法自动恢复的问题。
- 修复 Fomo 标签页关闭或离开站点后，侧栏仍显示旧连接状态的问题。
- 调整筛选后的分页与刷新协调，避免新筛选条件只作用于当前已加载页面。

### 验证

- TypeScript 类型检查通过。
- 1,203 项单元及集成测试通过。
- 10 项 Playwright 端到端测试通过。
- 生产构建、Chrome 安装包生成及 SHA-256 校验通过。

### Added and improved

- Enriched activity cards with event-time buy or sell amount, chain, and `MC:`
  market cap when present in the captured event. Missing market cap stays blank;
  the extension performs no additional request or caching for it.
- Added compact buy, sell, thesis, and K-denominated market-cap range filters.
  Transfer and withdraw events remain visible independently of the three status
  toggles.
- Consolidated filter, refresh, settings, and icon-only support controls into a
  single Side Panel toolbar row.
- Reduced card height by placing relative time beside the trader name and
  aligning the copy control with the full contract address.
- Routed trader-name links to Fomo profiles and standardized Robinhood as `rh`.

### Fixed

- Restored translation automatically after extension or Fomo page reloads.
- Cleared stale connection state when a Fomo tab closes or leaves the site.
- Coordinated filtering with pagination and refresh so filters apply beyond the
  currently loaded page.

### Validation

- TypeScript type checking.
- 1,203 unit and integration tests.
- 10 Playwright end-to-end tests.
- Production build, Chrome package creation, and SHA-256 verification.

## [0.1.0] - 2026-08-23

### 首个正式版本

- 从已登录的 Fomo 页面捕获所关注交易者的实时 `trading_activity`，经严格校验、
  标准化和去重后写入本地历史。
- 使用 Chrome 右侧边栏展示信息流，支持最新优先分页、未读状态、搜索，以及按
  动作、链、交易者和代币筛选。
- 支持交易者标签、颜色、置顶和静音，以及链标识和合约地址复制。
- 使用 IndexedDB 保存动态历史，使用 Chrome 本地及会话存储保存设置和连接状态；
  默认保留 30 天或最多 20,000 条记录。
- 支持英语、简体中文、明暗主题，以及 Chrome 内置设备端翻译；内置翻译不可用时
  可回退到页面翻译通道。
- 增加连接诊断、手动刷新、重连恢复框架和本地安装包生成流程。
- 捕获脚本仅运行于 Fomo 域名，不申请 Cookie、`<all_urls>` 或交易权限；扩展只
  展示信息，不会执行交易或读取钱包凭据。
- 移除交易页面上的浮动通知卡片，将交互集中到右侧边栏，减少对 Fomo 页面的干扰。

### Initial release

- Captured followed-trader `trading_activity` from an authenticated Fomo page,
  then validated, normalized, deduplicated, and stored it locally.
- Presented a newest-first Side Panel feed with pagination, unread state,
  search, and action, chain, trader, and token filters.
- Added trader labels, colors, pinning, muting, chain badges, and copyable
  contract addresses.
- Persisted activity in IndexedDB and settings or connection state in Chrome
  local and session storage, with a default 30-day or 20,000-event limit.
- Added English and Simplified Chinese UI, light and dark themes, and Chrome's
  on-device translation with a page-hosted fallback path.
- Added connection diagnostics, manual refresh, recovery foundations, and a
  reproducible local packaging workflow.
- Limited capture to Fomo domains without cookie, `<all_urls>`, or trading
  permissions. The extension displays information only and never reads wallet
  credentials or places trades.
- Removed floating trading-page notifications and consolidated interaction in
  Chrome's Side Panel.

[0.2.0]: https://github.com/novus77/Fomo-Live-Feed/releases/tag/v0.2.0
[0.1.0]: https://github.com/novus77/Fomo-Live-Feed/releases/tag/v0.1.0
[0.3.0]: https://github.com/novus77/Fomo-Live-Feed/releases/tag/v0.3.0
