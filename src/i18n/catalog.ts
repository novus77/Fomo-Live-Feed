/**
 * Typed i18n catalog (plan Task 6, spec section 10).
 *
 * The extension UI supports exactly two locales (English and Simplified
 * Chinese). `EN_MESSAGES` is the canonical key source; `ZH_MESSAGES` is typed
 * as `Record<MessageKey, string>` so TypeScript enforces identical keys at
 * compile time. Dynamic values are only ever passed through `translate` as
 * plain-text interpolation arguments - never as message keys or markup.
 *
 * This module is intentionally dependency-free (no React, no browser APIs at
 * module scope) so the worker, the overlay, and the side panel can all import
 * it.
 */

export type UiLocale = 'en' | 'zh-CN';

/** Opinion-translation target; independent of the UI locale (spec 9.2). */
export type TranslationTarget = 'auto' | 'zh' | 'en';

/**
 * Canonical English catalog. Keys mirror the visible surface of the side
 * panel, popup, settings, diagnostics, toasts, CA copy, refresh states, and
 * the opinion-translation UI. Placeholder tokens are `{name}` and must exist
 * with the same name in both locales for a given key.
 */
export const EN_MESSAGES = {
  // Header / app chrome
  'header.title': 'Fomo Live Feed',
  'header.settings': 'Settings',
  'header.refresh': 'Refresh',
  'header.refreshing': 'Refreshing…',
  'header.refreshUpdated': 'Updated',
  'header.refreshCurrent': 'Up to date',
  'header.refreshFailed': 'Refresh failed',
  'header.refreshRecoveryUnavailable': 'Recovery unavailable',
  'header.refreshIdle': 'Ready',

  // Connection indicator
  'connection.checking': 'Checking…',
  'connection.connected': 'Connected',
  'connection.reconnecting': 'Reconnecting',
  'connection.offline': 'Offline',
  'connection.loginRequired': 'Login required',

  // Connection banners
  'banner.loginTitle': 'Log in to Fomo',
  'banner.loginBody':
    'Open Fomo and log in to see live trader activity. Your existing Fomo session powers this extension - it never asks for credentials. History already stored here stays available below (read-only).',
  'banner.reconnectingTitle': 'Fomo reconnecting',
  'banner.reconnectingBody':
    'Your authenticated Fomo socket closed and the page is reconnecting. Live activity resumes automatically. History already stored here stays available below (read-only).',
  'banner.refreshTitle': 'Refresh Fomo manually',
  'banner.refreshBody':
    'Refresh the existing Fomo tab once so the live observer can attach. The extension will never reload your tab automatically.',
  'banner.offlineTitle': 'Fomo tab offline',
  'banner.offlineBody':
    'Keep an authenticated Fomo tab open to collect live activity. History already stored here stays available below (read-only).',
  'banner.openFomo': 'Open Fomo',

  // Feed states and controls
  'feed.loading': 'Loading history…',
  'feed.error': 'History could not be loaded right now.',
  'feed.retry': 'Try again',
  'feed.empty':
    'No activity yet - trades from traders you follow will appear here.',
  'feed.loadMore': 'Load more',
  'feed.loadingMore': 'Loading more…',
  'feed.scanExceeded':
    'Your search matches very few rows. Narrow your search (more of the trader name, token symbol, or address) to see earlier matches.',
  'feed.searchPlaceholder': 'Search traders, labels, symbols, addresses',
  'feed.searchAria': 'Search history',
  'feed.filtersAria': 'Event filters',
  'feed.countActive': 'Filters, {count} active',
  'feed.resetFilters': 'Reset filters',
  'feed.allActions': 'All actions',
  'feed.allChains': 'All chains',
  'feed.allTraders': 'All traders',
  'feed.allTokens': 'All tokens',
  'feed.unread': 'Unread',
  'feed.removeFilter': 'Remove {label} filter',
  'feed.pinnedOnly': 'Pinned only',
  'feed.filters': 'Filters',
  'feed.pinned': 'Pinned',
  'feed.reset': 'Reset',
  'feed.toolbarAria': 'Feed filters',
  'feed.activeFilters': 'Active filters',
  'feed.action': 'Action',
  'feed.chain': 'Chain',
  'feed.trader': 'Trader',
  'feed.token': 'Token',
  'feed.chipAction': 'Action: {label}',
  'feed.chipChain': 'Chain: {label}',
  'feed.chipTrader': 'Trader: {label}',
  'feed.chipToken': 'Token: {label}',

  // Trade actions
  'action.buy': 'Buy',
  'action.sell': 'Sell',
  'action.withdraw': 'Withdraw',
  'action.transfer': 'Transfer',
  'action.thesis': 'Thesis',

  // Cards, CA copy, annotations
  'card.copyAddress': 'Copy full address',
  'card.copyAddressText': 'Copy address text',
  'card.addressCopied': 'Copied',
  'card.editLabel': 'Edit label',
  'card.label': 'Label',
  'card.close': 'Close',
  'card.pin': 'Pin trader',
  'card.unpin': 'Unpin trader',
  'card.mute': 'Mute trader',
  'card.unmute': 'Unmute trader',
  'card.traderLabel': 'Trader label',
  'card.colorAria': 'Color {color}',
  'card.labelTooLong': 'Label must be at most {max} characters',
  'card.labelPlaceholder': 'Add label…',
  'card.color': 'Color',
  'card.copyFailed': 'Copy failed',
  'card.saveLabel': 'Save label',
  'card.removeLabel': 'Remove label',
  'card.muteNote':
    'Muting hides future toasts for this trader but keeps their history.',
  'card.caLabel': 'CA: {address}',
  'card.followers': '{count} followers',

  // Settings panel
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.translation': 'Translation',
  'settings.translationTarget': 'Target language',
  'settings.translationTargetAuto': 'Auto',
  'settings.translationTargetZh': '中文',
  'settings.translationTargetEn': 'English',

  // Pipeline diagnostics
  'diagnostics.title': 'Pipeline diagnostics',
  'diagnostics.observer': 'Observer',
  'diagnostics.observerReady': 'Observer ready',
  'diagnostics.observerNotReady': 'Observer not ready',
  'diagnostics.never': 'Never',
  'diagnostics.none': 'None',
  'diagnostics.socket': 'Socket',
  'diagnostics.socketObserved': 'Socket observed / {state}',
  'diagnostics.socketNotObserved': 'Socket not observed',
  'diagnostics.open': 'open',
  'diagnostics.closed': 'closed',
  'diagnostics.lastFrame': 'Last frame',
  'diagnostics.lastPersisted': 'Last persisted',
  'diagnostics.newestEvent': 'Newest event',
  'diagnostics.candidate': 'Candidate',
  'diagnostics.accepted': 'Accepted',
  'diagnostics.rejected': 'Rejected',
  'diagnostics.duplicate': 'Duplicate',
  'diagnostics.persisted': 'Persisted',
  'diagnostics.broadcast': 'Broadcast',
  'diagnostics.lastRejection': 'Last rejection',
  'diagnostics.rejectionSchemaInvalid': 'Invalid schema',
  'diagnostics.rejectionDuplicate': 'Duplicate',
  'diagnostics.rejectionStorageFailed': 'Storage failed',
  'diagnostics.rejectionBroadcastFailed': 'Broadcast failed',
  'diagnostics.stageObserverTopic': 'Observer topic rejection',
  'diagnostics.stageBridgeEnvelope': 'Bridge envelope rejection',
  'diagnostics.stageRawSchema': 'Raw schema rejection',
  'diagnostics.stageNormalization': 'Normalization rejection',
  'diagnostics.stageDeduplication': 'Deduplication',
  'diagnostics.stageStorage': 'Storage rejection',
  'diagnostics.stageBroadcast': 'Broadcast rejection',
  'diagnostics.secondsAgo': '{seconds}s ago',
  'diagnostics.minutesAgo': '{minutes}m ago',
  'diagnostics.hoursAgo': '{hours}h ago',
  'diagnostics.unknownNetwork': 'Unknown network {networkId}',
  'diagnostics.unknownNetworkDetail': '{count} events · last seen {time}',
  'diagnostics.warningWaitingPersist':
    'Accepted activity is waiting for persistence.',
  'diagnostics.warningWaitingBroadcast':
    'Persisted activity is waiting for broadcast.',

  // Opinion translation (plan Task 7 UI; catalog keys land here first)
  'translation.translating': 'Translating…',
  'translation.viewOriginal': 'View original',
  'translation.viewTranslation': 'View translation',
  'translation.unavailable': 'Translation unavailable',
  'translation.enable': 'Enable local translation',

  // Toasts
  'toast.dismiss': 'Dismiss toast',

  // Unsupported fallback page
  'unsupported.title': 'Side Panel unavailable',
  'unsupported.body':
    'Fomo Live Feed requires Chrome 138 or newer with the Side Panel API enabled.',
  'unsupported.hint': 'Update Chrome, then click the extension action again.',

  // Language switcher
  'language.switch': 'Switch UI language',
} as const;

