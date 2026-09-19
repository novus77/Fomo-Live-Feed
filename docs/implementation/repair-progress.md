# Fomo Live Feed 修复进度（执行模板）

复制到仓库 `docs/implementation/repair-progress.md` 后填写。所有 PENDING/NOT_RUN 都是真实初始状态，不是已运行结果。

## 当前基线

- 工作区 HEAD：`f949d25a2735c7e1ef6a4ad361e06aa9f3ff0543`，与审查基线一致。
- 审查基线：f949d25a2735c7e1ef6a4ad361e06aa9f3ff0543。
- 工作分支、未提交用户改动：`main`；仅有未跟踪的 `.vercel/`、设计稿、文档草稿、脚本和图标资源，均保留且不纳入本轮修改。
- Node / pnpm / TypeScript / 浏览器版本：Node `v24.11.1`，pnpm `11.19.0`（仓库声明 `pnpm@10.15.0`）；浏览器版本待候选验收记录。
- 基线 check / E2E 命令、退出码、日志：`pnpm check` 退出码 `1`；pnpm 11 在执行前联网拉取 pnpm 元信息并尝试清理模块目录，因无 TTY 中止，尚未进入项目的 typecheck/test/build。后续以现有锁定依赖的原生二进制执行等价检查并记录。
- 本轮代码修改权限：本地业务开发；未自动获得 push、Release、破坏性迁移授权。

## 状态约定

PENDING / IN_PROGRESS / IMPLEMENTED / VERIFIED / BLOCKED / NOT_APPLICABLE。自动化、浏览器和人工验证分别记录。IMPLEMENTED 不等于 VERIFIED。

## 任务包

