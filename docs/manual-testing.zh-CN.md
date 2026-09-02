# Fomo Live Feed 手工测试指南

本文用于在真实 Chrome、真实 Fomo 登录态和真实交易页面中验证 MVP。测试期间只记录问题，不直接修改代码；测试结束后统一进入修复和回归阶段。

## 纯净信息流与主题切换

1. 打开 Side Panel，确认右上角依次显示“刷新”“设置”“打赏”，不显示“就绪”。
2. 检查任意信息卡片，确认没有“标签”按钮、标签文字或编辑器；交易员、代币、链、金额、观点和 CA 仍正常显示。
3. 打开设置，确认保留自动翻译开关和目标语言，但没有“初始化本地翻译”按钮和下载进度。
4. 点击太阳图标，确认 Side Panel 立即切换为浅色主题；关闭并重新打开 Side Panel，确认浅色主题保留。
5. 点击月亮图标，确认恢复深色主题。明暗主题下的买入/卖出色和链标识色应保持一致。
6. 让 Fomo 产生一条英文观点，确认原文立即显示，且下方仍会自动出现翻译，不需要手动初始化。

## 1. 当前测试目标

本轮重点确认：

- Fomo 已关注交易员的实时活动能否进入插件。
- DexScreener 和 GMGN 页面不会出现 Fomo Live Feed 浮动通知卡片。
- 插件 Side Panel 以无控件的纯净 feed 展示，搜索与筛选仅保留在 Popup 历史页。
- 标签、静音、置顶和语言/翻译设置能否本地保存；V3 设置已移除可配置指标。
- 断线、关闭 Fomo 标签页、退出登录和浏览器重启后的状态是否合理。
- 插件是否始终保持只读，不影响交易页面和钱包操作。
- 已验证的六条链（BSC / Solana / Robinhood / Base / Ethereum / X Layer）是否显示正确链徽和可复制的精确 CA。
- 交易员粉丝数仅在有效时 inline 显示，缺失/无效时不显示 0 或 Unavailable。
- Settings 是唯一的 UI 语言切换入口；opinion 翻译独立运行，不随 UI 语言变化。
- 英文 thesis 能否通过 Chrome 本地翻译 API 自动翻译并可在原文/译文间切换。

## 2. 测试前已知限制

以下现象已登记，不需要重复报告，除非实际表现与描述不同：

1. **断线/刷新回填不可用。** 生产环境使用 `unavailableHistoryClient`，真实历史接口捕获前不会发起 REST 回填请求。
2. **退出登录可能显示“重连中”。** 如果 Fomo 页面仍然打开，只关闭了 WebSocket，插件目前不能立即区分“已退出登录”和“暂时断线”；刷新 Fomo 页面后才可能显示“需要登录”。
3. 测试套件存在少量 React `act(...)` 警告，但当前 1100+ 项单元/集成测试与 E2E 测试均通过。这属于测试代码清理项，不影响手工使用。

已移除的限制（本轮实现）：

- network ID 已按捕获证据映射到 BSC / Solana / Robinhood / Base / Ethereum / X Layer；未列出的 ID 显示为 `unknown`。
- 卡片不再展示 7 日盈亏/胜率/指标网格；仅在有有效值时 inline 展示粉丝数。
- Side Panel 不再保留搜索、筛选、未读/置顶 chip、重置按钮和主视图语言切换。

## 3. 测试环境

### 3.1 必要条件

- macOS 或 Windows。
- Chrome 138 或更新版本（内置翻译 API 和 Side Panel 需要），建议记录完整版本号。
- Node.js 22 或更高版本。
- pnpm 10.15.0。
- 一个可以正常使用的 Fomo 账号。
- Fomo 账号至少关注一位近期可能发生交易的交易员。

查看 Chrome 版本：

```text
Chrome menu → Help → About Google Chrome
```

### 3.2 项目目录

所有命令均在以下目录执行：

在当前仓库根目录运行后续命令；不要使用文档作者机器上的绝对路径。

