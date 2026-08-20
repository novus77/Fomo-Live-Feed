# Fomo Live Feed 手工测试指南

本文用于在真实 Chrome、真实 Fomo 登录态和真实交易页面中验证 MVP。测试期间只记录问题，不直接修改代码；测试结束后统一进入修复和回归阶段。

## 1. 当前测试目标

本轮重点确认：

- Fomo 已关注交易员的实时活动能否进入插件。
- DexScreener 和 GMGN 页面能否正确弹出最多三张消息卡片。
- 插件 Popup 能否保存、搜索和筛选历史消息。
- 标签、静音、置顶和指标显示设置能否本地保存。
- 断线、关闭 Fomo 标签页、退出登录和浏览器重启后的状态是否合理。
- 插件是否始终保持只读，不影响交易页面和钱包操作。

## 2. 测试前已知限制

以下现象已登记，不需要重复报告，除非实际表现与描述不同：

1. **近 7 日盈亏和胜率暂时显示不可用。** 生产环境仍使用 `unavailableMetricSource`，需要真实、脱敏的 Fomo 接口响应验证后才能启用。
2. **Solana 和 Monad network ID 尚待真实消息确认。** 相关消息可能暂时显示为未知链；请保留脱敏后的原始字段证据。
3. **退出登录可能显示“重连中”。** 如果 Fomo 页面仍然打开，只关闭了 WebSocket，插件目前不能立即区分“已退出登录”和“暂时断线”；刷新 Fomo 页面后才可能显示“需要登录”。
4. 测试套件存在少量 React `act(...)` 警告，但当前 752 项单元/集成测试通过。这属于测试代码清理项，不影响手工使用。

## 3. 测试环境

### 3.1 必要条件

- macOS 或 Windows。
- Chrome Stable，建议记录完整版本号。
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

```bash
cd "/Users/a77/Documents/ChatGPT/fomo 信息插件/.worktrees/codex-fomo-live-feed"
```

确认当前分支与状态：

```bash
git branch --show-current
git status --short
```

预期：

```text
codex/fomo-live-feed
```

`git status --short` 不应输出任何内容。

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
   /Users/a77/Documents/ChatGPT/fomo 信息插件/.worktrees/codex-fomo-live-feed/.output/chrome-mv3
   ```

5. 确认扩展列表出现 **Fomo Live Feed**，且没有红色错误。
6. 点击浏览器工具栏的扩展菜单，将 Fomo Live Feed 固定到工具栏。

每次重新执行 `corepack pnpm build` 后：

1. 回到 `chrome://extensions`。
2. 点击 Fomo Live Feed 卡片上的刷新按钮。
3. 刷新所有 Fomo、DexScreener 和 GMGN 测试标签页。

### 4.5 `corepack enable` 权限错误

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

点击扩展图标，先记录 Popup 初始状态：

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

- Popup 不显示“请先登录 Fomo”。
- 当 Fomo 实时 socket 已建立时显示已连接状态。
- 插件页面无崩溃或持续刷新的现象。

记录：

```text
结果：
Popup 状态：
等待时间：
备注：
```

### MT-02：实时买入/卖出消息

前提：已关注交易员产生真实活动。

步骤：

1. 保持 Fomo 标签页打开。
2. 将 DexScreener 或 GMGN 切到前台。
3. 等待已关注交易员产生买入、卖出或 thesis 活动。
4. 记录 Fomo 页面出现活动和插件 Toast 出现的时间。

预期：

- 交易页面右下角出现 Toast。
- 卡片包含交易员、动作、代币、链、金额或时间等可用字段。
- Toast 内容与 Fomo 原始活动一致。
- 同一事件不会重复弹出。
- 指标未启用时明确显示不可用，不显示伪造的 0 或错误百分比。

记录：

```text
结果：
活动类型：buy / sell / thesis / other
Fomo 出现时间：
Toast 出现时间：
估算延迟：
链：
代币：
交易员：
```

### MT-03：最多三张 Toast

步骤：

1. 在短时间内观察四条以上活动。
2. 统计页面同时可见的 Toast 数量。

预期：