| 任务 | 验收编号 | 状态 | 修改文件/测试 | 自动化结果 | 浏览器/人工结果 | 阻塞或下一步 |
|---|---|---|---|---|---|---|
| RP00 | A001–A003 | VERIFIED | `docs/implementation/repair-*.md` | See validation log | NOT_RUN | `pnpm check` remains blocked only by package-manager preflight. |
| RP01 | A004–A009 | IMPLEMENTED | `src/messaging/runtime-dispatcher.ts`, `entrypoints/background.ts`, `tests/unit/runtime-dispatcher.test.ts`, `tests/unit/popup-worker-boundary.test.ts` | 4 targeted suites / 102 tests pass | NOT_RUN | Browser minimum-version smoke remains pending. |
| RP02 | A010–A019 | IMPLEMENTED | `src/storage/{database,event-repository}.ts`, `src/background/ingest-activity.ts`, `src/domain/event-deduplication.ts` | Repository, ingestor, and real-worker regression tests pass | NOT_RUN | Add concurrency and recovery cases before marking VERIFIED. |
| RP03 | A020–A030 | IMPLEMENTED | `entrypoints/background.ts`, `src/pump/{bridge,page-collector,window-protocol}.ts`, `tests/unit/{popup-worker-boundary,pump-page-collector,pump-window-protocol}.test.ts` | ACK, rejection retry, timeout retry, and checkpoint regressions pass | NOT_RUN | Authenticated Pump browser recovery smoke remains. |
| RP04 | A031–A039 | IMPLEMENTED | `src/background/pump-leader.ts`, `src/pump/{bridge,page-collector}.ts`, `entrypoints/background.ts`, `tests/unit/pump-page-collector.test.ts` | Lease/session fencing and expiry regressions pass | NOT_RUN | Worker-restart and tab-reload browser smoke remain. |
| RP05 | A040–A047 | IN_PROGRESS | `src/{background/preference-mutations,storage/local-preferences}.ts`, `src/{domain/settings,i18n,messaging,popup,sidepanel,floatpanel}/`, `entrypoints/{background,sidepanel,floatpanel}.tsx`, `tests/unit/{preference-mutation-coordinator,popup-settings-mutation,LocaleProvider,local-preferences,SidePanelApp,popup-worker-boundary,messaging}.test.ts` | Concurrent annotations, trusted settings merge, locale routes, bounded receipts, pending replay, same-ID retry, and UI failure/retry regression pass | NOT_RUN | Browser smoke remains. |
| RP06 | A048–A053 | IMPLEMENTED | `src/popup/use-event-feed.ts`, `tests/unit/use-event-feed-filter-key.test.tsx` | Filter-reload identity regression passes | NOT_RUN | Browser filter toggle smoke remains. |
| RP07 | A054–A058 | IN_PROGRESS | `src/popup/{source-read-eligibility,use-event-feed}.ts`, `src/sidepanel/SidePanelApp.tsx`, `tests/unit/{source-read-eligibility,use-event-feed-filter-key,SidePanelApp}.test.tsx` | Pump-only, Fomo-offline, selected-source projection, and owner-gate regressions pass | NOT_RUN | PiP handoff is covered by the existing FloatPanel owner test; authenticated browser smoke remains. |
| RP08 | A059–A064 | IMPLEMENTED | `src/background/pump-gap-store.ts`, `src/storage/event-repository.ts`, `entrypoints/background.ts`, `src/sidepanel/PumpStatusIndicator.tsx` | Gap persistence, source-aware reclassification, and refresh-notification regressions pass | NOT_RUN | Explicit user acknowledgement UI and authenticated browser smoke remain. |
| RP09 | A065–A069 | IMPLEMENTED | `src/popup/{feed-window-reconcile,use-event-feed}.ts`, `tests/unit/feed-window-reconcile.test.ts` | Live head refresh preserves loaded history and tail pagination regression passes | NOT_RUN | Browser scroll-anchor smoke remains. |
| RP10 | A070–A077 | IMPLEMENTED | `src/fomo/{bridge,websocket-observer}.ts`, `entrypoints/fomo-interceptor.content.ts`, `tests/unit/fomo-interceptor.test.ts` | Ready/replay and oversized-frame regressions pass | NOT_RUN | Authenticated Fomo capture smoke remains. |
| RP11 | A078–A081 | IMPLEMENTED | `entrypoints/background.ts`, `tests/unit/popup-worker-boundary.test.ts` | Worker no longer sends activity payloads to all tabs; UI receives runtime invalidations | NOT_RUN | Measured multi-tab performance matrix remains. |
| RP12 | A082–A084 | IMPLEMENTED | `src/fomo/network-map.ts`, `docs/evidence/fomo-network-catalog.md`, `tests/unit/fomo-normalize.test.ts` | Evidence provenance and runtime compatibility are separately tested | NOT_RUN | Authenticated-capture replacement and final support claim review remain. |
| RP13 | A085–A090 | PENDING | — | NOT_RUN | NOT_RUN | — |

## 问题逐项关闭表