确认当前分支与状态：

```bash
git branch --show-current
git status --short
```

预期位于待发布分支，且 `git status --short` 不包含意外的代码改动。

## 4. 构建并安装插件

### 4.1 安装依赖

首次测试或依赖发生变化时执行：

```bash
corepack pnpm install
```

不要执行 `corepack enable`。该命令会尝试在 `/usr/local/bin` 创建或修改
`pnpm` 符号链接，普通 macOS 用户可能收到 `EACCES: permission denied`。
本项目不需要全局安装 pnpm；`corepack pnpm` 会直接使用
`package.json` 指定的 pnpm 10.15.0。

确认版本：

```bash
corepack pnpm --version
```

预期输出：

```text
10.15.0
```

### 4.2 运行自动基线

```bash
corepack pnpm check
corepack pnpm test:e2e
```

预期：

- TypeScript 类型检查通过。
- 单元和集成测试全部通过。
- 生产构建成功。
- Chromium E2E 测试通过。

如果这里只出现 React `act(...)` warning，但最终测试通过，可以继续手工测试并在记录中注明。其他失败应立即记录。

### 4.3 构建生产版本

如果未执行 `corepack pnpm check`，单独执行：

```bash
corepack pnpm build
```

构建目录：

```text
.output/chrome-mv3
```

### 4.4 加载到 Chrome

1. 在 Chrome 地址栏打开 `chrome://extensions`。
2. 打开右上角 **Developer mode / 开发者模式**。
3. 点击 **Load unpacked / 加载已解压的扩展程序**。
4. 选择绝对路径：

   ```text
   <当前仓库>/.output/chrome-mv3
   ```

5. 确认扩展列表出现 **Fomo Live Feed**，且没有红色错误。
6. 点击浏览器工具栏的扩展菜单，将 Fomo Live Feed 固定到工具栏。
7. 点击扩展图标，确认 Chrome 侧边栏打开 `sidepanel.html`，而不是弹出式窗口。

每次重新执行 `corepack pnpm build` 后：

1. 回到 `chrome://extensions`。
2. 点击 Fomo Live Feed 卡片上的刷新按钮。
3. 刷新所有 Fomo 测试标签页。

必须刷新已打开的 Fomo 页面：MAIN-world observer 只能在页面注入后观测
新建的 WebSocket。如果侧边栏提示 observer 未就绪或 socket 未观测到，
先刷新 Fomo 页面，不要把该状态解读为历史丢失。

### 4.5 本地分发包验收

生成普通用户可直接解压加载的发布包：

```bash
corepack pnpm package:local
```

产物位于 `.output/releases/`，包含 ZIP 和同名 `.sha256` 文件。验收步骤：

1. 使用 `shasum -a 256 -c` 校验 SHA-256。
2. 将 ZIP 解压到临时目录，确认 `manifest.json` 和 `START-HERE.html` 位于根目录。
3. 确认包内没有 `src/`、`tests/`、`node_modules/`、`.git/` 或 `.env`。
4. 在 `chrome://extensions` 打开开发者模式，点击“加载已解压的扩展程序”，选择该临时目录。
5. 确认扩展图标能打开 Side Panel，且“设置”和“打赏”面板互斥。
6. 保持 Fomo 已登录，刷新一次 Fomo 页面，再验证实时动态链路。

接收者不需要安装 Node.js、pnpm，也不需要获得源码仓库。

### 4.6 `corepack enable` 权限错误

如果看到类似错误：

```text
Internal Error: EACCES: permission denied, symlink ... -> /usr/local/bin/pnpm
```

不需要使用 `sudo`，也不要修改 `/usr/local/bin` 权限。直接跳过
`corepack enable`，执行：

```bash
corepack pnpm install
corepack pnpm check
corepack pnpm test:e2e
```

如果 `corepack pnpm --version` 不是 `10.15.0`，记录完整输出后停止，避免用不一致的包管理器改写锁文件。

如果之前看到：

```text
sh: pnpm: command not found
ELIFECYCLE Command failed
```