export type MessageKey = keyof typeof EN_MESSAGES;

/**
 * Simplified Chinese catalog. Typed as `Record<MessageKey, string>` so a
 * missing, extra, or renamed key is a compile-time error, not a runtime
 * fallback gap.
 */
export const ZH_MESSAGES: Record<MessageKey, string> = {
  // Header / app chrome
  'header.title': 'Fomo 实时动态',
  'header.settings': '设置',
  'header.refresh': '刷新',
  'header.refreshing': '正在刷新…',
  'header.refreshUpdated': '已更新',
  'header.refreshCurrent': '已是最新',
  'header.refreshFailed': '刷新失败',
  'header.refreshRecoveryUnavailable': '恢复不可用',
  'header.refreshIdle': '就绪',

  // Connection indicator
  'connection.checking': '正在检查…',
  'connection.connected': '已连接',
  'connection.reconnecting': '重新连接中',
  'connection.offline': '已离线',
  'connection.loginRequired': '需要登录',

  // Connection banners
  'banner.loginTitle': '登录 Fomo',
  'banner.loginBody':
    '打开 Fomo 并登录以查看实时交易动态。您的现有 Fomo 会话为本扩展提供支持——它绝不会索要凭据。已存储的历史记录仍可在下方查看（只读）。',
  'banner.reconnectingTitle': 'Fomo 正在重新连接',
  'banner.reconnectingBody':
    '您的已认证 Fomo 连接已关闭，页面正在重新连接。实时动态会自动恢复。已存储的历史记录仍可在下方查看（只读）。',
  'banner.refreshTitle': '请手动刷新 Fomo',
  'banner.refreshBody':
    '请刷新一次现有的 Fomo 标签页，以便实时观察器完成挂载。本扩展绝不会自动刷新您的标签页。',
  'banner.offlineTitle': 'Fomo 标签页已离线',
  'banner.offlineBody':
    '请保持一个已登录的 Fomo 标签页开启，以收集实时动态。已存储的历史记录仍可在下方查看（只读）。',
  'banner.openFomo': '打开 Fomo',

  // Feed states and controls
  'feed.loading': '正在加载历史记录…',
  'feed.error': '暂时无法加载历史记录。',
  'feed.retry': '重试',
  'feed.empty': '暂无动态——您关注的交易者产生的交易将显示在这里。',
  'feed.loadMore': '加载更多',
  'feed.loadingMore': '正在加载更多…',
  'feed.scanExceeded':
    '您的搜索匹配到的记录很少。请缩小搜索范围（输入更多交易者名称、代币符号或地址）以查看更早的匹配。',
  'feed.searchPlaceholder': '搜索交易者、标签、代币或地址',
  'feed.searchAria': '搜索历史记录',
  'feed.filtersAria': '事件筛选',
  'feed.countActive': '筛选（{count} 项生效）',
  'feed.resetFilters': '重置筛选',
  'feed.allActions': '全部操作',
  'feed.allChains': '全部链',
  'feed.allTraders': '全部交易者',
  'feed.allTokens': '全部代币',
  'feed.unread': '未读',
  'feed.removeFilter': '移除 {label} 筛选',
  'feed.pinnedOnly': '仅显示置顶',
  'feed.filters': '筛选',
  'feed.pinned': '置顶',
  'feed.reset': '重置',
  'feed.toolbarAria': '动态筛选',
  'feed.activeFilters': '生效中的筛选',
  'feed.action': '操作',
  'feed.chain': '链',
  'feed.trader': '交易者',
  'feed.token': '代币',
  'feed.chipAction': '操作：{label}',
  'feed.chipChain': '链：{label}',
  'feed.chipTrader': '交易者：{label}',
  'feed.chipToken': '代币：{label}',

  // Trade actions
  'action.buy': '买入',
  'action.sell': '卖出',
  'action.withdraw': '提取',
  'action.transfer': '转账',
  'action.thesis': '观点',

  // Cards, CA copy, annotations
  'card.copyAddress': '复制完整地址',
  'card.copyAddressText': '复制地址文本',
  'card.addressCopied': '已复制',
  'card.editLabel': '编辑标签',
  'card.label': '标签',
  'card.close': '关闭',
  'card.pin': '置顶交易者',
  'card.unpin': '取消置顶交易者',
  'card.mute': '静音交易者',
  'card.unmute': '取消静音交易者',
  'card.traderLabel': '交易者标签',
  'card.colorAria': '颜色 {color}',
  'card.labelTooLong': '标签最多 {max} 个字符',
  'card.labelPlaceholder': '添加标签…',
  'card.color': '颜色',
  'card.copyFailed': '复制失败',
  'card.saveLabel': '保存标签',
  'card.removeLabel': '移除标签',
  'card.muteNote': '静音会隐藏该交易者未来的通知，但保留其历史记录。',
  'card.caLabel': 'CA：{address}',
  'card.followers': '{count} 关注者',

  // Settings panel
  'settings.title': '设置',
  'settings.language': '语言',
  'settings.translation': '翻译',
  'settings.translationTarget': '目标语言',
  'settings.translationTargetAuto': '自动',
  'settings.translationTargetZh': '中文',
  'settings.translationTargetEn': '英语',

  // Pipeline diagnostics
  'diagnostics.title': '管道诊断',
  'diagnostics.observer': '观察器',
  'diagnostics.observerReady': '观察器就绪',
  'diagnostics.observerNotReady': '观察器未就绪',
  'diagnostics.never': '从未',
  'diagnostics.none': '无',
  'diagnostics.socket': '套接字',
  'diagnostics.socketObserved': '已观察套接字 / {state}',
  'diagnostics.socketNotObserved': '未观察套接字',
  'diagnostics.open': '打开',
  'diagnostics.closed': '关闭',
  'diagnostics.lastFrame': '最近帧',
  'diagnostics.lastPersisted': '最近持久化',
  'diagnostics.newestEvent': '最新事件',
  'diagnostics.candidate': '候选',
  'diagnostics.accepted': '已接受',
  'diagnostics.rejected': '已拒绝',
  'diagnostics.duplicate': '重复',
  'diagnostics.persisted': '已持久化',
  'diagnostics.broadcast': '已广播',
  'diagnostics.lastRejection': '最近拒绝',
  'diagnostics.rejectionSchemaInvalid': '模式无效',
  'diagnostics.rejectionDuplicate': '重复',
  'diagnostics.rejectionStorageFailed': '存储失败',
  'diagnostics.rejectionBroadcastFailed': '广播失败',
  'diagnostics.stageObserverTopic': '观察器主题拒绝',
  'diagnostics.stageBridgeEnvelope': '桥接信封拒绝',
  'diagnostics.stageRawSchema': '原始模式拒绝',
  'diagnostics.stageNormalization': '归一化拒绝',
  'diagnostics.stageDeduplication': '去重',
  'diagnostics.stageStorage': '存储拒绝',
  'diagnostics.stageBroadcast': '广播拒绝',
  'diagnostics.secondsAgo': '{seconds} 秒前',
  'diagnostics.minutesAgo': '{minutes} 分钟前',
  'diagnostics.hoursAgo': '{hours} 小时前',
  'diagnostics.unknownNetwork': '未知网络 {networkId}',
  'diagnostics.unknownNetworkDetail': '{count} 个事件 · 最近 {time}',
  'diagnostics.warningWaitingPersist': '已接受的活动正在等待持久化。',
  'diagnostics.warningWaitingBroadcast': '已持久化的活动正在等待广播。',

  // Opinion translation (plan Task 7 UI; catalog keys land here first)
  'translation.translating': '正在翻译…',
  'translation.viewOriginal': '查看原文',
  'translation.viewTranslation': '查看译文',
  'translation.unavailable': '翻译不可用',
  'translation.enable': '启用本地翻译',

  // Toasts
  'toast.dismiss': '关闭通知',

  // Unsupported fallback page
  'unsupported.title': '侧边栏不可用',
  'unsupported.body':
    'Fomo Live Feed 需要 Chrome 138 或更高版本，并启用侧边栏 API。',
  'unsupported.hint': '请更新 Chrome，然后再次点击扩展图标。',

  // Language switcher
  'language.switch': '切换界面语言',
};

const PLACEHOLDER_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * Returns the message for `key` in `locale`, substituting `{name}` tokens
 * with the supplied plain-text values. Values are coerced with `String` and
 * never interpreted as markup or message keys; a missing value leaves the
 * token visible so an interpolation bug is obvious instead of silent.
 */
export function translate(
  locale: UiLocale,
  key: MessageKey,
  values?: Readonly<Record<string, string | number>>,
): string {
  const template = locale === 'zh-CN' ? ZH_MESSAGES[key] : EN_MESSAGES[key];

  if (values === undefined) {
    return template;
  }

  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
    const value = values[name];

    return value === undefined ? match : String(value);
  });
}

/**
 * Resolves a raw browser/OS language tag to a supported UI locale: any
 * Chinese tag (`zh`, `zh-CN`, `zh-TW`, …) maps to `zh-CN`; everything else
 * falls back to `en`. Safe to call without a browser environment (workers,
 * tests) - `navigator` access is guarded.
 */
export function resolveBrowserLocale(language?: string): UiLocale {
  const raw =
    language ??
    (typeof navigator !== 'undefined' ? navigator.language : undefined) ??
    'en';

  return raw.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