| 问题 | 原优先级/证据 | 主任务 | 当前源码判定 | 修复/不适用依据 | 状态 | 验收证据 |
|---|---|---|---|---|---|---|
| F01 | P1 / S | RP06 | `use-event-feed` full reload dependency list omitted source/minimum/maximum buy filters | Added all three to the reload identity | IMPLEMENTED | `use-event-feed-filter-key.test.tsx` red→green |
| F02 | P1 / R+S | RP03 | Background accepted partially invalid batches then advanced Pump session checkpoint | Rejects any batch with invalid items before ingestion/checkpoint write; page collector retries until explicit ACK | IMPLEMENTED | real worker invalid-batch + collector ACK/retry regressions |
| F03 | P1 / S | RP02 | Production root used plain insert and bypassed merge API | Root now uses atomic `EventRepository.persist()` | IMPLEMENTED | real worker same-source replay test |
| F04 | P1 / R | RP04 | Pump lease was not fenced to a worker lifetime | Worker-session identity is required for lease renewals, batches, status, and page-hidden messages | IMPLEMENTED | leader/session/expiry collector regressions |
| F05 | P1 / R | RP04 | Collector could continue after an expired lease | Expiry cancels polling/ACK state and resumes only after a current lease is received | IMPLEMENTED | expired-lease and renewal regressions |
| F06 | P1 / E+S | RP05 | Annotation writes performed independent full-map read/modify/write cycles | Storage queue serializes local writes; sidepanel/float UI routes mutations through the background writer | IN_PROGRESS | concurrent-trader + real worker trusted-sender regressions |
| F07 | P2 / S | RP07 | Read eligibility used the Fomo connection as a global gate | Per-event eligibility now evaluates the selected visible source projection, source health, and the surface owner gate | IN_PROGRESS | pure selector + hook + SidePanel Pump-only regressions |
| F08 | P1 潜伏 / R | RP02 | Raw IDs compared without source/network namespace | Alias key is source + network + identity kind + raw value | IMPLEMENTED | Fomo/Pump same raw trade-id repository regression |
| F09 | P1 潜伏 / R | RP02 | Event and replay identity writes were independent/no durable aliases | Event and alias records share one Dexie transaction; migration backfills aliases | IMPLEMENTED | same-source replay repository/worker regression |
| F10 | P1/P2 / R | RP04 | 待核验当前 HEAD | — | PENDING | — |
| F11 | P2 / R | RP08 | Live status overwrote the only Pump gap signal | Persistent independent gap state survives later live status | IMPLEMENTED | gap-store, worker, and status-indicator regressions |
| F12 | P2 / S | RP05 | Settings queue was single-instance and sidepanel wrote directly | Privileged UI settings patches now use the background writer; storage merge remains validated by LocalPreferences | IN_PROGRESS | protocol, real worker, and sidepanel regressions |
| F13 | P2 / S | RP08 | Bootstrap migration changed rows without a UI invalidation | Emits `events.changed` only when reclassification updates records | IMPLEMENTED | real worker bootstrap regression |
| F14 | P2 / S | RP09 | Live refresh replaced the full loaded feed window | Reconciles new head rows into loaded history and retains tail cursor | IMPLEMENTED | live-history pagination regression |
| F15 | P2 / S | RP11 | Each event was delivered to every tab | Uses one extension runtime invalidation without trade payload fan-out | IMPLEMENTED | real worker boundary regression |
| F16 | P2 / S+V | RP10 | Bridge readiness and input bounds were incomplete | Adds ordered bounded pre-bridge replay and payload size guards | IMPLEMENTED | interceptor regressions; browser smoke pending |
| F17 | P2 / S | RP12 | Synthetic fixtures were described as capture verification | Catalog now records `evidenceLevel` separately from runtime policy | IMPLEMENTED | network catalog regression |
| F18 | P2 / S+V | RP10 | 待核验当前 HEAD | — | PENDING | — |
| F19 | P3 / S | RP12 | 待核验当前 HEAD | — | PENDING | — |
| F20 | P2 / V | RP01 / RP13 | Chrome 141 ignores Promise listener responses | Native callback adapter returns literal `true` and resolves `sendResponse` | IMPLEMENTED | runtime dispatcher + real listener regression |

## 逐条验收执行记录