这是旧版 `check` 脚本在内部再次调用全局 `pnpm` 导致的。提交
`package.json` 修复后，`check` 会直接运行项目本地的 `tsc`、`vitest` 和
`wxt`，不再依赖全局 `pnpm`。

## 5. 测试准备

打开以下页面：

1. 一个已登录的 Fomo 页面：`https://fomo.family/`
2. 一个 DexScreener 页面：`https://dexscreener.com/`
3. 一个 GMGN 页面：`https://gmgn.ai/`

测试期间至少保持一个已登录 Fomo 标签页打开。MVP 没有后台数据服务；关闭全部 Fomo 标签页后，不会继续收到实时活动。

点击扩展图标打开 Chrome Side Panel，先记录初始状态：

- 是否显示已连接、重连中、离线或需要登录。
- 是否存在历史消息。
- 是否出现扩展错误或空白页面。

## 6. 核心测试用例

每项记录为 `通过 / 失败 / 未触发 / 不适用`。

### MT-01：Fomo 登录与连接状态

步骤：

1. 保持 Fomo 已登录页面打开。
2. 等待 10 秒。
3. 点击 Fomo Live Feed 图标。

预期：

- Side Panel 不显示“请先登录 Fomo”。
- 当 Fomo 实时 socket 已建立时显示已连接状态。
- 插件页面无崩溃或持续刷新的现象。

记录：

```text
结果：
Side Panel 状态：
等待时间：
备注：
```

### MT-02：实时买入/卖出消息

前提：已关注交易员产生真实活动。

步骤：

1. 保持 Fomo 标签页打开。
2. 打开 Fomo Live Feed Side Panel。
3. 等待已关注交易员产生买入、卖出或 thesis 活动。
4. 记录 Fomo 页面出现活动和 Side Panel 信息流更新的时间。

预期：

- Side Panel 出现新卡片，交易页面不出现浮动卡片。
- 卡片包含交易员、动作、代币、链、金额或时间等可用字段；粉丝数仅在有效时显示。
- Side Panel 内容与 Fomo 原始活动一致。
- 同一事件不会重复进入信息流。
- 已验证链显示精确链徽和可复制的合约地址；未知链仅显示文本、不提供复制按钮。

记录：

```text
结果：
活动类型：buy / sell / thesis / other
Fomo 出现时间：
Side Panel 更新时间：
估算延迟：
链：
代币：
交易员：
```

### MT-03：交易页面无注入

步骤：

1. 分别打开 DexScreener 和 GMGN。
2. 等待 Side Panel 收到至少一条实时活动。
3. 检查两个交易页面的左下角、右下角和页面 DOM。

预期：

- 两个页面都不会出现 Fomo Live Feed 浮动通知卡片。
- 页面 DOM 中不存在 `#fomo-live-feed-toast-host`。
- 所有活动只进入右侧 Side Panel 信息流。

### MT-04：Side Panel 卡片交互

分别验证：

- 点击卡片打开正确的 Fomo 代币页面。
- 点击交易员打开正确的 Fomo 主页。
- 点击合约复制完整地址，且复制内容与链上地址一致。
- 头像或代币图片失败时出现安全的占位内容。

预期：不触发交易、不连接钱包、不修改原交易页面表单。

### MT-04A：已验证链与精确 CA

对 BSC / Solana / Robinhood / Base / Ethereum / X Layer 中的至少两条真实活动验证：

- Side Panel 卡片显示正确的链徽（如 BSC / SOL / Robinhood / Base / ETH / X Layer）。
- 点击合约地址复制按钮，粘贴到文本编辑器的内容与 Fomo 原始地址完全一致。
- 未知链（未列出的 networkId）仅显示 `Unknown` 文本，无复制按钮。

### MT-04B：粉丝数 inline 显示

观察带粉丝数的活动：

- 有效非负整数粉丝数显示在交易员 handle 旁（例如 `1.23K followers`）。
- 缺失、0、负数、非整数或无效值不显示任何粉丝后缀（不显示 `0 followers` 或 `Unavailable`）。

