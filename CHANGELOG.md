# Changelog

本文档记录 Fomo Live Feed 每个正式版本新增、调整、修复和验证的内容。日期按
Asia/Shanghai 时区记录；安装包及校验文件请从对应的 GitHub Release 下载。

This document records the additions, changes, fixes, and validation completed
for every Fomo Live Feed release. Dates use the Asia/Shanghai timezone. Download
the installation archive and checksum from the corresponding GitHub Release.

## [Unreleased]

## [0.6.0] - 2026-09-19

### 新增与优化

- 新增 ARC 链完整支持：网络 ID 识别、事件归一化、链筛选、卡片标签、
  内置矢量图标、合约地址验证与 Fomo 代币跳转。
- 增强 Fomo / Pump 双来源运行时稳定性，完善扩展重载后的数据恢复、
  分页衔接、事件去重、缺口状态与设置写入协调。
- 已有用户的链可见性设置会安全迁移，ARC 默认加入可见链，不覆盖
  其他本地偏好。

### 修复

- 修复插件已经持续接收 Fomo 实时交易，但因错过 WebSocket 一次性
  `open` 事件而错误显示“登录 Fomo”的状态矛盾。
- 已验证的 WebSocket、Fetch 或 XHR 交易活动现在可以恢复连接与认证
  状态，未登录且没有有效活动的页面仍保持未认证。

### 验证

- TypeScript 类型检查通过。
- 1,817 项单元及集成测试通过。
- 19 项 Playwright 端到端测试和 16 项官网契约测试通过。
- Chrome Manifest V3 生产构建、本地 ZIP 安装包及
  SHA-256 校验通过。

### Added and improved

- Added complete ARC support across network ID mapping, event normalization,
  chain filtering, card badges, the bundled vector icon, contract validation,
  and Fomo token navigation.
- Hardened the unified Fomo/Pump runtime across reload recovery, pagination,
  event deduplication, gap state, and serialized preference mutations.
- Migrated existing chain-visibility preferences without overwriting other
  local settings, adding ARC to the default visible-chain set.

### Fixed

- Fixed the contradictory state where live Fomo trades continued to arrive
  while the extension asked the user to log in because it missed the socket's
  one-shot `open` event.
- Validated activity from WebSocket, fetch, or XHR can now recover connected
  and authenticated state while genuinely unauthenticated pages remain offline.

### Validation

- Passed TypeScript checking and 1,817 unit/integration tests.
- Passed 19 Playwright end-to-end tests and 16 website contract tests.
- Passed the Chrome Manifest V3 production build, local ZIP packaging, and
  SHA-256 verification.

## [0.5.1] - 2026-09-11

### 修复

- 修复 Fomo 页面节点重绘后，同一笔买入或卖出可能被 DOM 回退通道重复采集的问题。
- DOM 回退事件改用链接中的稳定 `tradeId`；WebSocket、接口响应与 DOM 捕获到同一
  Fomo 交易时合并为一条，同时保留真实的连续分笔交易。
- 数据库升级至版本 4，首次运行时清理旧版生成的不稳定 DOM 回退记录；WebSocket、
  API 和 Pump 历史不受影响。

### 验证

- TypeScript 类型检查通过。
- 1,758 项单元及集成测试通过。
- Chrome Manifest V3 生产构建、本地 ZIP 安装包及 SHA-256 校验通过。

### Fixed

- Prevented a rendered Fomo trade from being captured repeatedly by the DOM
  fallback when the page replaces its node or updates relative time and market cap.
- Keyed DOM fallback trades by the stable `tradeId` embedded in Fomo links and
  merged matching WebSocket, response, and DOM captures without collapsing real
  split transactions.
- Upgraded the database to version 4 to remove unstable legacy DOM fallback rows
  while preserving WebSocket, API, and Pump history.

### Validation

- Passed TypeScript checking and 1,758 unit/integration tests.
- Passed the Chrome Manifest V3 production build, local ZIP packaging, and
  SHA-256 verification.

## [0.5.0] - 2026-09-10

### 新增与优化

- 新增 Pump Following 交易动态采集，在已登录页面内以一秒为目标间隔串行轮询，
  不读取、保存或转发登录凭据。
- 新增 Fomo / Pump 双来源状态与单选筛选；“全部来源”按时间混排，单来源模式仅展示
  对应平台标识、用户链接和代币跳转。
- Pump 交易卡展示买入/卖出、USD 金额、事件市值、链、代币和合约地址，并新增买入
  金额区间筛选。
- 新增自动退避、游标分页补齐、初始水位、重连去重与可能缺口提示。
- 信息流改为更紧凑的三行卡片，增加来源图标和快速状态/来源筛选，同时保留现有代币
  排版、交易员备注、翻译与始终置顶模式。

### 修复