- 同时最多显示三张。
- 新消息从底部进入，旧消息上移。
- 超出的消息不再占据页面，但仍进入历史记录。

如果真实环境暂时无法触发四条消息，将本项记录为“未触发”，不要人为下单制造测试数据。

### MT-04：Toast 交互

分别验证：

- 鼠标悬停时倒计时暂停。
- 点击关闭只关闭当前 Toast，不删除历史。
- 点击卡片打开正确的 Fomo 代币页面。
- 点击交易员打开正确的 Fomo 主页。
- 点击合约复制完整地址，且复制内容与链上地址一致。
- 头像或代币图片失败时出现安全的占位内容。

预期：不触发交易、不连接钱包、不修改原交易页面表单。

### MT-05：Popup 历史消息

步骤：

1. 收到至少一条实时消息。
2. 等待 Toast 消失或手动关闭。
3. 点击扩展图标。

预期：

- 消息仍在历史记录中。
- 最新消息排在前面。
- 打开并阅读消息后，未读角标正确减少。
- 关闭并重新打开 Popup 后，历史仍存在。

### MT-06：搜索与筛选

在 Popup 中依次测试：

- 搜索交易员名称或 handle。
- 搜索自定义标签。
- 搜索代币 Symbol。
- 搜索完整合约地址。
- 过滤 buy / sell / thesis。
- 按链过滤。
- 只看未读。

预期：结果准确，清除条件后恢复完整列表；无结果时显示明确空状态。

### MT-07：交易员标签、置顶和静音

步骤：

1. 给某位交易员添加标签和颜色。
2. 将交易员置顶。
3. 关闭并重新打开 Popup。
4. 静音该交易员，并等待该交易员后续活动。

预期：

- 标签、颜色和置顶状态保留。
- 静音后不再弹 Toast，但活动仍可进入历史。
- 删除标签后不会在刷新或重启后恢复旧标签。

### MT-08：指标显示设置

步骤：

1. 打开设置。
2. 分别关闭 primary 和 secondary 指标。
3. 尝试选择相同指标作为两个槽位。
4. 替换为 follower、trade count 或 average hold time。

预期：

- 两个指标可以分别关闭或替换。
- 不允许两个槽位选择同一指标。
- 设置在重新打开 Popup 后保留。
- 当前真实指标适配器未启用时，缺失值显示不可用。

### MT-09：DexScreener 与 GMGN 隔离性

分别在两个网站验证：

- Toast 样式不受原页面 CSS 影响。
- Toast 不遮挡主要交易按钮；如遮挡，记录窗口尺寸和截图。
- 插件不会读取、清空或修改页面输入框。
- 页面路由跳转后插件不会重复挂载多个 Toast 容器。
- 其他未授权网站不会出现插件 Toast。

## 7. 异常与恢复测试

### MT-10：关闭全部 Fomo 标签页

步骤：

1. 在已连接状态关闭所有 Fomo 标签页。
2. 等待至少 30 秒。
3. 打开 Popup。

预期：显示离线状态；历史、标签和设置仍可访问。

### MT-11：重新打开 Fomo

步骤：

1. 从 MT-10 的离线状态重新打开并登录 Fomo。
2. 等待 socket 建立。
3. 打开 Popup。

预期：恢复连接；重连回放不会产生重复历史或重复 Toast。

### MT-12：退出登录

步骤：

1. 保持 Fomo 页面打开并退出登录。
2. 不刷新页面，观察 Popup 状态。
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

预期：历史和设置保留；页面只存在一个 Toast 容器；不出现重复监听。

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

## 10. 问题记录模板

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

- `Blocker`：无法安装、无法打开 Popup、主链路完全收不到消息。
- `Critical`：数据错误、重复或丢失严重、安全/隐私问题、影响交易页面。
- `Major`：核心功能不可用，但仍可继续测试其他功能。
- `Minor`：样式、文案、偶发体验问题。

## 11. 测试结束后的交付内容

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
4. Popup、Toast 和设置问题。
5. 测试 warning 与工程清理。
6. 全量单元/集成、E2E、生产构建和真实 Chrome 回归。