### MT-05：Side Panel 历史消息

步骤：

1. 收到至少一条实时消息。
2. 关闭 Side Panel。
3. 再次点击扩展图标打开 Side Panel。

预期：

- 消息仍在历史记录中。
- 最新消息排在前面。
- Side Panel 主视图无搜索框、Filters、Unread、Pinned、chip、Reset、主视图语言切换。
- 关闭并重新打开 Side Panel 后，历史仍存在。

### MT-05A：Popup 历史搜索与筛选

在 Popup 历史页中依次测试：搜索框始终可见，其他条件收纳在 **Filters** 紧凑弹层中，生效条件以 chip 显示。

- 搜索交易员名称或 handle。
- 搜索自定义标签。
- 搜索代币 Symbol。
- 搜索完整合约地址。
- 过滤 buy / sell / thesis。
- 按链过滤。
- 只看未读 / 置顶优先。

预期：结果准确，清除条件后恢复完整列表；无结果时显示明确空状态。

逐条检查历史卡片的链 badge 与完整 CA；点击复制后粘贴到本地
文本编辑器核对，同时确认 Popup 未跳转、未打开交易页。

### MT-06：Side Panel 纯净 feed 验证

在 Side Panel 中验证：

- 不存在搜索框、Filters 按钮、Unread/Pinned 按钮、chip、Reset 按钮。
- 不存在主视图 EN / 中文切换器。
- 仅保留右上角 Settings 齿轮和 Refresh 按钮。
- 卡片正常展示身份、动作、代币、链、金额、时间、可选粉丝数。

### MT-06A：管线诊断

1. 点击右上角设置按钮，找到 **Pipeline diagnostics**。
2. `Observer ready` 表示观测器已注入；`Socket observed / open` 表示已观测到
   打开的 Fomo socket。两者任一缺失时先刷新 Fomo 页面。
3. 真实活动后比较 `Candidate → Accepted → Persisted → Broadcast`；前一阶段
   增长而后一阶段不增长，即定位为两阶段之间。`Rejected` 增长时记录
   `Last rejection`，但不要收集原始 frame。
4. 诊断只是关闭字段投影，不是 REST 补数源。REST backfill 仍禁用，
   直到取得真实认证、完成脱敏的证据并单独评审。

### MT-07：交易员标签、置顶和静音

步骤：

1. 给某位交易员添加标签和颜色。
2. 将交易员置顶。
3. 关闭并重新打开 Side Panel。
4. 静音该交易员，并等待该交易员后续活动。

预期：

- 标签、颜色和置顶状态保留。
- 旧版通知/静音字段不会影响 Side Panel 接收活动。
- 删除标签后不会在刷新或重启后恢复旧标签。

### MT-08：语言与翻译设置

步骤：

1. 打开 Side Panel Settings。
2. 在 Language 区域点击 **中文** 切换 UI 语言。
3. 观察主视图文字变为中文后，返回 Settings。
4. 关闭 **Enable local translation** 开关。
5. 将 **Target language** 从 Auto 改为 **中文**。
6. 重新打开 Enable local translation。
7. 在新 Chrome profile 或未下载语言包的环境中，点击 **Initialize local translation**。
8. 确认界面显示下载进度，最终变为已就绪；回到信息流观察已有英文 thesis 自动重试翻译。

预期：

- UI 语言切换仅影响界面文字，不影响 opinion 翻译偏好。
- Settings 重新打开后，语言与翻译偏好均保留。
- UI 语言切换不再出现在 Side Panel 主视图或 Popup 主视图。
- 关闭 translation 后 thesis 不再自动翻译；启用后按 target language 翻译。
- 首次语言包下载只需一次明确的用户点击；模型就绪后，后续卡片自动翻译，无需逐条点击。
- 翻译过程不新增 `scripting` 权限，文本不发送到第三方翻译服务。

### MT-09：DexScreener 与 GMGN 无注入