- 防止 Fomo 的观点和 DOM 占位行被错误识别为买入，并清理已存储的无效回退记录。
- 合并具有同一交易身份的 Fomo / Pump 记录，保留两个来源而不重复展示。
- 稳定异步筛选恢复、分页加载和画中画重载的测试时序。

### 验证

- 实际登录页面同时显示 `Fomo: 已连接` 和 `Pump: 实时`，Pump 新买入/卖出可进入信息流。
- 全部来源、仅 Fomo 和仅 Pump 三种模式手工验证通过。
- TypeScript 类型检查、1,753 项单元及集成测试、19 项 Playwright 端到端测试和
  Chrome Manifest V3 生产构建通过。

### Added and improved

- Added Pump Following trade collection through strictly serialized authenticated-page polling at a
  target interval of one second without reading, storing, or forwarding authentication material.
- Added independent Fomo and Pump status plus exclusive source filters. All Sources merges both feeds
  chronologically; single-source mode projects matching badges, profile links, and token navigation.
- Added Pump buy/sell cards with USD amount, event market cap, chain, token, and contract address, plus
  a buy-amount range filter.
- Added automatic backoff, cursor catch-up, initial watermarks, reconnect deduplication, and explicit
  possible-gap status for the near-real-time Pump collector.
- Refined the feed into compact three-row cards with source icons and quick action/source filters while
  preserving token layout, annotations, translation, and always-on-top mode.

### Fixed

- Prevented Fomo opinion and DOM placeholder rows from being mislabeled as buys and removed persisted
  invalid fallback history.
- Merged matching Fomo and Pump transaction identities while preserving both source badges.
- Stabilized asynchronous filter recovery, pagination, and Picture-in-Picture reload test timing.

### Validation

- Confirmed simultaneous `Fomo: Connected` and `Pump: Live` states on authenticated production pages,
  including new Pump buy and sell delivery.
- Manually verified All Sources, Fomo-only, and Pump-only modes.
- Passed TypeScript checking, 1,753 unit/integration tests, 19 Playwright E2E tests, and the Chrome
  Manifest V3 production build.

## [0.4.0] - 2026-09-07

### 新增与优化

- 将可选悬浮模式升级为始终置顶的 Document Picture-in-Picture 信息流。
  侧边栏先与小型激活宿主完成原子切换，用户一次直接点击后打开 PiP；
  PiP 就绪后宿主最小化，全程只保留一个可交互信息流。
- PiP 完整复用紧凑信息流、连接状态、筛选、设置、支持、交易员备注、
  翻译、未读和声音行为；在 Chrome 标签页之间切换或导航时仍保持在最前，
  且不占用侧边栏宽度。
- 新增 PiP 内“返回侧边栏”原子切换、原生关闭后宿主恢复、失败重试、重复
  激活去重与扩展重载恢复；不增加权限，不使用普通弹窗作为伪置顶降级。
- 将顶部工具栏的爱心图标替换为明确的“捐赠”文字按钮，保持原有高度与交互反馈。

### 修复

- 修复快速重复切换、激活被拒绝、原生关闭和扩展重载时可能出现的
  旧会话、重复窗口或原界面提前关闭问题。

### 验证

- TypeScript 类型检查通过。
- 1,596 项单元及集成测试通过。
- 19 项 Playwright 端到端测试通过。
- 官网 14 项契约测试通过。
- Chrome Manifest V3 生产构建、本地安装包及 SHA-256 校验通过。

### Added and improved

- Upgraded floating mode to an always-on-top Document Picture-in-Picture feed.
  The Side Panel completes an atomic handoff through a compact activation host;
  after PiP is ready, only one interactive feed remains.
- Reused the complete compact feed in PiP, including connection state, filters,
  Settings, Support, trader annotations, translation, unread state, and sound.
  It remains above Chrome tabs during navigation without consuming Side Panel width.
- Added atomic **Return to Side Panel**, native-close recovery, retryable failures,
  repeated-activation deduplication, and safe extension-reload recovery without
  adding permissions or an ordinary-popup fallback.
- Replaced the heart-only toolbar control with an explicit localized donation
  label while preserving the existing height and interaction feedback.

### Fixed

- Prevented stale sessions, duplicate windows, and premature source closure during
  rapid repeated switches, rejected activation, native close, and extension reload.

### Validation

- TypeScript type checking.
- 1,596 unit and integration tests.
- 19 Playwright end-to-end tests.
- 14 website contract tests.
- Chrome Manifest V3 production build, local package, and SHA-256 verification.

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
[0.4.0]: https://github.com/novus77/Fomo-Live-Feed/releases/tag/v0.4.0
[0.5.0]: https://github.com/novus77/Fomo-Live-Feed/releases/tag/v0.5.0
[0.5.1]: https://github.com/novus77/Fomo-Live-Feed/releases/tag/v0.5.1
[0.6.0]: https://github.com/novus77/Fomo-Live-Feed/releases/tag/v0.6.0