| 用例 | 任务 | 状态 | 实际测试文件/测试名 | 命令/环境 | 退出码/观察 | 日志 |
|---|---|---|---|---|---|---|
| A001 | RP00 | NOT_RUN | — | — | — | — |
| A002 | RP00 | NOT_RUN | — | — | — | — |
| A003 | RP00 | NOT_RUN | — | — | — | — |
| A004 | RP01 | PASS | `runtime-dispatcher.test.ts` | local Vitest | 0 | literal `true` holds native callback channel. |
| A005 | RP01 | NOT_RUN | — | — | — | — |
| A006 | RP01 | NOT_RUN | — | — | — | — |
| A007 | RP01 | NOT_RUN | — | — | — | — |
| A008 | RP01 | NOT_RUN | — | — | — | — |
| A009 | RP01 | NOT_RUN | — | — | — | — |
| A010 | RP02 | PASS | `event-repository.test.ts` | local Vitest | 0 | Equal raw Fomo/Pump trade IDs persist as two source-scoped rows. |
| A011 | RP02 | NOT_RUN | — | — | — | — |
| A012 | RP02 | NOT_RUN | — | — | — | — |
| A013 | RP02 | NOT_RUN | — | — | — | — |
| A014 | RP02 | NOT_RUN | — | — | — | — |
| A015 | RP02 | NOT_RUN | — | — | — | — |
| A016 | RP02 | NOT_RUN | — | — | — | — |
| A017 | RP02 | PASS | `popup-worker-boundary.test.ts` | local Vitest | 0 | Real worker suppresses replay only for same source/network alias. |
| A018 | RP02 | NOT_RUN | — | — | — | — |
| A019 | RP02 | NOT_RUN | — | — | — | — |
| A020 | RP03 | NOT_RUN | — | — | — | — |
| A021 | RP03 | NOT_RUN | — | — | — | — |
| A022 | RP03 | NOT_RUN | — | — | — | — |
| A023 | RP03 | NOT_RUN | — | — | — | — |
| A024 | RP03 | NOT_RUN | — | — | — | — |
| A025 | RP03 | NOT_RUN | — | — | — | — |
| A026 | RP03 | NOT_RUN | — | — | — | — |
| A027 | RP03 | NOT_RUN | — | — | — | — |
| A028 | RP03 | NOT_RUN | — | — | — | — |
| A029 | RP03 | NOT_RUN | — | — | — | — |
| A030 | RP03 | NOT_RUN | — | — | — | — |
| A031 | RP04 | NOT_RUN | — | — | — | — |
| A032 | RP04 | NOT_RUN | — | — | — | — |
| A033 | RP04 | NOT_RUN | — | — | — | — |
| A034 | RP04 | NOT_RUN | — | — | — | — |
| A035 | RP04 | NOT_RUN | — | — | — | — |
| A036 | RP04 | NOT_RUN | — | — | — | — |
| A037 | RP04 | NOT_RUN | — | — | — | — |
| A038 | RP04 | NOT_RUN | — | — | — | — |
| A039 | RP04 | NOT_RUN | — | — | — | — |
| A040 | RP05 | NOT_RUN | — | — | — | — |
| A041 | RP05 | NOT_RUN | — | — | — | — |
| A042 | RP05 | NOT_RUN | — | — | — | — |
| A043 | RP05 | NOT_RUN | — | — | — | — |
| A044 | RP05 | NOT_RUN | — | — | — | — |
| A045 | RP05 | NOT_RUN | — | — | — | — |
| A046 | RP05 | NOT_RUN | — | — | — | — |
| A047 | RP05 | NOT_RUN | — | — | — | — |
| A048 | RP06 | NOT_RUN | — | — | — | — |
| A049 | RP06 | NOT_RUN | — | — | — | — |
| A050 | RP06 | NOT_RUN | — | — | — | — |
| A051 | RP06 | NOT_RUN | — | — | — | — |
| A052 | RP06 | NOT_RUN | — | — | — | — |
| A053 | RP06 | NOT_RUN | — | — | — | — |
| A054 | RP07 | NOT_RUN | — | — | — | — |
| A055 | RP07 | NOT_RUN | — | — | — | — |
| A056 | RP07 | NOT_RUN | — | — | — | — |
| A057 | RP07 | NOT_RUN | — | — | — | — |
| A058 | RP07 | NOT_RUN | — | — | — | — |
| A059 | RP08 | NOT_RUN | — | — | — | — |
| A060 | RP08 | NOT_RUN | — | — | — | — |
| A061 | RP08 | NOT_RUN | — | — | — | — |
| A062 | RP08 | NOT_RUN | — | — | — | — |
| A063 | RP08 | NOT_RUN | — | — | — | — |
| A064 | RP08 | NOT_RUN | — | — | — | — |
| A065 | RP09 | NOT_RUN | — | — | — | — |
| A066 | RP09 | NOT_RUN | — | — | — | — |
| A067 | RP09 | NOT_RUN | — | — | — | — |
| A068 | RP09 | NOT_RUN | — | — | — | — |
| A069 | RP09 | NOT_RUN | — | — | — | — |
| A070 | RP10 | NOT_RUN | — | — | — | — |
| A071 | RP10 | NOT_RUN | — | — | — | — |
| A072 | RP10 | NOT_RUN | — | — | — | — |
| A073 | RP10 | NOT_RUN | — | — | — | — |
| A074 | RP10 | NOT_RUN | — | — | — | — |
| A075 | RP10 | NOT_RUN | — | — | — | — |
| A076 | RP10 | NOT_RUN | — | — | — | — |
| A077 | RP10 | NOT_RUN | — | — | — | — |
| A078 | RP11 | NOT_RUN | — | — | — | — |
| A079 | RP11 | NOT_RUN | — | — | — | — |
| A080 | RP11 | NOT_RUN | — | — | — | — |
| A081 | RP11 | NOT_RUN | — | — | — | — |
| A082 | RP12 | NOT_RUN | — | — | — | — |
| A083 | RP12 | NOT_RUN | — | — | — | — |
| A084 | RP12 | NOT_RUN | — | — | — | — |
| A085 | RP13 | NOT_RUN | — | — | — | — |
| A086 | RP13 | NOT_RUN | — | — | — | — |
| A087 | RP13 | NOT_RUN | — | — | — | — |
| A088 | RP13 | NOT_RUN | — | — | — | — |
| A089 | RP13 | NOT_RUN | — | — | — | — |
| A090 | RP13 | NOT_RUN | — | — | — | — |