分别在两个网站验证：

- 页面不会出现 Fomo Live Feed 浮动通知卡片。
- 插件不会读取、清空或修改页面输入框。
- 页面路由跳转后仍不存在 `#fomo-live-feed-toast-host`。
- 其他网站同样不会出现插件浮动通知。

## 7. 异常与恢复测试

### MT-10：关闭全部 Fomo 标签页

步骤：

1. 在已连接状态关闭所有 Fomo 标签页。
2. 等待至少 30 秒。
3. 打开 Side Panel。

预期：显示离线状态；历史、标签和设置仍可访问。

### MT-11：重新打开 Fomo

步骤：

1. 从 MT-10 的离线状态重新打开并登录 Fomo。
2. 等待 socket 建立。
3. 打开 Side Panel。

预期：恢复连接；重连回放不会产生重复历史。

### MT-12：退出登录

步骤：

1. 保持 Fomo 页面打开并退出登录。
2. 不刷新页面，观察 Side Panel 状态。
3. 然后刷新 Fomo 页面，再观察状态。

当前预期：

- 未刷新时可能显示“重连中”。
- 刷新后应显示“需要登录”。

请重点记录 Network 面板中是否存在可靠的 Fomo `401` 或 `403`，以及它发生在 socket 关闭之前还是之后。这是后续区分登出和瞬时断线的关键证据。

### MT-13：浏览器重启与本地持久化

步骤：

1. 记录一条历史消息、一个标签和一项设置。
2. 完全退出 Chrome。
3. 重新打开 Chrome 和扩展。

预期：

- 历史消息仍存在。
- 标签、静音、置顶和设置仍存在。
- 连接状态重新计算，不使用上次会话的陈旧在线状态。

### MT-14：扩展更新/重新加载

步骤：

1. 在 `chrome://extensions` 点击扩展刷新按钮。
2. 刷新测试页面。

预期：历史和设置保留；交易页面不存在 Toast 容器；不出现重复监听。

## 8. 7 日指标接口证据采集

这一步只采集和脱敏，不直接启用生产适配器。

1. 在已登录的 Fomo 页面打开 DevTools → **Network**。
2. 勾选 **Preserve log**。
3. 搜索 `leaderboard`，寻找类似请求：

   ```text
   GET https://prod-api.fomo.family/v2/users/{traderId}/leaderboard
   ```

4. 只保存 Response 的结构和指标字段。
5. 删除或替换以下敏感数据：

   - 用户 ID、handle、昵称。
   - 钱包地址和交易地址。
   - 头像 URL。
   - Cookie、Authorization、Request Headers。
   - 与指标验证无关的持仓和交易明细。

6. 需要确认：

   - 响应是否明确标识 `7d` 时间窗口。
   - `pnl` 是美元绝对值还是百分比。
   - `winRate` 是 `62.5` 还是 `0.625` 形式。
   - 缺失数据是 `null`、缺字段还是 `0`。

不要发送完整 HAR 文件，除非已确认其中不包含 Cookie、token 和钱包隐私。推荐只复制脱敏后的 Response JSON。

## 9. Solana / Monad network ID 证据采集

如果遇到 Solana 或 Monad 活动，请记录脱敏后的最小字段：

```json
{
  "type": "swap_buy",
  "networkId": 0,
  "ticker": "EXAMPLE",
  "tokenAddress": "REDACTED_OR_TEST_ADDRESS",
  "createdAt": "2026-08-20T00:00:00.000Z"
}
```

关键是保留真实 `networkId` 和链类型对应关系。不要提交用户 ID、钱包地址、金额或完整原始帧。

## 10. 买入声音提示

自动化测试已覆盖消息协议、Offscreen Document 单飞创建/复用/错误隔离、播放重启以及 live/recovery 资格判定。Playwright 无法可靠观测扬声器的实际声音输出，因此真实播放保留为 Chrome 手工验收：

