# v0.15.0（2026-11-18）

> 发布说明中英双语；本文同文进入 GitHub Release。

## 中文

### 面向使用者

- **事件提醒总开关面板化**：⚙ 下拉中的总开关从只读变为**可切换**——勾选即启用、取消即停用，**即时生效、无需重启宿主**。部署配置 `eventInject.enabled` 的值仅在首次读取时作为种子（默认仍为关，隐私默认不变）；此后数据库中的开关状态由面板持有。
- **Atelier 演化自评估默认模板**：每个会话在首次获准的非空 pre-step 时自动补充一条可见会话模板「工坊·演化自评估」，默认每 100 用户轮次触发一次检查点。**不是强制晋升、不是训练模型、不执行迁移、不授予新权限**——仅提示模型按 agent-atelier 方法论执行一次自评估（允许 no-change / unknown）。
- **演化模板尊重用户意图**：同名模板（含关闭的）优先保留不覆盖；创建后编辑、改名、禁用、删除均不被升级改写或自动复活（删除后的登记相当于持久 tombstone）；后加同名全局模板时自动项停止注入避免双份。

### 面向贡献者

- **schema v5→v7**：v6 新增 `event_master` 单行表（面板持有的总开关）和 `evolution_defaults` 登记表（会话→模板映射＋tombstone），v7 合并两条迁移路径为统一版本链。CLI `SUPPORTED_DB_VERSIONS` 扩为 [4,5,6,7]。
- **`PATCH /event-policies/master`** 新路由：面板切换总开关的写入面。观察器和 pre-step 消费者改从存储标志门控，即时生效。
- 演化登记幂等（`BEGIN IMMEDIATE` + 会话主键并发安全）；构造/迁移失败关闭自身连接句柄。
- 195 项测试全绿（含 40 项离线发布回归、真实宿主全生命周期验证——登记/持久注入/编辑/禁用/删除/tombstone、真实模型执行评估＋技能加载成功）。

## English

### For users

- **Panel-owned event master switch**: the ⚙ dropdown master switch is now **toggleable** — tick to enable, untick to disable, **effective immediately without a host restart**. The deployment `eventInject.enabled` value only seeds it on first read (privacy default stays off); the stored flag belongs to the panel afterwards.
- **Atelier evolution self-assessment default template**: each session automatically gets one visible template「工坊·演化自评估」on its first admitted non-empty pre-step, scheduled every 100 user turns as a checkpoint. **Not forced promotion, not model training, not migration, no new permissions** — it just prompts the model to run a self-assessment per the agent-atelier methodology (no-change / unknown allowed).
- **User intent preserved**: same-name templates (including disabled) take priority and are never overwritten; edits, renames, disables and deletions survive upgrades (deletion leaves a durable tombstone preventing resurrection); a later same-name global suppresses the auto item to avoid duplicates.

### For contributors

- **Schema v5→v7**: v6 adds `event_master` (panel-owned switch row) and `evolution_defaults` (session enrollment + tombstones); v7 combines both migrations into one version chain. CLI `SUPPORTED_DB_VERSIONS` extended to [4,5,6,7].
- **`PATCH /event-policies/master`** new route: the write face for the panel toggle. Observer and pre-step consumer gate from the stored flag with instant effect.
- Evolution enrollment is idempotent (`BEGIN IMMEDIATE` + session primary key concurrency-safe); constructor/migration failures close their own database handle.
- 195 tests green (including 40 offline release regressions and real-host full lifecycle verification — enrollment / durable injection / edit / disable / delete / tombstone, real model executing the assessment with successful skill loading).