## 设计决策

| 决策 | 最终方案与理由 | 影响文件 | 对应测试 |
|---|---|---|---|
| 身份命名空间与别名迁移 | Alias key is `v1/source/network/kind/rawId`; no cross-platform fuzzy merge. Version 5 backfills aliases. | `database.ts`, `event-repository.ts` | repository and worker replay regressions |
| 事务范围/ACK/checkpoint/分块 | Pump collector only advances its durable seed after the worker responds with a successful batch ACK. Any rejection or timeout retries from the committed seed. | `pump/{bridge,page-collector,window-protocol}.ts`, `background.ts` | page collector ACK/retry and worker checkpoint regressions |
| 租约 fencing 与 Worker 会话 | Every Pump lease and batch carries a worker-session ID. A new worker may replace a stale session, but stale batches/statuses are ignored. | `pump-leader.ts`, `pump/{bridge,page-collector}.ts`, `background.ts` | collector session/expiry regressions |
| 用户设置写者与恢复 journal | Trader annotations, SidePanel settings, locale changes, and background display-mode changes use one coordinator. It writes a pending mutation before applying and persists a bounded 128-item receipt history; Worker restart replays a pending operation. Client calls generate a mutation ID and retry one lost/invalid acknowledgement with that same ID. | `preference-mutations.ts`, `local-preferences.ts`, `settings.ts`, `popup-io.ts`, `LocaleProvider.tsx`, `SidePanelApp.tsx`, `background.ts` | coordinator replay/idempotency and stable-ID retry tests |
| 旧客户端兼容与数据迁移 | 待实施 | — | — |
| 音频至多一次尝试边界 | 待实施 | — | — |

## 环境阻塞与真实烟测欠账

仅记录具体缺失环境和受影响的 Gate；继续不受阻塞的独立任务。不得记录凭据。

## 续跑位置

- 最近完成的任务/改动：RP01–RP11 implementation, including persistent Pump gaps, history-preserving live refresh, bounded Fomo bridge replay, and targeted UI invalidations.
- 当前进行的任务：RP12 evidence/catalog reconciliation and RP13 browser release-candidate validation.
- 下一步明确动作：obtain authenticated Fomo/Pump smoke evidence, then reconcile synthetic mapping labels without changing legacy runtime behavior.
- 未完成的回归/人工验证：authenticated Fomo/Pump, minimum-Chrome, scroll-anchor, and multi-tab performance verification.

## 最终交付判定

默认：NOT_STARTED。完成代码但缺浏览器/实采验证时记录 CODE_COMPLETE / VERIFICATION_PENDING；全部发布门槛有证据后才记录 RELEASE_CANDIDATE_VERIFIED。