1. 在设置中打开“买入声音提示”，然后关闭 Side Panel。
2. 保持已登录的 Fomo 标签页打开，等待一条新的实时买入。
3. 确认每条首次出现的实时买入都播放一次短促双音；快速连续买入应从头重播，不排队。
4. 确认卖出、提现、转账和观点事件不播放。
5. 重连或重启扩展，确认恢复的历史买入不播放。
6. 关闭“买入声音提示”，确认下一条实时买入立即静音。
7. 将某个 trader 设为 mute，并切换 feed 筛选条件；确认新的实时买入仍按全局开关播放。

音频来源：`public/audio/buy-alert.wav` 由仓库内 `scripts/generate-buy-alert.mjs` 确定性生成，是 180ms、16kHz、单声道 PCM 双音，不使用第三方素材或网络请求。

## 11. 问题记录模板

每个问题单独记录：

```text
编号：BUG-001
标题：
Chrome 版本：
macOS / Windows 版本：
插件提交：7b90595 或实际 git rev-parse --short HEAD 输出
测试页面 URL / 平台：
Fomo 登录状态：
Fomo 标签页状态：打开 / 关闭 / 刚刷新

复现步骤：
1.
2.
3.

预期结果：
实际结果：
出现频率：必现 / 偶现 / 仅一次
是否影响继续测试：是 / 否

Console 错误：
Network 状态码：
截图或录屏：
敏感字段已脱敏：是 / 否
```

严重程度建议：

- `Blocker`：无法安装、无法打开 Side Panel、主链路完全收不到消息。
- `Critical`：数据错误、重复或丢失严重、安全/隐私问题、影响交易页面。
- `Major`：核心功能不可用，但仍可继续测试其他功能。
- `Minor`：样式、文案、偶发体验问题。

## 12. 测试结束后的交付内容

测试完成后，请提供：

1. MT-01 至 MT-14 的结果。
2. 所有 BUG 记录及截图。
3. 脱敏后的 7 日指标响应结构（如果取得）。
4. Solana / Monad 的真实 network ID 对应证据（如果遇到）。
5. 是否允许进入统一修复阶段。

收到测试结果后，将按以下顺序集中处理：

1. 安全、隐私和数据正确性。
2. 实时消息主链路。
3. 登录、断线和恢复状态。
4. Side Panel 和设置问题。
5. 测试 warning 与工程清理。
6. 全量单元/集成、E2E、生产构建和真实 Chrome 回归。

## 13. 恢复计划证据文档（Task 1）

恢复计划（`docs/superpowers/plans/2026-08-21-feed-recovery-translation-i18n.md`）
Task 1 产出了以下证据文档与合成脱敏夹具。当前环境无法抓取真实已登录 Fomo
流量，因此全部内容为**合成重建**：字段名、嵌套和类型按 `src/fomo/raw-schema.ts`
等实现还原，但所有标识、地址、金额、时间戳、URL 和观点文本均为合成或截断
占位值。网络 ID 全部标记为 `provisional-unverified`，未经真实捕获验证前
**不得**启用生产适配器：

| 文件 | 内容 |
| --- | --- |
| `docs/evidence/fomo-activity-contract.md` | 实时 `trading_activity` payload 结构合同、字段边界与变体索引 |
| `docs/evidence/fomo-history-contract.md` | 历史 REST 端点合同（`GET /v2/activities/me`、cursor/limit、401/403/429 语义） |
| `docs/evidence/fomo-network-catalog.md` | 六链 networkId 目录（BSC / Solana / Robinhood / Base / Ethereum / X Layer + unknown，全部 provisional） |
| `docs/evidence/fomo-metrics-contract.md` | 7 日 PnL、7 日胜率、followers 的 JSON 路径 |
| `tests/fixtures/fomo-activity-variants.ts` | 合成脱敏实时 payload 变体（满足编译期容器） |
| `tests/fixtures/fomo-history-page.redacted.json` | 合成脱敏历史页响应（`responseObject.activities`） |
| `tests/fixtures/fomo-metrics-7d.redacted.json` | 合成脱敏指标响应（`timeframes["7d"]` + followers） |

