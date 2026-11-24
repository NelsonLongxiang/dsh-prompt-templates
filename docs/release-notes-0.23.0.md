# v0.23.0

> 中英双语发布说明。提示词插件独立发布；跨仓角色修复与实际部署状态另行跟踪。

## 中文

- **工坊卡无工具时不再制造无法闭合的轮次**（#78、#80）：只有会话实际工具作用域确认 `lesson_write` 与 `lesson_none` 都不可见，才将该卡片轮记为“不适用”。卡片本体仍照常注入；面板与时间线显示不适用数量和原因。任一工具可见、作用域无法读取、工具服务缺失或读取异常，都保持原有轮次要求，不凭角色名称豁免。两个会话即使轮次键相同，也不会相互关闭卡片轮。
- **证据就绪提醒第一阶段**（#81、#82，默认关闭）：已认可的上游插件可以交来指定会话的工单、版本、证据引用和待判断动作，在下一次可行动的步骤提示；不等固定轮数。相同会话/工单/版本重复提交不重置状态；版本替换按插入顺序，不依赖毫秒时间。
- **交付状态如实表达**：只有本进程见到消息追加、且等待宿主 `sessions.flush` 成功后才标记 persisted；跨进程无法证明或持久化检查失败时标为 unknown，不自动重发。未追加的本进程尝试有界重给，久候会过期。persisted 不代表模型已读、已判断或已执行。
- **测试加固**（#76、#77、#79、#80）：七个会话自省工具的清单与参数契约、旧宿主 `na` 兼容、中英统计文案、跨会话隔离及测试临时目录清理均有回归。

### 范围与验证边界

- 证据就绪能力仍跟随 `cast.enabled`，默认关闭，未自动接入真实 A2A 上游，也未开放新的调用方。#81 的跨仓试点不因本版发布而自动完成。
- 本包不修改 A2A 的角色白名单或预设。#83 所需的组队顾问技能入口由 A2A 维护候选另行修复；提示词插件发布不代表该预设已升级、真实会话已获得工具或历史卡片已闭合。
- 本仓发布门禁 319/319 通过；0.23.0 固定包在隔离宿主验证了到点注入、真实工具闭合和重启后续接，并取得独立运维复验。测试使用零网络脚本适配器，不冒充真实语言模型遵循行为。真实 LLM、A2A 角色部署与跨仓完整验收仍为 NOT_RUN 或待完成，本版不据此关闭 #83。

## English

- **Do not open an impossible workshop round** (#78, #80): a round is recorded as not applicable only when the session’s actual scope confirms that both `lesson_write` and `lesson_none` are unavailable. The card itself is still injected, and the panel and timeline expose the count and reason. Either tool being visible, an unreadable scope, a missing service or a read fault preserves the normal round requirement. Equal round keys in different sessions do not close each other’s rounds.
- **First-stage evidence-ready reminders** (#81, #82, off by default): a recognized upstream plugin can hand in a session-scoped ticket, version, evidence reference and next decision. The reminder appears at the next actionable step, not after a fixed number of turns. Duplicate session/ticket/version submissions reset nothing; version replacement follows insertion order rather than wall-clock milliseconds.
- **Honest delivery states**: persisted requires an append observed in this process followed by a successful awaited host `sessions.flush`. Unprovable cross-process delivery or a failing durability check becomes unknown and is not automatically resent. Attempts prepared here but never appended have bounded retries; stale queued references expire. Persisted does not mean read, judged or acted upon.
- **Regression hardening** (#76, #77, #79, #80): the seven self-tool names and parameter contracts, old-host `na` compatibility, bilingual counts, session isolation and test scratch cleanup are pinned.

### Scope and validation limits

The evidence-ready seam follows `cast.enabled`, remains off by default, adds no caller and does not wire a real A2A upstream. The cross-repository pilot in #81 remains separate. This package does not change A2A role allowlists or presets; publishing it does not deploy the builder skill fix in #83 or close historical rounds. Scripted-adapter host checks establish mechanism behavior only, not real-model compliance. The package release gate passed 319/319; the fixed 0.23.0 package passed isolated host mechanism checks and an independent operations recheck. Real-model behavior, A2A role deployment and cross-repository acceptance remain unexecuted or pending; #83 stays open.