四份证据文档均包含占位 SHA-256（`sha256-redacted-outside-git`），原始未脱敏
捕获保存在 git 之外，不得提交。手工测试时若观察到真实网络请求，请按本文档
第 8、9 节的流程脱敏采集，并回填证据文档后再推进恢复计划后续任务。
# Fomo 代币导航（2026-08-31）

- 在已有 Fomo 页面时，分别点击 Solana、BSC、Robinhood 事件的代币名称/符号，确认复用并激活该标签页，路径分别为 `/tokens/solana/{CA}`、`/tokens/bnb/{CA}`、`/tokens/robinhood/{CA}`。
- 关闭所有 Fomo 标签页后点击受支持代币名称/符号，确认只创建一个新的活动标签页。
- Base、Ethereum、X Layer、unknown 事件的代币名称/符号应为普通文本，不可点击，等待真实 authenticated token route 证据；不要用 SPA 任意路径的 HTTP 200 作为证据。
- 点击卡片空白、金额、链徽标和翻译内容，不应发生导航；点击用户名仍打开 Fomo profile；点击 CA 仍只复制地址。
- 模拟标签页在查询后被关闭，确认扩展回退为新建一个活动标签页；最终浏览器 API 失败时 UI 不应抛错或泄露地址到诊断。

可复现 release gate（预期均以退出码 0 完成；以下仅为运行说明，不记录历史运行结果）：

```bash
corepack pnpm exec tsc --noEmit
corepack pnpm vitest run
corepack pnpm playwright test
corepack pnpm build
corepack pnpm package:local
```

# 混合终端 UI 回归

- 在 280 px、320 px 和 400 px 宽度检查：页面不得出现横向滚动。
- 对相同 6 条普通交易数据，改版后完整可见卡片数不得少于改版前基线。
- 分别检查买入、卖出、观点、转入、转出边框；文字标签必须始终存在。
- 检查 BSC、Solana、Base、Robinhood、Ethereum、X Layer 在信息流与筛选器中的 SVG 图标。
- 检查深色与浅色主题，以及系统“减少动态效果”开启后的交互反馈。
- 打开筛选、设置、支持，再按 Escape 或切换工具按钮；界面不得重叠或横向裁切。
- 刷新已有数据时旧卡片保持可见；失败时显示紧凑重试提示。

# 交易员内联备注回归

- 未备注的交易员名称后应常驻显示“＋备注”，且时间仍位于同一行。
- 点击“＋备注”输入文字并按 Enter，所有属于同一交易员的可见卡片应立即显示相同备注。
- 点击已有备注应进入原位编辑；按 Escape 恢复旧值，失去焦点保存有效值，输入纯空格会清除备注。
- 输入超过 40 个字符时应显示错误且不写入；修正后仍可继续保存。
- 点击用户名应打开对应 Fomo 用户主页；点击备注或在输入框操作不得触发主页跳转。
- 在 280 px、320 px 和 400 px 宽度检查长用户名、长备注与时间：备注应截断并通过悬停显示完整内容，卡片不得新增一行或增加高度。
- 刷新 Side Panel 后备注仍然存在，并可通过信息流搜索框命中。

# 金额与市值显示设置回归

- 打开设置中的“金额显示”，确认买入金额、卖出金额和市值是三个独立分组。
- 分别调整三组字号、主题色、预设色和自定义颜色；只有对应字段应变化，其他两组保持不变。
- 分别验证小号、标准、大号、超大号预设和 11–18px 滑块；字号变化不得使交易摘要换行或增加卡片高度。
- 验证单组恢复默认和全部恢复默认；关闭并重新打开 Side Panel 后设置仍应保留。
- 在浅色、深色主题分别选择接近背景的颜色，应显示可读性提醒，但不得擅自覆盖用户选择。
- 在 280px 宽度下使用 18px 和长金额夹具，金额、市值、代币及链仍须位于同一交易摘要行，且无横向滚动。
